/* Phase 3 SPA — bulletproof browser data layer (§4) + hash router + delta DOM.
 *
 * Talks to the Phase 1 endpoints only: /api/meta once (static, cached), then
 * /api/frame on a timer. Translatable chrome strings come from window.T (defined
 * + {#TOKEN}-translated in app.html, since the build only runs i18n on .html).
 *
 * Frame schema v1 (must match RestApi::getFrame):
 *   g  = [rssi, heap_free, uptime, Te, flags]   flags: b1=mqtt b2=ota b3=adaptive
 *   iv[k] = [status, pl_read, alarm_cnt, rssi, age, 13x AC, 7x DC per channel...]
 *           maps positionally to meta.iv[k].
 */
(function () {
  "use strict";
  var T = window.T || {};
  function t(k, d) { return T[k] || d; }

  // ---- frame layout constants (mirror acList / dcList order) ----
  var AC_OFF = 5, AC_LEN = 13, DC_OFF = 18, DC_LEN = 7;
  var AC_PAC = 2, AC_YD = 7;   // index within AC block
  var DC_PDC = 2;              // index within a DC block

  // ---- bulletproofing knobs (§4) ----
  var BASE_MS = 5000;          // healthy poll interval
  var BACKOFF = [5000, 15000, 30000]; // widen on consecutive failures
  var IDLE_MS = 30000;         // slow poll when everything is offline (night proxy)
  var REQ_TIMEOUT = 8000;

  var meta = null;             // static, fetched once
  var frame = null;            // last good frame
  var sys = null;              // last /api/system (on-demand, system view only)
  var sysInFlight = false;
  var gridInfo = null;         // grid_info.json decode table (fetched once, cached)
  var cfg = null;              // /api/setup (settings view, on-demand, cached)
  var ivl = null;              // /api/inverter/list (settings view, cached)
  var setupInFlight = false;
  var fails = 0;
  var inFlight = false;
  var timer = null;
  var route = "now";
  var built = false;           // dashboard cards built for current meta?
  var nodes = { iv: [] };      // cached DOM refs for delta updates
  var expanded = -1;           // index of inverter card whose detail is open (-1 = none)
  var auth = { protected: false, unlocked: true }; // global lock (§14), from /api/auth
  var token = "";              // API token for protected control POSTs (sessionStorage)
  try { token = sessionStorage.getItem("ahoyTok") || ""; } catch (e) {}

  function $(sel, root) { return (root || document).querySelector(sel); }
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function fmt(n, d) {
    if (n == null || isNaN(n)) return "–";
    return Number(n).toFixed(d == null ? 1 : d);
  }
  function dur(s) {
    s = s | 0;
    var d = (s / 86400) | 0, h = ((s % 86400) / 3600) | 0, m = ((s % 3600) / 60) | 0;
    if (d) return d + "d " + h + "h";
    if (h) return h + "h " + m + "m";
    return m + "m";
  }

  // ---- theme (self-contained, persisted) ----
  function applyTheme(th) {
    document.documentElement.setAttribute("data-theme", th);
    try { localStorage.setItem("ahoyTheme", th); } catch (e) {}
    var b = $("#themeBtn"); if (b) b.textContent = th === "dark" ? "☀" : "☾";
  }
  function initTheme() {
    var th;
    try { th = localStorage.getItem("ahoyTheme"); } catch (e) {}
    if (!th) th = (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
    applyTheme(th);
  }

  // ---- network: single in-flight, timeout, backoff (§4.1, §4.3) ----
  function getJSON(url, cb) {
    var ctrl = new AbortController();
    var to = setTimeout(function () { ctrl.abort(); }, REQ_TIMEOUT);
    fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } })
      .then(function (r) {
        clearTimeout(to);
        if (!r.ok) { cb(new Error("HTTP " + r.status), null, r.status); return; }
        return r.json().then(function (j) { cb(null, j); });
      })
      .catch(function (e) { clearTimeout(to); cb(e, null); });
  }

  function postJSON(url, body, cb) {
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); })
      .then(function (j) { cb(null, j); })
      .catch(function (e) { cb(e); });
  }

  // transient feedback toast (control results / errors)
  function toast(msg, bad) {
    var t0 = $("#toast");
    if (!t0) {
      t0 = el("div"); t0.id = "toast"; document.body.appendChild(t0);
    }
    t0.textContent = msg;
    t0.className = "show" + (bad ? " bad" : "");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t0.className = ""; }, 2500);
  }

  function canControl() { return !auth.protected || auth.unlocked; }

  function loadAuth(cb) {
    getJSON("api/auth", function (err, j) {
      if (!err && j) {
        auth.protected = !!j.protected;
        auth.unlocked = !j.protected || !!j.unlocked;
      }
      cb && cb();
    });
  }

  // unlock the global lock: POST {auth:pwd} → token (§14.2). On success the server also
  // recognises this IP, so same-origin reads keep working; we hold the token for POSTs.
  function doUnlock(pwd) {
    postJSON("api/ctrl", { auth: pwd }, function (err, j) {
      if (err || !j || j.error || !j.token) { toast(t("locked", "Locked"), true); return; }
      token = j.token;
      try { sessionStorage.setItem("ahoyTok", token); } catch (e) {}
      auth.unlocked = true;
      built = false;
      render();
      toast("OK");
    });
  }

  function doLogout() {
    token = "";
    try { sessionStorage.removeItem("ahoyTok"); } catch (e) {}
    auth.unlocked = !auth.protected;
    built = false;
    render();
  }

  // send a control command for inverter index i (adds id + token); §14 server enforces.
  function sendCtrl(i, body) {
    body.id = (meta && meta.iv[i]) ? meta.iv[i].id : i;
    if (token) body.token = token;
    postJSON("api/ctrl", body, function (err, j) {
      if (err) { toast(t("err", "Error"), true); return; }
      if (j && j.success === false) {
        toast(j.error || t("err", "Error"), true);
        if (j.error && /AUTH|PROT/i.test(j.error)) { auth.unlocked = false; built = false; render(); }
        return;
      }
      toast("OK");
    });
  }

  var acMap = {}, dcMap = {};  // field name -> index within the AC/DC block (built from meta)
  function buildFieldMaps() {
    acMap = {}; dcMap = {};
    var i;
    if (meta && meta.f_ac) for (i = 0; i < meta.f_ac.length; i++) acMap[meta.f_ac[i]] = i;
    if (meta && meta.f_dc) for (i = 0; i < meta.f_dc.length; i++) dcMap[meta.f_dc[i]] = i;
  }
  // value of a named AC field from a flat inverter frame array (null if absent)
  function acByName(a, name) {
    var idx = acMap[name];
    return (idx == null) ? null : a[AC_OFF + idx];
  }
  function dcByName(a, ch, name) {
    var idx = dcMap[name];
    return (idx == null) ? null : a[DC_OFF + ch * DC_LEN + idx];
  }

  function loadMeta(cb) {
    getJSON("api/meta", function (err, j) {
      if (err || !j) { cb && cb(err || new Error("no meta")); return; }
      meta = j;
      buildFieldMaps();
      built = false;
      cb && cb(null);
    });
  }

  // On-demand: full diagnostics for the system view. Slow-changing counters, so
  // fetched when the user lands on #/system (not in the steady-state loop). Single
  // in-flight; on error keep the last good copy. Live values (rssi/heap/uptime/Te)
  // still come from /api/frame and update continuously.
  function loadSystem() {
    if (sysInFlight) return;
    sysInFlight = true;
    getJSON("api/system", function (err, j) {
      sysInFlight = false;
      if (err || !j) return;     // keep last good sys
      sys = j;
      if (route === "system") renderSystem($("#view"));
    });
  }

  function pollFrame() {
    if (inFlight) return;                 // §4.1 no stacking
    if (document.hidden) return;          // §4.4 paused
    inFlight = true;
    getJSON("api/frame", function (err, j, status) {
      inFlight = false;
      if (err || !j || status === 503) {
        fails++;
        markStale();
        schedule();
        setLiveDot();
        return;
      }
      fails = 0;
      frame = j;
      render();
      schedule();
    });
  }

  // adaptive interval: backoff on failure, slow when idle/night, else base
  function nextInterval() {
    if (fails > 0) return BACKOFF[Math.min(fails - 1, BACKOFF.length - 1)];
    if (frame && allOffline()) return IDLE_MS;
    return BASE_MS;
  }
  function allOffline() {
    if (!frame || !frame.iv) return false;
    for (var i = 0; i < frame.iv.length; i++) {
      var en = meta && meta.iv[i] ? meta.iv[i].enabled : true;
      if (en && frame.iv[i][0] != 0) return false; // 0 = OFF
    }
    return true;
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    if (document.hidden) return;
    timer = setTimeout(pollFrame, nextInterval());
  }

  // ---- derived helpers ----
  function acVal(a, idx) { return a[AC_OFF + idx]; }
  function dcChannels(a) { return Math.max(0, ((a.length - DC_OFF) / DC_LEN) | 0); }
  function dcVal(a, ch, idx) { return a[DC_OFF + ch * DC_LEN + idx]; }
  function totalAC() {
    var s = 0;
    if (!frame || !frame.iv) return 0;
    for (var i = 0; i < frame.iv.length; i++) s += acVal(frame.iv[i], AC_PAC) || 0;
    return s;
  }
  function totalYield() {
    var s = 0;
    if (!frame || !frame.iv) return 0;
    for (var i = 0; i < frame.iv.length; i++) s += acVal(frame.iv[i], AC_YD) || 0;
    return s;
  }
  // installed AC capacity (sum of enabled inverter max_pwr, W) — denominator for the gauge
  function totalCap() {
    var s = 0;
    if (!meta || !meta.iv) return 0;
    for (var i = 0; i < meta.iv.length; i++)
      if (meta.iv[i].enabled !== false) s += meta.iv[i].max_pwr || 0;
    return s;
  }
  function producingCount() {
    var n = 0;
    if (!frame || !frame.iv) return 0;
    for (var i = 0; i < frame.iv.length; i++) if (frame.iv[i][0] == 2) n++;
    return n;
  }
  function clampPct(p) { return Math.max(0, Math.min(100, p)); }
  function statusClass(i) {
    var en = meta && meta.iv[i] ? meta.iv[i].enabled : true;
    if (!en) return "s-dis";
    var st = frame.iv[i][0];
    if (st == 2) return "s-ok";      // PRODUCING
    if (st == 0) return "s-off";     // OFF
    return "s-idle";                  // starting / was producing / was on
  }

  // ---- routing ----
  function setRoute() {
    var h = (location.hash || "#/now").replace(/^#\//, "");
    route = h.split("?")[0] || "now";
    var navs = document.querySelectorAll("nav a[data-route]");
    for (var i = 0; i < navs.length; i++)
      navs[i].classList.toggle("active", navs[i].getAttribute("data-route") === route);
    built = false; // force rebuild of the view container
    expanded = -1; // collapse any open card detail on navigation
    if (route === "system") loadSystem();
    if (route === "settings") loadSetup();
    if (route === "serial") startSerial(); else stopSerial();
    render();
  }

  // ---- rendering (build once, then delta) ----
  function render() {
    var root = $("#view");
    if (!root) return;
    updateAuthBar();
    if (route === "system") { renderSystem(root); return; }
    if (route === "settings") { renderSettings(root); return; }
    if (route === "serial") { renderSerial(root); return; }
    if (route === "update") { renderUpdate(root); return; }
    renderNow(root);
    setLiveDot();
  }

  // global-lock login banner (§14): shown only when protected and not unlocked. Lives in
  // <main> above #view so it survives view re-renders; UI hiding is cosmetic, server enforces.
  function updateAuthBar() {
    var bar = $("#authBar");
    if (auth.protected && !auth.unlocked) {
      if (!bar) {
        bar = el("div", "authbar"); bar.id = "authBar";
        bar.appendChild(el("span", "lk", "🔒 " + t("locked", "Locked")));
        var inp = el("input"); inp.id = "authPwd"; inp.type = "password";
        inp.placeholder = t("password", "Password");
        inp.addEventListener("keydown", function (e) { if (e.key === "Enter") doUnlock(inp.value); });
        var b = el("button", "primary", t("unlock", "Unlock"));
        b.addEventListener("click", function () { doUnlock(inp.value); });
        bar.appendChild(inp); bar.appendChild(b);
        var main = document.querySelector("main");
        main.insertBefore(bar, main.firstChild);
      }
      bar.style.display = "";
    } else if (bar) {
      bar.style.display = "none";
    }
  }

  function setLiveDot() {
    var d = $("#liveDot");
    if (!d) return;
    d.className = "dot " + (fails > 0 ? "stale" : "live");
  }

  function markStale() {
    var v = $("#view");
    if (v) v.classList.add("stale");
  }

  // ring gauge geometry (SVG): r=52 in a 120 box → circumference for stroke-dash math
  var GA_R = 52, GA_C = 2 * Math.PI * GA_R;

  function buildNow(root) {
    root.innerHTML = "";
    root.classList.remove("stale");
    nodes = { iv: [] };

    // ---- hero: sun-disc gauge (current output vs installed capacity) ----
    var hero = el("div", "hero");
    var gWrap = el("div", "gauge-wrap");
    gWrap.innerHTML =
      '<svg class="gauge" viewBox="0 0 120 120" aria-hidden="true">' +
      '<defs><linearGradient id="sun" x1="0" y1="1" x2="1" y2="0">' +
      '<stop class="s1" offset="0"/><stop class="s2" offset="1"/>' +
      '</linearGradient></defs>' +
      '<circle class="g-track" cx="60" cy="60" r="' + GA_R + '"/>' +
      '<circle class="g-val" cx="60" cy="60" r="' + GA_R + '" ' +
      'stroke-dasharray="' + GA_C.toFixed(1) + '" stroke-dashoffset="' + GA_C.toFixed(1) + '"/>' +
      '</svg>';
    var center = el("div", "gauge-c");
    nodes.heroPwr = el("div", "g-pwr");
    nodes.heroUnit = el("div", "g-unit", "W " + t("rightnow", "now"));
    center.appendChild(nodes.heroPwr); center.appendChild(nodes.heroUnit);
    gWrap.appendChild(center);
    nodes.gaugeVal = gWrap.querySelector(".g-val");
    hero.appendChild(gWrap);

    var stats = el("div", "hero-stats");
    function hstat(label) {
      var d = el("div", "hstat");
      var v = el("div", "hv");
      d.appendChild(v); d.appendChild(el("div", "hk", label));
      stats.appendChild(d);
      return v;
    }
    nodes.heroToday = hstat(t("today", "Today"));
    nodes.heroCap = hstat(t("capacity", "Capacity"));
    nodes.heroProd = hstat(t("producing", "Producing"));
    hero.appendChild(stats);
    root.appendChild(hero);

    if (!meta || !meta.iv || !meta.iv.length) {
      root.appendChild(el("div", "empty", t("noinv", "No inverters configured.")));
      built = true;
      return;
    }

    // ---- inverter cards (quiet: status, name, power, one capacity bar) ----
    var grid = el("div", "grid");
    for (var i = 0; i < meta.iv.length; i++) {
      var m = meta.iv[i];
      var card = el("div", "card");
      var head = el("div", "head");
      var dot = el("span", "dot");
      var name = el("span", "name", m.name || ("#" + m.id));
      var caret = el("span", "caret", "›");
      var pwr = el("span", "pwr");
      head.appendChild(dot); head.appendChild(name); head.appendChild(pwr); head.appendChild(caret);
      card.appendChild(head);
      (function (idx) {
        head.addEventListener("click", function () {
          expanded = (expanded === idx) ? -1 : idx;
          renderNow($("#view"));
        });
      })(i);

      var cap = el("div", "capbar");
      var capFill = el("i");
      cap.appendChild(capFill);
      card.appendChild(cap);

      var info = el("div", "meta-row");
      var ageN = el("span"), rssiN = el("span");
      info.appendChild(ageN); info.appendChild(rssiN);
      card.appendChild(info);

      // detail: ft = curated chips + per-string cards (rebuilt per frame);
      // xtra = controls + info tabs (built once so inputs keep focus/state)
      var detail = el("div", "detail");
      var ft = el("div", "ft");
      detail.appendChild(ft);
      card.appendChild(detail);

      grid.appendChild(card);
      nodes.iv.push({ card: card, head: head, dot: dot, pwr: pwr, capFill: capFill,
                      max: m.max_pwr || 0, age: ageN, rssi: rssiN, detail: detail, ft: ft, xtra: null });
    }
    root.appendChild(grid);
    built = true;
  }

  function renderNow(root) {
    if (!built) buildNow(root);
    if (!frame) return;
    root.classList.remove("stale");

    // hero gauge: fill = current output / installed capacity
    var tot = totalAC(), cap = totalCap();
    var util = cap > 0 ? clampPct((tot / cap) * 100) : 0;
    nodes.heroPwr.textContent = fmt(tot, 0);
    if (nodes.gaugeVal) nodes.gaugeVal.style.strokeDashoffset = (GA_C * (1 - util / 100)).toFixed(1);
    nodes.heroToday.textContent = fmt(totalYield() / 1000, 2) + " kWh";
    nodes.heroCap.textContent = (cap / 1000).toFixed(2) + " kW";
    nodes.heroProd.textContent = producingCount() + " / " + meta.iv.length;

    for (var i = 0; i < nodes.iv.length && i < (frame.iv ? frame.iv.length : 0); i++) {
      var n = nodes.iv[i], a = frame.iv[i];
      n.dot.className = "dot " + statusClass(i);
      n.card.classList.toggle("dis", meta.iv[i] && !meta.iv[i].enabled);
      var p = acVal(a, AC_PAC) || 0;
      n.pwr.textContent = fmt(p, 0) + " W";
      n.capFill.style.width = (n.max > 0 ? clampPct((p / n.max) * 100) : 0) + "%";

      var age = a[4];
      n.age.textContent = t("updated", "updated") + " " + (age | 0) + "s " + t("ago", "ago");
      if (age > 120) n.age.classList.add("stale"); else n.age.classList.remove("stale");
      n.rssi.textContent = "RSSI " + a[3] + "%";

      // detail: ft (chips + strings) rebuilt each frame; xtra (controls + tabs) built once
      var open = expanded === i;
      n.card.classList.toggle("open", open);
      if (open) {
        n.ft.innerHTML = detailHtml(i, a);
        if (!n.xtra) buildDetailExtras(n, i);
      } else if (n.xtra || n.ft.firstChild) {
        n.ft.textContent = "";
        if (n.xtra) { n.detail.removeChild(n.xtra); n.xtra = null; }
      }
    }
  }

  // built-once extras under the live field table: controls (when unlocked) + on-demand
  // Info / Alarms / Radio tabs. Kept separate from ft so it isn't wiped on each frame.
  function buildDetailExtras(n, i) {
    var box = el("div", "xtra");
    if (canControl()) box.appendChild(buildControls(i));

    var tabs = el("div", "tabs");
    var panel = el("div", "panel");
    var defs = [["info", t("info", "Info")], ["alarms", t("alarms", "Alarms")],
                ["radio", t("radiostat", "Radio stats")], ["grid", t("gridprofile", "Grid profile")]];
    defs.forEach(function (d) {
      var b = el("button", "tab", d[1]);
      b.addEventListener("click", function () {
        var bs = tabs.querySelectorAll(".tab");
        for (var k = 0; k < bs.length; k++) bs[k].classList.remove("active");
        b.classList.add("active");
        loadInfoTab(i, d[0], panel);
      });
      tabs.appendChild(b);
    });
    box.appendChild(tabs);
    box.appendChild(panel);
    n.detail.appendChild(box);
    n.xtra = box;
  }

  function buildControls(i) {
    var c = el("div", "controls");
    function btn(label, cls, cb) { var b = el("button", cls, label); b.addEventListener("click", cb); return b; }

    var row = el("div", "btn-row");
    row.appendChild(btn(t("on", "On"), "ok", function () { sendCtrl(i, { cmd: "power", val: 1 }); }));
    row.appendChild(btn(t("offbtn", "Off"), "warn", function () { sendCtrl(i, { cmd: "power", val: 0 }); }));
    row.appendChild(btn(t("restart", "Restart"), "", function () {
      if (confirm(t("restart", "Restart") + "?")) sendCtrl(i, { cmd: "restart" });
    }));
    c.appendChild(row);

    var lim = el("div", "limit");
    var inp = el("input"); inp.type = "number"; inp.min = "0"; inp.step = "any";
    inp.placeholder = t("limit", "Power limit");
    var abs = { v: false };
    var unit = btn("%", "unit", function () { abs.v = !abs.v; unit.textContent = abs.v ? "W" : "%"; });
    var pl = el("label", "chk");
    var cb = el("input"); cb.type = "checkbox";
    pl.appendChild(cb); pl.appendChild(document.createTextNode(" " + t("persistent", "persistent")));
    var setb = btn(t("set", "Set"), "primary", function () {
      var v = parseFloat(inp.value);
      if (isNaN(v)) { toast(t("err", "Error"), true); return; }
      var cmd = "limit_" + (cb.checked ? "persistent" : "nonpersistent") + "_" + (abs.v ? "absolute" : "relative");
      sendCtrl(i, { cmd: cmd, val: v });
    });
    lim.appendChild(inp); lim.appendChild(unit); lim.appendChild(pl); lim.appendChild(setb);
    c.appendChild(lim);
    return c;
  }

  // on-demand per-inverter info (firmware version / alarms / radio statistics / grid profile)
  function loadInfoTab(i, kind, panel) {
    panel.textContent = "…";
    if (kind === "grid") { loadGrid(i, panel); return; }
    var id = meta.iv[i].id;
    var url = kind === "info" ? "api/inverter/version/" + id
            : kind === "alarms" ? "api/inverter/alarm/" + id
            : "api/inverter/radiostat/" + id;
    getJSON(url, function (err, j) {
      if (err || !j) { panel.textContent = t("waiting", "Waiting for data…"); return; }
      if (kind === "alarms") renderAlarms(panel, j);
      else renderKV(panel, j);
    });
  }

  // grid profile: the endpoint returns the raw profile as a hex byte string; decode it
  // against grid_info.json (fetched once, cached) — the same scheme the legacy page used.
  function loadGrid(i, panel) {
    var id = meta.iv[i].id;
    function go() {
      getJSON("api/inverter/grid/" + id, function (err, j) {
        if (err || !j) { panel.textContent = t("waiting", "Waiting for data…"); return; }
        renderGrid(panel, j);
      });
    }
    if (gridInfo) { go(); return; }
    getJSON("grid_info.json", function (err, j) { if (!err && j) gridInfo = j; go(); });
  }

  function renderGrid(panel, obj) {
    var grid = obj.grid || "";
    if (!grid.length) { panel.innerHTML = '<div class="empty">' + esc(t("notread", "Profile not read yet")) + "</div>"; return; }
    if (!gridInfo) { panel.textContent = "…"; return; }

    var g = { offs: 0 };
    function val() {
      var v = parseInt(grid.substring(g.offs * 3, g.offs * 3 + 2), 16) * 256 +
              parseInt(grid.substring(g.offs * 3 + 3, g.offs * 3 + 5), 16);
      g.offs += 2; return v;
    }
    function ident() { return "0x" + val().toString(16).padStart(4, "0"); }
    function lookup(arr, id) {
      for (var k = 0; arr && k < arr.length; k++) if (arr[k][id] !== undefined) return arr[k][id];
      return null;
    }

    var typeId = ident();
    var name = lookup(gridInfo.type, typeId);
    var ver = val();
    if (name === null) { panel.innerHTML = '<div class="empty">' + esc(t("unknownprofile", "Unknown profile")) + "</div>"; return; }

    var h = '<div class="grid-h">' + esc(name) + " (v" +
            Math.round(ver / 0x1000) + "." + Math.round((ver & 0x0ff0) / 0x10) + "." + (ver & 0x0f) + ")</div>";
    while (g.offs * 3 < grid.length) {
      var id = ident();
      var grp = lookup(gridInfo.grp_codes, id.substring(0, 4));
      var params = lookup(gridInfo.group, id);
      h += '<div class="eyebrow">' + esc(grp || id) + "</div>";
      if (Array.isArray(params)) {
        h += '<table class="det">';
        for (var p = 0; p < params.length; p++) {
          var e = params[p];
          var v = val() / e.div;
          var diff = String(v) !== String(e.def);
          var unit = (e.unit !== undefined) ? " " + e.unit : "";
          h += "<tr><td>" + esc(e.name) + "</td><td" + (diff ? ' class="hl"' : "") + ">" + esc(v + unit) + "</td></tr>";
        }
        h += "</table>";
      }
    }
    panel.innerHTML = h;
  }

  function renderKV(panel, obj) {
    var h = "<table class=det>", k, v;
    for (k in obj) {
      if (!obj.hasOwnProperty(k)) continue;
      v = obj[k];
      if (v == null || typeof v === "object" || k === "name" || k === "iv_name") continue;
      h += "<tr><td>" + esc(k) + "</td><td>" + esc(v) + "</td></tr>";
    }
    panel.innerHTML = h + "</table>";
  }

  function renderAlarms(panel, j) {
    var a = j.alarm || [], rows = "", i;
    for (i = 0; i < a.length; i++) {
      if (!a[i] || !a[i].start) continue;
      rows += "<tr><td>" + esc(a[i].code) + "</td><td>" + esc(a[i].str || "") + "</td></tr>";
    }
    panel.innerHTML = rows ? "<table class=det>" + rows + "</table>"
                           : "<div class=empty>" + esc(t("noalarms", "No alarms")) + "</div>";
  }

  // curated AC stats (a few that matter) + per-string cards — not a field dump.
  function detailHtml(i, a) {
    var m = meta.iv[i];

    // chips: only meaningful, glanceable AC metrics; clean units (meta units are mojibaked)
    var chips = [
      [t("voltage", "Voltage"), acByName(a, "U_AC"), "V", 1],
      [t("freq", "Frequency"), acByName(a, "F_AC"), "Hz", 2],
      [t("temp", "Temp"), acByName(a, "Temp"), "°C", 1],
      [t("eff", "Efficiency"), acByName(a, "Efficiency"), "%", 1],
      ["cos φ", acByName(a, "PF_AC"), "", 2]
    ];
    var h = '<div class="chips">';
    for (var k = 0; k < chips.length; k++) {
      var v = chips[k][1];
      if (v == null) continue;
      h += '<div class="chip"><div class="cv">' + fmt(v, chips[k][3]) +
           '<span>' + esc(chips[k][2]) + '</span></div><div class="ck">' + esc(chips[k][0]) + '</div></div>';
    }
    h += '</div>';

    // per-string cards: power (big) + bar vs string capacity + V·A·today
    var nCh = dcChannels(a);
    if (nCh > 0) {
      h += '<div class="eyebrow">' + esc(t("strings", "Strings")) + '</div><div class="strs">';
      for (var c = 0; c < nCh; c++) {
        var name = (m.ch_names && m.ch_names[c + 1]) || ("CH" + (c + 1));
        var pw = dcByName(a, c, "P_DC") || 0;
        var cmax = (m.ch_max_pwr && m.ch_max_pwr[c + 1]) || 0;
        var pct = cmax > 0 ? clampPct((pw / cmax) * 100) : 0;
        var uv = dcByName(a, c, "U_DC"), iv = dcByName(a, c, "I_DC"), yd = dcByName(a, c, "YieldDay");
        h += '<div class="str">' +
               '<div class="str-h"><span class="str-n">' + esc(name) + '</span>' +
               '<span class="str-p">' + fmt(pw, 0) + ' W</span></div>' +
               '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
               '<div class="str-sub">' +
                 (uv != null ? fmt(uv, 1) + ' V' : '') +
                 (iv != null ? ' · ' + fmt(iv, 2) + ' A' : '') +
                 (yd != null ? ' · ' + fmt(yd, 0) + ' Wh' : '') +
               '</div></div>';
      }
      h += '</div>';
    }
    return h;
  }

  function esc(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;";
    });
  }

  function renderSystem(root) {
    root.innerHTML = "";
    root.classList.remove("stale");

    // a labelled section of stat tiles; rows = [label, value] (value null/undefined skipped)
    function section(title, rows) {
      var have = false, i;
      for (i = 0; i < rows.length; i++) if (rows[i][1] != null && rows[i][1] !== "") have = true;
      if (!have) return;
      root.appendChild(el("h2", "sec-h", title));
      var tiles = el("div", "tiles");
      for (i = 0; i < rows.length; i++) {
        if (rows[i][1] == null || rows[i][1] === "") continue;
        var d = el("div", "tile");
        d.appendChild(el("div", "k", rows[i][0]));
        d.appendChild(el("div", "v", rows[i][1]));
        tiles.appendChild(d);
      }
      root.appendChild(tiles);
    }

    // ---- Live (from the steady-state frame, keeps updating) ----
    var g = frame ? frame.g : null;
    if (g) {
      var flags = g[4] | 0;
      section(t("live", "Live"), [
        ["WiFi RSSI", g[0] + " dBm"],
        [t("heap", "Free heap"), (g[1] / 1024).toFixed(1) + " KB"],
        [t("uptime", "Uptime"), dur(g[2])],
        [t("rfcadence", "RF cadence"), g[3] + " s"],
        ["MQTT", (flags & 0x02) ? t("connected", "connected") : t("disconnected", "disconnected")],
        [t("adaptive", "Adaptive RF"), (flags & 0x08) ? "on" : t("off", "off")],
        ["OTA", (flags & 0x04) ? "active" : null]
      ]);
    } else {
      root.appendChild(el("div", "empty", t("waiting", "Waiting for data…")));
    }

    // ---- On-demand diagnostics (from /api/system) ----
    if (sys) {
      var n = sys.network || {}, nd = sys.net_diag || {}, r = sys.radioNrf || {},
          mem = sys.memory || {}, mq = sys.mqtt || {};
      section(t("network", "Network"), [
        ["IP", n.ip], ["MAC", n.mac], ["SSID", n.ssid],
        ["WiFi ch", n.wifi_channel]
      ]);
      section(t("diag", "Diagnostics"), [
        [t("reboots", "Boot count"), nd.boot_cnt],
        [t("reconnects", "WiFi reconnects"), nd.wifi_reconn_total],
        [t("deadlinks", "Dead links"), nd.dead_link_cnt],
        [t("offreboots", "Offline reboots"), nd.offline_reboots],
        [t("lastoffline", "Last offline"), nd.last_offline_dur != null ? dur(nd.last_offline_dur) : null],
        [t("discreason", "Disconnect reason"), nd.last_disc_reason],
        [t("resetreason", "Reset reason"), nd.last_reset_reason]
      ]);
      section(t("radio", "Radio"), [
        ["NRF24", r.isconnected != null ? (r.isconnected ? t("connected", "connected") : t("disconnected", "disconnected")) : null],
        ["Data rate", r.dataRate],
        ["DTU SN", r.sn]
      ]);
      section("MQTT", [
        ["TX", mq.tx_cnt], ["RX", mq.rx_cnt],
        ["Interval", mq.interval ? mq.interval + " s" : null]
      ]);
      function kb(x) { return x != null ? (x / 1024).toFixed(1) + " KB" : null; }
      section(t("memory", "Memory"), [
        [t("heap", "Free heap"), kb(mem.heap_free)],
        [t("frag", "Heap frag"), mem.heap_frag != null ? mem.heap_frag + " %" : null],
        ["Max free blk", kb(mem.heap_max_free_blk)],
        ["Free min", kb(mem.heap_free_min)],
        ["Min blk", kb(mem.heap_blk_min)],
        ["Frag max", mem.heap_frag_max != null ? mem.heap_frag_max + " %" : null],
        [t("flash", "Flash used"), mem.par_used_app0 != null ? (mem.par_used_app0 / 1024).toFixed(0) + " KB" : null]
      ]);
    }

    // device actions (reuse the legacy /reboot route — same mechanism as system.html)
    var actions = el("div", "actions");
    var reb = el("button", "warn", t("reboot", "Reboot DTU"));
    reb.addEventListener("click", function () {
      if (confirm(t("reboot", "Reboot DTU") + "?")) location.href = "/reboot";
    });
    actions.appendChild(reb);
    if (auth.protected && auth.unlocked) {
      var lo = el("button", "", t("logout", "Logout"));
      lo.addEventListener("click", doLogout);
      actions.appendChild(lo);
    }
    root.appendChild(actions);

    if (meta) {
      var f = el("div", "meta-row");
      f.appendChild(el("span", null, meta.host + " · " + meta.version + " (" + meta.build + ")"));
      f.appendChild(el("span", null, meta.esp_type));
      root.appendChild(f);
    }
  }

  // ============================================================================
  // Slice 4c — native settings (config) view. Faithful port of setup.html for the
  // shipped esp8266 env (NRF24 only; no CMT/ethernet/display). SAFETY: the form
  // carries EXACTLY the same input names the legacy /save handler reads and POSTs
  // urlencoded to /save — byte-identical to the legacy submission, so the server
  // can't tell the difference (any missing field would clobber pins to 0). Values
  // are populated from /api/setup + /api/inverter/list. Inverters use the same
  // save_iv JSON to /api/setup as the legacy modal.
  // ============================================================================
  var ESP8266_PINS = [
    [255, "off"], [0, "D3 (GPIO0)"], [1, "TX (GPIO1)"], [2, "D4 (GPIO2)"],
    [3, "RX (GPIO3)"], [4, "D2 (GPIO4, SDA)"], [5, "D1 (GPIO5, SCL)"], [6, "GPIO6"],
    [7, "GPIO7"], [8, "GPIO8"], [9, "GPIO9"], [10, "GPIO10"], [11, "GPIO11"],
    [12, "D6 (GPIO12)"], [13, "D7 (GPIO13)"], [14, "D5 (GPIO14)"], [15, "D8 (GPIO15)"],
    [16, "D0 (GPIO16 - no IRQ)"]
  ];
  var NRF_PA = [[0, "MIN"], [1, "LOW"], [2, "HIGH"], [3, "MAX"]];

  function loadSetup() {
    if (setupInFlight) return;
    setupInFlight = true;
    getJSON("api/setup", function (err, j) {
      if (err || !j) { setupInFlight = false; if (route === "settings") renderSettings($("#view")); return; }
      cfg = j;
      getJSON("api/inverter/list", function (e2, l) {
        setupInFlight = false;
        if (!e2 && l) ivl = l;
        if (route === "settings") renderSettings($("#view"));
      });
    });
  }

  // form-control builders (native inputs, delta-free — settings view is rebuilt on entry)
  function field(label, ctrl) {
    var r = el("div", "fld");
    r.appendChild(el("label", "fl", label));
    r.appendChild(ctrl);
    return r;
  }
  function inp(name, val, type) {
    var i = el("input"); i.name = name; i.type = type || "text";
    if (val != null) i.value = val;
    return i;
  }
  function chk(name, on) {
    var i = el("input"); i.type = "checkbox"; i.name = name; i.checked = !!on;
    return i;
  }
  function select(name, opts, sel) {
    var s = el("select"); s.name = name;
    for (var i = 0; i < opts.length; i++) {
      var o = el("option", null, opts[i][1]); o.value = opts[i][0];
      if (String(opts[i][0]) === String(sel)) o.selected = true;
      s.appendChild(o);
    }
    return s;
  }
  // collapsible section wrapped so long forms stay navigable on a phone
  function fsec(form, title, open) {
    var h = el("button", "s-head" + (open ? " open" : "")); h.type = "button";
    h.textContent = title;
    var body = el("div", "s-body"); body.style.display = open ? "" : "none";
    h.addEventListener("click", function () {
      h.classList.toggle("open");
      body.style.display = body.style.display === "none" ? "" : "none";
    });
    form.appendChild(h); form.appendChild(body);
    return body;
  }

  function renderSettings(root) {
    root.innerHTML = "";
    root.classList.remove("stale");
    if (!cfg) { root.appendChild(el("div", "empty", t("waiting", "Waiting for data…"))); return; }

    var sys = cfg.system || {}, net = (sys.network || {}), gen = cfg.generic || {},
        sip = cfg.static_ip || {}, mq = cfg.mqtt || {}, ntp = cfg.ntp || {},
        sun = cfg.sun || {}, pin = cfg.pinout || {}, nrf = cfg.radioNrf || {},
        ser = cfg.serial || {};

    var form = el("form", "settings");
    form.method = "post"; form.action = "/save";
    // legacy submit hook: normalise decimal comma → dot before native POST
    form.addEventListener("submit", function () {
      var ins = form.querySelectorAll("input[type=number]");
      for (var i = 0; i < ins.length; i++)
        if (ins[i].value.indexOf(",") !== -1) ins[i].value = ins[i].value.replace(",", ".");
    });

    // ---- System ----
    var b = fsec(form, t("setSystem", "System"), true);
    b.appendChild(field(t("devname", "Device name"), inp("device", sys.device_name)));
    b.appendChild(field(t("rebootmid", "Reboot at midnight"), chk("schedReboot", sys.sched_reboot)));
    b.appendChild(field(t("darkmode", "Dark mode"), chk("darkMode", sys.dark_mode)));
    var regionOpts = [[0, "Europe (860 - 870 MHz)"], [1, "USA, Indonesia (905 - 925 MHz)"], [2, "Brazil (915 - 928 MHz)"]];
    b.appendChild(field(t("region", "Region"), select("region", regionOpts, gen.region)));
    var tzOpts = [];
    for (var z = 0; z < 24; z += 0.5) tzOpts.push([z, ((z - 12 > 0) ? "+" : "") + String(z - 12)]);
    b.appendChild(field(t("timezone", "Timezone"), select("timezone", tzOpts, (gen.timezone != null ? gen.timezone + 12 : 12))));
    b.appendChild(field(t("custlink", "Custom link"), inp("cstLnk", gen.cst_lnk)));
    b.appendChild(field(t("custlinktxt", "Custom link text"), inp("cstLnkTxt", gen.cst_lnk_txt)));

    // ---- Network ----
    b = fsec(form, t("setNetwork", "Network"));
    b.appendChild(field(t("appwd", "AP password"), inp("ap_pwd", net.ap_pwd)));
    b.appendChild(field("SSID", inp("ssid", net.ssid)));
    b.appendChild(field(t("ssidhidden", "Hide SSID"), chk("hidd", net.hidd)));
    // WiFi password: {PWD} sentinel means "unchanged" server-side — never echo the real one
    b.appendChild(field(t("password", "Password"), inp("pwd", "{PWD}", "password")));
    b.appendChild(el("div", "sub", t("staticip", "Static IP (leave blank for DHCP)")));
    b.appendChild(field("IP", inp("ipAddr", sip.ip)));
    b.appendChild(field(t("submask", "Subnet mask"), inp("ipMask", sip.mask)));
    b.appendChild(field("DNS 1", inp("ipDns1", sip.dns1)));
    b.appendChild(field("DNS 2", inp("ipDns2", sip.dns2)));
    b.appendChild(field("Gateway", inp("ipGateway", sip.gateway)));

    // ---- Protection (global lock) ----
    b = fsec(form, t("setProt", "Protection"));
    // adminpwd: blank when no password set (so saving blank keeps it off), else {PWD} sentinel
    b.appendChild(field(t("adminpwd", "Admin password"), inp("adminpwd", sys.pwd_set ? "{PWD}" : "", "password")));
    var maskNames = ["Index", "Live", "Serial", "Settings", "Update", "System", "History"];
    for (var mI = 0; mI < 7; mI++) {
      var onm = ((sys.prot_mask & (1 << mI)) === (1 << mI));
      b.appendChild(field(t("hide", "Hide") + " " + maskNames[mI], chk("protMask" + mI, onm)));
    }

    // ---- Inverters ----
    b = fsec(form, t("setInv", "Inverters"));
    b.appendChild(buildInvTable());
    var gI = (ivl || {});
    b.appendChild(field(t("interval", "Interval [s]"), inp("invInterval", gI.interval, "number")));
    b.appendChild(field(t("invrstmid", "Reset values at midnight"), chk("invRstMid", gI.rstMid)));
    b.appendChild(field(t("invrstsr", "Reset at sunrise"), chk("invRstComStart", gI.rstComStart)));
    b.appendChild(field(t("invrstss", "Reset at sunset"), chk("invRstComStop", gI.rstComStop)));
    b.appendChild(field(t("invrstna", "Reset when unavailable"), chk("invRstNotAvail", gI.rstNotAvail)));
    b.appendChild(field(t("invrstmax", "Reset max values at midnight"), chk("invRstMaxMid", gI.rstMaxMid)));
    b.appendChild(field(t("strtwot", "Start without time"), chk("strtWthtTm", gI.strtWthtTm)));
    b.appendChild(field(t("rdgrid", "Read grid profile"), chk("rdGrid", gI.rdGrid)));

    // ---- NTP ----
    b = fsec(form, "NTP");
    b.appendChild(field(t("ntpserver", "NTP server / IP"), inp("ntpAddr", ntp.addr)));
    b.appendChild(field(t("ntpport", "NTP port"), inp("ntpPort", ntp.port, "number")));
    b.appendChild(field(t("interval", "Interval [s]"), inp("ntpIntvl", ntp.interval, "number")));
    var ntpAct = el("div", "btn-row");
    var setB = el("button", "", t("ntpsetbrowser", "Set from browser")); setB.type = "button";
    setB.addEventListener("click", function () {
      postJSON("api/setup", { cmd: "set_time", token: token || "*", val: Math.floor(Date.now() / 1000) }, function () { toast("OK"); });
    });
    var syncB = el("button", "", t("ntpsync", "Sync NTP")); syncB.type = "button";
    syncB.addEventListener("click", function () {
      postJSON("api/setup", { cmd: "sync_ntp", token: token || "*" }, function () { toast("OK"); });
    });
    ntpAct.appendChild(setB); ntpAct.appendChild(syncB);
    b.appendChild(ntpAct);

    // ---- Sunrise / Sunset ----
    b = fsec(form, t("setSun", "Sunrise / Sunset"));
    b.appendChild(field(t("latitude", "Latitude"), inp("sunLat", sun.lat, "number")));
    b.appendChild(field(t("longitude", "Longitude"), inp("sunLon", sun.lon, "number")));
    var offOpts = [];
    for (var of = -60; of <= 60; of++) offOpts.push([of, of + " min"]);
    b.appendChild(field(t("offsetsr", "Sunrise offset"), select("sunOffsSr", offOpts, (sun.offsSr != null ? sun.offsSr / 60 : 0))));
    b.appendChild(field(t("offsetss", "Sunset offset"), select("sunOffsSs", offOpts, (sun.offsSs != null ? sun.offsSs / 60 : 0))));

    // ---- MQTT ----
    b = fsec(form, "MQTT");
    b.appendChild(field(t("broker", "Broker / server IP"), inp("mqttAddr", mq.broker)));
    b.appendChild(field("Port", inp("mqttPort", mq.port, "number")));
    b.appendChild(field("Client ID", inp("mqttClientId", mq.clientId)));
    b.appendChild(field(t("user", "User"), inp("mqttUser", mq.user)));
    b.appendChild(field(t("password", "Password"), inp("mqttPwd", mq.pwd, "password")));
    b.appendChild(field("Topic", inp("mqttTopic", mq.topic)));
    b.appendChild(field("JSON", chk("mqttJson", mq.json)));
    b.appendChild(field(t("interval", "Interval [s]"), inp("mqttInterval", mq.interval, "number")));
    b.appendChild(field(t("retain", "Retain"), chk("retain", mq.retain)));
    var discRow = el("div", "btn-row");
    var discB = el("button", "", t("mqttdiscovery", "Send HA discovery")); discB.type = "button";
    discB.addEventListener("click", function () {
      postJSON("api/setup", { cmd: "discovery_cfg", token: token || "*" }, function (err, j) {
        toast((err || !j || !j.success) ? t("err", "Error") : "OK", err || !j || !j.success);
      });
    });
    discRow.appendChild(discB);
    b.appendChild(discRow);

    // ---- Pinout (LEDs + NRF24) ----
    b = fsec(form, t("setPinout", "Pinout"));
    b.appendChild(field("LED 0 (" + t("ledproducing", "producing") + ")", select("pinLed0", ESP8266_PINS, pin.led0)));
    b.appendChild(field("LED 1 (MQTT)", select("pinLed1", ESP8266_PINS, pin.led1)));
    b.appendChild(field("LED 2 (" + t("lednight", "night") + ")", select("pinLed2", ESP8266_PINS, pin.led2)));
    b.appendChild(field(t("ledpolarity", "LED polarity"), select("pinLedHighActive", [[0, t("lowactive", "low active")], [1, t("highactive", "high active")]], pin.led_high_active)));
    b.appendChild(field(t("ledlum", "LED luminance (0-255)"), inp("pinLedLum", pin.led_lum, "number")));
    b.appendChild(el("div", "sub", "NRF24L01+"));
    b.appendChild(field(t("nrfenable", "NRF24 enable"), chk("nrfEnable", nrf.en)));
    b.appendChild(field("CS", select("pinCs", ESP8266_PINS, pin.cs)));
    b.appendChild(field("CE", select("pinCe", ESP8266_PINS, pin.ce)));
    b.appendChild(field("IRQ", select("pinIrq", ESP8266_PINS, pin.irq)));

    // ---- Serial console ----
    b = fsec(form, t("setSerial", "Serial console"));
    b.appendChild(field(t("logprintdata", "Print inverter data"), chk("serEn", ser.show_live_data)));
    b.appendChild(field(t("logdebug", "Serial debug"), chk("serDbg", ser.debug)));
    b.appendChild(field(t("logpriv", "Privacy mode"), chk("priv", ser.priv)));
    b.appendChild(field(t("logtrace", "Print all traces"), chk("wholeTrace", ser.wholeTrace)));
    b.appendChild(field(t("log2mqtt", "Log to MQTT"), chk("log2mqtt", ser.log2mqtt)));

    // ---- Save ----
    var save = el("div", "save-row");
    var rebLbl = el("label", "chk");
    var rebCb = chk("reboot", true);
    rebLbl.appendChild(rebCb); rebLbl.appendChild(document.createTextNode(" " + t("rebootsave", "Reboot after save")));
    save.appendChild(rebLbl);
    var sb = el("button", "primary", t("set", "Save")); sb.type = "submit";
    save.appendChild(sb);
    form.appendChild(save);

    root.appendChild(form);

    // export / import + factory reset (reuse legacy routes verbatim). Import is a real
    // multipart form POST to /upload (identical to legacy setup.html import), so the
    // server-side restore path is unchanged.
    var extra = el("div", "actions");
    var exp = el("a", "btn-link", t("export", "Export settings")); exp.href = "/get_setup"; exp.target = "_blank";
    extra.appendChild(exp);
    var er = el("a", "btn-link warn", t("erase", "Factory reset")); er.href = "/erase";
    extra.appendChild(er);
    root.appendChild(extra);

    var impForm = el("form", "imp");
    impForm.method = "post"; impForm.action = "/upload"; impForm.enctype = "multipart/form-data"; impForm.acceptCharset = "utf-8";
    var impFile = el("input"); impFile.type = "file"; impFile.name = "upload";
    var impBtn = el("button", "btn-link", t("import", "Import settings")); impBtn.type = "submit"; impBtn.disabled = true;
    impFile.addEventListener("change", function () { impBtn.disabled = !impFile.value; });
    impForm.appendChild(impFile); impForm.appendChild(impBtn);
    root.appendChild(impForm);
  }

  // inverter list table + add/edit → modal (save_iv). Read-only preview of configured
  // inverters; edits go through the same /api/setup save_iv the legacy modal used.
  function buildInvTable() {
    var wrap = el("div", "inv-list");
    var invs = (ivl && ivl.inverter) || [];
    for (var i = 0; i < invs.length; i++) {
      (function (iv) {
        var row = el("div", "inv-row");
        var st = el("span", "badge " + (iv.enabled ? "on" : "off"), iv.enabled ? t("enabled", "on") : t("disabled", "off"));
        row.appendChild(st);
        row.appendChild(el("span", "inv-n", iv.name || ("#" + iv.id)));
        row.appendChild(el("span", "inv-s", String(iv.serial)));
        var edit = el("button", "mini"); edit.type = "button"; edit.textContent = "✎";
        edit.addEventListener("click", function () { invModal(iv); });
        row.appendChild(edit);
        wrap.appendChild(row);
      })(invs[i]);
    }
    var maxN = (ivl && ivl.max_num_inverters) || 0;
    if (invs.length < maxN) {
      var add = el("button", "btn-link"); add.type = "button";
      add.textContent = "+ " + t("addinv", "Add inverter");
      add.addEventListener("click", function () {
        invModal({ id: invs.length, name: "", enabled: true, serial: "",
                   ch_max_pwr: [400, 400, 400, 400, 400, 400], ch_name: [], ch_yield_cor: [], pa: 1, disnightcom: false });
      });
      wrap.appendChild(add);
    }
    return wrap;
  }

  // hex serial helper for AHOY-encoded serials starting with 'A' (mirrors setup.html convHerf)
  function convHerf(sn) {
    var CHARS = "0123456789ABCDEFGHJKLMNPRSTUVWXY", i = 0n;
    for (var k = 0; k < 9; ++k) {
      var pos = CHARS.indexOf(sn[k]);
      var shift = 42 - 5 * k - (k <= 2 ? 0 : 2);
      i |= BigInt(pos) << BigInt(shift);
    }
    var f4 = (i >> 32n) & 0xFFFFn;
    if (f4 === 0x2841n) f4 = 0x1121n; else if (f4 === 0x2821n) f4 = 0x1141n; else if (f4 === 0x2801n) f4 = 0x1161n;
    i = (i & ~(0xFFFFn << 32n)) | (f4 << 32n);
    return i.toString(16);
  }

  function invModal(iv) {
    var ov = el("div", "modal-ov");
    var box = el("div", "modal");
    box.appendChild(el("h3", null, (iv.name ? iv.name : t("addinv", "Add inverter"))));

    var enCb = chk("", iv.enabled);
    box.appendChild(field(t("enable", "Enabled"), enCb));
    var serI = inp("", iv.serial); serI.placeholder = "hex serial";
    box.appendChild(field(t("serial", "Serial"), serI));
    var nmI = inp("", iv.name);
    box.appendChild(field(t("name", "Name"), nmI));
    var paSel = select("", NRF_PA, iv.pa);
    box.appendChild(field(t("powerlevel", "Power level"), paSel));
    var dncCb = chk("", iv.disnightcom);
    box.appendChild(field(t("pausenight", "Pause during night"), dncCb));

    box.appendChild(el("div", "sub", t("strings", "Strings") + " [Wp / name / kWh corr]"));
    var chRows = [];
    for (var c = 0; c < 6; c++) {
      var cr = el("div", "ch-row");
      var pI = inp("", iv.ch_max_pwr[c], "number"); pI.className = "cp";
      var nI = inp("", iv.ch_name[c] == null ? "" : iv.ch_name[c]); nI.className = "cn";
      var yI = inp("", iv.ch_yield_cor[c], "number"); yI.className = "cy"; yI.step = "0.001";
      cr.appendChild(el("span", "ci", String(c + 1)));
      cr.appendChild(pI); cr.appendChild(nI); cr.appendChild(yI);
      chRows.push([pI, nI, yI]);
      box.appendChild(cr);
    }

    var res = el("div", "modal-res");
    box.appendChild(res);
    var brow = el("div", "btn-row");
    var cancel = el("button", "", t("cancel", "Cancel")); cancel.type = "button";
    cancel.addEventListener("click", function () { document.body.removeChild(ov); });
    var savb = el("button", "primary", t("set", "Save")); savb.type = "button";
    savb.addEventListener("click", function () {
      var sn = serI.value.trim();
      if (sn[0] === "A") sn = convHerf(sn);
      var o = { cmd: "save_iv", token: token || "*", id: iv.id,
                ser: parseInt(sn, 16), name: nmI.value, en: enCb.checked,
                disnightcom: dncCb.checked, pa: parseInt(paSel.value, 10), ch: [] };
      for (var c = 0; c < 6; c++)
        o.ch.push({ pwr: chRows[c][0].value, name: chRows[c][1].value, yld: chRows[c][2].value });
      postJSON("api/setup", o, function (err, j) {
        if (err || !j || !j.success) { res.textContent = (j && j.error) || t("err", "Error"); res.className = "modal-res bad"; return; }
        document.body.removeChild(ov);
        toast("OK");
        ivl = null; loadSetup();   // refresh the list
      });
    });
    brow.appendChild(cancel); brow.appendChild(savb);
    box.appendChild(brow);
    ov.appendChild(box);
    ov.addEventListener("click", function (e) { if (e.target === ov) document.body.removeChild(ov); });
    document.body.appendChild(ov);
  }

  // ============================================================================
  // Slice 4e — web-serial console + OTA firmware upload, ported natively.
  // ============================================================================
  var serialSource = null;    // EventSource for the /events serial stream
  var serialBuf = "";         // accumulated console text (survives view rebuilds)
  var serialAuto = true;

  function startSerial() {
    if (serialSource || !window.EventSource) return;
    serialSource = new EventSource("/events");
    serialSource.addEventListener("open", function () { setSerialDot(true); }, false);
    serialSource.addEventListener("error", function (e) {
      if (e.target.readyState !== EventSource.OPEN) setSerialDot(false);
    }, false);
    serialSource.addEventListener("serial", function (e) {
      serialBuf += e.data.replace(/<rn>/g, "\r\n");
      if (serialBuf.length > 60000) serialBuf = serialBuf.slice(-40000); // bound memory
      var ta = $("#serTa");
      if (ta) { ta.value = serialBuf; if (serialAuto) ta.scrollTop = ta.scrollHeight; }
    }, false);
    // tell the device our UTC offset so timestamps are local (mirrors serial.html)
    postJSON("api/setup", { cmd: "serial_utc_offset", val: new Date().getTimezoneOffset() * -60 }, function () {});
  }
  function stopSerial() {
    if (serialSource) { serialSource.close(); serialSource = null; }
  }
  function setSerialDot(on) {
    var d = $("#serDot");
    if (d) d.className = "dot " + (on ? "live" : "stale");
  }

  function renderSerial(root) {
    root.innerHTML = "";
    root.classList.remove("stale");
    var head = el("div", "ser-head");
    head.appendChild(el("span", null, t("console", "Console")));
    head.appendChild(el("span", "dot", "")); head.lastChild.id = "serDot";
    root.appendChild(head);
    var ta = el("textarea", "ser-ta"); ta.id = "serTa"; ta.readOnly = true; ta.value = serialBuf;
    root.appendChild(ta);
    var row = el("div", "btn-row");
    var clr = el("button", "", t("clear", "Clear")); clr.type = "button";
    clr.addEventListener("click", function () { serialBuf = ""; ta.value = ""; });
    var scr = el("button", "", t("autoscroll", "Autoscroll")); scr.type = "button";
    scr.addEventListener("click", function () { serialAuto = !serialAuto; scr.classList.toggle("off", !serialAuto); });
    var cpy = el("button", "", t("copy", "Copy")); cpy.type = "button";
    cpy.addEventListener("click", function () {
      ta.select();
      try { document.execCommand("copy"); toast("OK"); } catch (e) { toast(t("err", "Error"), true); }
    });
    row.appendChild(clr); row.appendChild(scr); row.appendChild(cpy);
    root.appendChild(row);
    if (serialAuto) ta.scrollTop = ta.scrollHeight;
  }

  // ---- OTA firmware upload (faithful port of update.html: X-MD5 integrity, env
  // guard, XHR progress, success-on-socket-drop-after-upload semantics) ----
  var otaEnv = null;
  function renderUpdate(root) {
    root.innerHTML = "";
    root.classList.remove("stale");
    if (otaEnv == null) getJSON("api/generic", function (err, j) { if (!err && j) { otaEnv = j.env; renderUpdate($("#view")); } });

    var box = el("div", "ota");
    box.appendChild(el("div", "sec-h", t("selectfile", "Select firmware (*.bin)")));
    if (meta) box.appendChild(el("div", "sub", t("installed", "Installed") + ": " + meta.version + " (" + meta.build + ")" + (otaEnv ? " · " + otaEnv : "")));
    var fileWrap = el("div", "fld");
    var file = el("input"); file.type = "file"; file.id = "otaFile"; file.accept = ".bin";
    fileWrap.appendChild(file);
    box.appendChild(fileWrap);
    var status = el("div", "ota-status"); status.id = "otaStatus";
    box.appendChild(status);
    var btn = el("button", "primary", t("update", "Update")); btn.type = "button"; btn.disabled = true;
    file.addEventListener("change", function () { btn.disabled = !file.value; });
    btn.addEventListener("click", function () { otaHide(file, status); });
    box.appendChild(btn);
    var dl = el("a", "btn-link", t("downloads", "Downloads"));
    dl.href = "https://github.com/JustChr/ahoy/releases/latest"; dl.target = "_blank";
    box.appendChild(dl);
    root.appendChild(box);
  }

  // env-mismatch / dev-version guard before uploading (mirrors update.html hide())
  function otaHide(file, status) {
    var fw = file.value;
    var parts = fw.split("_");
    var bin = (otaEnv && fw.length >= otaEnv.length + 4) ? fw.slice(-otaEnv.length - 4, -4) : "";
    var ver = (parts.length > 2) ? parts[2].split(".") : null;
    if (ver && ver[1] === "9") { toast(t("otanotpossible", "Upgrade not possible from this file"), true); return; }
    if (bin !== otaEnv && otaEnv) {
      if (!confirm(t("otadiffenv", "This firmware is for a different device type. Continue anyway?"))) return;
    }
    otaStart(file, status);
  }

  function otaStart(file, status) {
    if (!file.files || !file.files[0]) return;
    var f = file.files[0];
    status.textContent = t("otastarted", "Update started…");
    var reader = new FileReader();
    reader.onload = function () {
      var md5 = null;
      try { md5 = md5FromBytes(new Uint8Array(reader.result)); } catch (e) { md5 = null; }
      otaSend(f, status, md5);
    };
    reader.onerror = function () { otaSend(f, status, null); };
    reader.readAsArrayBuffer(f);
  }

  function otaSend(f, status, md5) {
    var fd = new FormData(); fd.append("update", f);
    var xhr = new XMLHttpRequest();
    var uploaded = false;
    xhr.open("POST", "/update");
    if (md5) xhr.setRequestHeader("X-MD5", md5);
    xhr.upload.addEventListener("progress", function (e) {
      if (e.lengthComputable) status.textContent = t("otastarted", "Update started…") + " (" + Math.round(e.loaded / e.total * 100) + "%)";
    });
    xhr.upload.addEventListener("load", function () { uploaded = true; });
    function finish(ok) {
      if (ok) { status.textContent = t("otarebooting", "Uploaded — device rebooting…"); setTimeout(function () { location.href = "/app"; }, 20000); }
      else status.textContent = t("otafailed", "Update failed — still on previous firmware. Please retry.");
    }
    xhr.addEventListener("load", function () { finish(xhr.status >= 200 && xhr.status < 300); });
    xhr.addEventListener("error", function () { finish(uploaded); });
    xhr.addEventListener("timeout", function () { finish(uploaded); });
    xhr.send(fd);
  }

  // bluimp MD5 over raw bytes (SubtleCrypto lacks MD5) — verbatim from update.html so the
  // X-MD5 the device checks matches the curl path exactly. Do not "simplify".
  function md5FromBytes(bytes) {
    function safeAdd(x, y) { var lsw = (x & 0xffff) + (y & 0xffff); var msw = (x >> 16) + (y >> 16) + (lsw >> 16); return (msw << 16) | (lsw & 0xffff); }
    function rol(n, c) { return (n << c) | (n >>> (32 - c)); }
    function cmn(q, a, b, x, s, t2) { return safeAdd(rol(safeAdd(safeAdd(a, q), safeAdd(x, t2)), s), b); }
    function ff(a, b, c, d, x, s, t2) { return cmn((b & c) | (~b & d), a, b, x, s, t2); }
    function gg(a, b, c, d, x, s, t2) { return cmn((b & d) | (c & ~d), a, b, x, s, t2); }
    function hh(a, b, c, d, x, s, t2) { return cmn(b ^ c ^ d, a, b, x, s, t2); }
    function ii(a, b, c, d, x, s, t2) { return cmn(c ^ (b | ~d), a, b, x, s, t2); }
    var lenBits = bytes.length * 8;
    var x = new Int32Array((((lenBits + 64) >>> 9) << 4) + 16);
    for (var i = 0; i < bytes.length; i++) x[i >> 2] |= bytes[i] << ((i % 4) * 8);
    x[lenBits >> 5] |= 0x80 << (lenBits % 32);
    x[(((lenBits + 64) >>> 9) << 4) + 14] = lenBits;
    var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
    for (i = 0; i < x.length; i += 16) {
      var oa = a, ob = b, oc = c, od = d;
      a=ff(a,b,c,d,x[i],7,-680876936);    d=ff(d,a,b,c,x[i+1],12,-389564586);
      c=ff(c,d,a,b,x[i+2],17,606105819);  b=ff(b,c,d,a,x[i+3],22,-1044525330);
      a=ff(a,b,c,d,x[i+4],7,-176418897);  d=ff(d,a,b,c,x[i+5],12,1200080426);
      c=ff(c,d,a,b,x[i+6],17,-1473231341);b=ff(b,c,d,a,x[i+7],22,-45705983);
      a=ff(a,b,c,d,x[i+8],7,1770035416);  d=ff(d,a,b,c,x[i+9],12,-1958414417);
      c=ff(c,d,a,b,x[i+10],17,-42063);    b=ff(b,c,d,a,x[i+11],22,-1990404162);
      a=ff(a,b,c,d,x[i+12],7,1804603682); d=ff(d,a,b,c,x[i+13],12,-40341101);
      c=ff(c,d,a,b,x[i+14],17,-1502002290);b=ff(b,c,d,a,x[i+15],22,1236535329);
      a=gg(a,b,c,d,x[i+1],5,-165796510);  d=gg(d,a,b,c,x[i+6],9,-1069501632);
      c=gg(c,d,a,b,x[i+11],14,643717713); b=gg(b,c,d,a,x[i],20,-373897302);
      a=gg(a,b,c,d,x[i+5],5,-701558691);  d=gg(d,a,b,c,x[i+10],9,38016083);
      c=gg(c,d,a,b,x[i+15],14,-660478335);b=gg(b,c,d,a,x[i+4],20,-405537848);
      a=gg(a,b,c,d,x[i+9],5,568446438);   d=gg(d,a,b,c,x[i+14],9,-1019803690);
      c=gg(c,d,a,b,x[i+3],14,-187363961); b=gg(b,c,d,a,x[i+8],20,1163531501);
      a=gg(a,b,c,d,x[i+13],5,-1444681467);d=gg(d,a,b,c,x[i+2],9,-51403784);
      c=gg(c,d,a,b,x[i+7],14,1735328473); b=gg(b,c,d,a,x[i+12],20,-1926607734);
      a=hh(a,b,c,d,x[i+5],4,-378558);     d=hh(d,a,b,c,x[i+8],11,-2022574463);
      c=hh(c,d,a,b,x[i+11],16,1839030562);b=hh(b,c,d,a,x[i+14],23,-35309556);
      a=hh(a,b,c,d,x[i+1],4,-1530992060); d=hh(d,a,b,c,x[i+4],11,1272893353);
      c=hh(c,d,a,b,x[i+7],16,-155497632); b=hh(b,c,d,a,x[i+10],23,-1094730640);
      a=hh(a,b,c,d,x[i+13],4,681279174);  d=hh(d,a,b,c,x[i],11,-358537222);
      c=hh(c,d,a,b,x[i+3],16,-722521979); b=hh(b,c,d,a,x[i+6],23,76029189);
      a=hh(a,b,c,d,x[i+9],4,-640364487);  d=hh(d,a,b,c,x[i+12],11,-421815835);
      c=hh(c,d,a,b,x[i+15],16,530742520); b=hh(b,c,d,a,x[i+2],23,-995338651);
      a=ii(a,b,c,d,x[i],6,-198630844);    d=ii(d,a,b,c,x[i+7],10,1126891415);
      c=ii(c,d,a,b,x[i+14],15,-1416354905);b=ii(b,c,d,a,x[i+5],21,-57434055);
      a=ii(a,b,c,d,x[i+12],6,1700485571); d=ii(d,a,b,c,x[i+3],10,-1894986606);
      c=ii(c,d,a,b,x[i+10],15,-1051523);  b=ii(b,c,d,a,x[i+1],21,-2054922799);
      a=ii(a,b,c,d,x[i+8],6,1873313359);  d=ii(d,a,b,c,x[i+15],10,-30611744);
      c=ii(c,d,a,b,x[i+6],15,-1560198380);b=ii(b,c,d,a,x[i+13],21,1309151649);
      a=ii(a,b,c,d,x[i+4],6,-145523070);  d=ii(d,a,b,c,x[i+11],10,-1120210379);
      c=ii(c,d,a,b,x[i+2],15,718787259);  b=ii(b,c,d,a,x[i+9],21,-343485551);
      a=safeAdd(a,oa); b=safeAdd(b,ob); c=safeAdd(c,oc); d=safeAdd(d,od);
    }
    var hex = "0123456789abcdef", out = "";
    for (var wi = 0; wi < 4; wi++) {
      var w = [a, b, c, d][wi];
      for (var s = 0; s < 32; s += 8) { var bv = (w >>> s) & 0xff; out += hex[(bv >> 4) & 0xf] + hex[bv & 0xf]; }
    }
    return out;
  }

  // ---- lifecycle ----
  function onVisibility() {
    if (document.hidden) { if (timer) clearTimeout(timer); }
    else { pollFrame(); }
  }

  function start() {
    initTheme();
    var tb = $("#themeBtn");
    if (tb) tb.addEventListener("click", function () {
      applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
    });
    window.addEventListener("hashchange", setRoute);
    document.addEventListener("visibilitychange", onVisibility);
    setRoute();
    loadAuth(function () {
      loadMeta(function () { render(); pollFrame(); });
    });
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", start);
  else start();
})();
