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
  var fails = 0;
  var inFlight = false;
  var timer = null;
  var route = "now";
  var built = false;           // dashboard cards built for current meta?
  var nodes = { iv: [] };      // cached DOM refs for delta updates

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

  function loadMeta(cb) {
    getJSON("api/meta", function (err, j) {
      if (err || !j) { cb && cb(err || new Error("no meta")); return; }
      meta = j;
      built = false;
      cb && cb(null);
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
    render();
  }

  // ---- rendering (build once, then delta) ----
  function render() {
    var root = $("#view");
    if (!root) return;
    if (route === "system") { renderSystem(root); return; }
    renderNow(root);
    setLiveDot();
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

  function buildNow(root) {
    root.innerHTML = "";
    root.classList.remove("stale");
    nodes = { iv: [] };

    var hero = el("div", "hero");
    nodes.heroPwr = el("div", "big");
    nodes.heroSub = el("div", "sub");
    hero.appendChild(nodes.heroPwr);
    hero.appendChild(nodes.heroSub);
    root.appendChild(hero);

    if (!meta || !meta.iv || !meta.iv.length) {
      root.appendChild(el("div", "empty", t("noinv", "No inverters configured.")));
      built = true;
      return;
    }

    var grid = el("div", "grid");
    for (var i = 0; i < meta.iv.length; i++) {
      var m = meta.iv[i];
      var card = el("div", "card");
      var head = el("div", "head");
      var dot = el("span", "dot");
      var name = el("span", "name", m.name || ("#" + m.id));
      var pwr = el("span", "pwr");
      head.appendChild(dot); head.appendChild(name); head.appendChild(pwr);
      card.appendChild(head);

      var chBox = el("div");
      var chNodes = [];
      var nCh = m.ch_max_pwr ? m.ch_max_pwr.length - 1 : 0; // ch0 = AC
      for (var c = 0; c < nCh; c++) {
        var ch = el("div", "ch");
        var lbl = el("div", "lbl");
        var cname = el("span", null, (m.ch_names && m.ch_names[c + 1]) || ("CH" + (c + 1)));
        var cval = el("span");
        lbl.appendChild(cname); lbl.appendChild(cval);
        var bar = el("div", "bar");
        var fill = el("i");
        bar.appendChild(fill);
        ch.appendChild(lbl); ch.appendChild(bar);
        chBox.appendChild(ch);
        chNodes.push({ val: cval, fill: fill, max: (m.ch_max_pwr[c + 1] || 0) });
      }
      card.appendChild(chBox);

      var info = el("div", "meta-row");
      var ageN = el("span"), rssiN = el("span");
      info.appendChild(ageN); info.appendChild(rssiN);
      card.appendChild(info);

      grid.appendChild(card);
      nodes.iv.push({ card: card, dot: dot, pwr: pwr, ch: chNodes, age: ageN, rssi: rssiN });
    }
    root.appendChild(grid);
    built = true;
  }

  function renderNow(root) {
    if (!built) buildNow(root);
    if (!frame) return;
    root.classList.remove("stale");

    var u = (meta && meta.u_ac && meta.u_ac[AC_PAC]) || "W";
    nodes.heroPwr.innerHTML = "";
    nodes.heroPwr.appendChild(document.createTextNode(fmt(totalAC(), 0) + " "));
    nodes.heroPwr.appendChild(el("small", null, u));
    nodes.heroSub.textContent = t("today", "Today") + ": " + fmt(totalYield(), 2) + " " +
      ((meta && meta.u_ac && meta.u_ac[AC_YD]) || "kWh");

    for (var i = 0; i < nodes.iv.length && i < (frame.iv ? frame.iv.length : 0); i++) {
      var n = nodes.iv[i], a = frame.iv[i];
      n.dot.className = "dot " + statusClass(i);
      n.card.classList.toggle("dis", meta.iv[i] && !meta.iv[i].enabled);
      n.pwr.textContent = fmt(acVal(a, AC_PAC), 0) + " " + u;
      var nCh = Math.min(n.ch.length, dcChannels(a));
      for (var c = 0; c < n.ch.length; c++) {
        var cn = n.ch[c];
        if (c < nCh) {
          var p = dcVal(a, c, DC_PDC);
          cn.val.textContent = fmt(p, 0) + " W";
          cn.fill.style.width = cn.max > 0 ? Math.max(0, Math.min(100, (p / cn.max) * 100)) + "%" : "0";
        } else { cn.val.textContent = "–"; cn.fill.style.width = "0"; }
      }
      var age = a[4];
      n.age.textContent = t("updated", "updated") + " " + (age | 0) + "s " + t("ago", "ago");
      if (age > 120) n.age.classList.add("stale"); else n.age.classList.remove("stale");
      n.rssi.textContent = "RSSI " + a[3] + "%";
    }
  }

  function renderSystem(root) {
    var g = frame ? frame.g : null;
    root.innerHTML = "";
    root.classList.remove("stale");
    var tiles = el("div", "tiles");
    function tile(k, v) {
      var d = el("div", "tile");
      d.appendChild(el("div", "k", k));
      d.appendChild(el("div", "v", v));
      tiles.appendChild(d);
    }
    if (g) {
      var flags = g[4] | 0;
      tile("WiFi RSSI", g[0] + " dBm");
      tile(t("heap", "Free heap"), (g[1] / 1024).toFixed(1) + " KB");
      tile(t("uptime", "Uptime"), dur(g[2]));
      tile(t("rfcadence", "RF cadence"), g[3] + " s");
      tile("MQTT", (flags & 0x02) ? t("conn", "connected") : t("off", "off"));
      tile(t("adaptive", "Adaptive RF"), (flags & 0x08) ? "on" : "off");
      if (flags & 0x04) tile("OTA", "active");
    } else {
      tiles.appendChild(el("div", "empty", t("waiting", "Waiting for data…")));
    }
    root.appendChild(tiles);
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
    loadMeta(function () { render(); pollFrame(); });
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", start);
  else start();
})();
