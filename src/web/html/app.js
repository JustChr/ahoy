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
    render();
  }

  // ---- rendering (build once, then delta) ----
  function render() {
    var root = $("#view");
    if (!root) return;
    updateAuthBar();
    if (route === "system") { renderSystem(root); return; }
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
