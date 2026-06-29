# AhoyDTU System Reliability & UI Redesign — Design Doc

> Status: **FINALIZED — v1.0 spec** (2026-06-29). Ready to implement; no code written yet.
> Scope: **clean-room redesign** (divergence from upstream lumapu/ahoy is acceptable), **whole-system bulletproof first, pixels last**, targets **ESP8266-primary + phone-first**.
> "Bulletproof" applies to the **whole device**, not just the UI: keep the integration links (RF↔inverters, MQTT, NTP, REST API, OTA) alive and update inverter data as fast as possible *while* maintaining absolute stability. The UI is one co-tenant of a shared core + heap, covered in §2–§9; the system-wide model is §10.

## Executive summary

The current web stack is the firmware's biggest stability liability: every live refresh fires **3 sequential requests**, each allocating a JSON document sized to `getMaxFreeBlockSize()-512` ≈ **12.8 KB — ~96 % of the largest free heap block** — while MQTT and WiFi compete for the same ~13 KB. On a single cooperative core, that allocation and the long callbacks it implies also stall the time-critical RF link to the inverters. **Speed and stability are therefore the same problem**, both solved by the same disciplines: bounded/fixed heap, time-boxed work, mutual exclusion of heavy ops, and an adaptive (not fixed) inverter poll cadence.

The redesign: the ESP serves a **tiny SPA shell once** and **one fixed ≤2 KB data frame on a timer**; the browser owns layout, state, and formatting. Inverter polling becomes a **closed-loop controller** that runs as fast as RF health allows and backs off automatically. External contracts (MQTT, HA discovery, REST, Prometheus, settings JSON) are **frozen or shimmed**; settings migrate **read-in-place**. Net steady-state heap pressure drops from *3 × ~12.8 KB every 5 s* to *1 × fixed 2 KB*, with a hard floor below which the web layer bows out instead of crashing.

## Table of contents

0. Prime directive: BULLETPROOF (whole system)
1. Measured baseline
2. Target architecture (`/api/frame`, `/api/meta`, on-demand)
3. Bulletproofing rules — firmware
4. Bulletproofing rules — browser
5. SPA shell + assets
6. Phone-first dashboard
7. Before / after
8. Implementation plan (phased; Phase 0 = OTA hardening, ship now)
9. Verification plan (UI)
10. Whole-system bulletproofing (RF · MQTT · NTP · Web · OTA)
11. Migration, compatibility & feature parity
12. Adaptive RF cadence controller
13. Settings migration approach
14. Authentication & authorization model
15. Exact data contracts (`/api/frame`, `/api/meta`, `/api/auth`) + serializer
16. Build pipeline & localization (i18n)
17. Definition of done / acceptance criteria
18. Open questions & decisions log
19. OTA hardening

## 0. Prime directive: BULLETPROOF (whole system)

The device is an ESP8266: **one cooperative CPU core and one ~13 KB largest heap block**, shared by the RF link to the inverters, WiFi/TCP, MQTT, NTP, the web server, and OTA. These are **not independent subsystems — they are co-tenants that can starve each other** of CPU and heap. Bulletproof means no link can take the device (or another link) down.

Governing principle:

> One cooperative core + one tiny shared heap ⇒ **explicit priority, bounded peak heap, and time-boxed work.** No single link may starve another of CPU *or* heap.

Concretely:

1. **Bounded, predictable heap, everywhere.** No allocation whose size depends on current free heap (kills the current `getMaxFreeBlockSize()` pattern). No single op may consume the largest free block. Every heavy allocator has a fixed budget + a global heap floor below which it defers.
2. **Time-boxed work.** No callback runs long enough to stall the RF state machine or WiFi servicing (~50–100 ms cap; chunk big jobs across loop iterations).
3. **Degrade, never crash.** Out of heap / busy → defer or return a tiny static `503`, never a half-serialized doc. Consumers tolerate stale/missing data.
4. **Mutual exclusion of heavy ops.** Only one big serialization (web frame **or** MQTT publish-all **or** OTA) in flight at once. They take turns.
5. **Adaptive, closed-loop link cadence.** Poll inverters as fast as health allows; back off automatically when the RF queue fills or retransmits spike. Fast *and* stable, not one fixed interval.
6. **Single in-flight web request.** Browser never has >1 data request outstanding.
7. **OTA = global quiesce.** During flash, RF polling / MQTT publish / web frames stand down to minimise heap in use.

---

## 1. Measured baseline (ahoy.home.arpa, v0.8.162, 2 inverters, 2026-06-29)

| Metric | Value | Implication |
|---|---|---|
| `heap_total` | 24.3 KB | Tiny. |
| `heap_free` | 15.9 KB | |
| `heap_max_free_blk` | **13.3 KB** | Largest contiguous block. |
| `heap_frag` | 16 % | |
| API JsonDocument size | `getMaxFreeBlockSize() - 512` ≈ **12.8 KB** | **~96 % of the largest block, per request.** Root cause of fragility. |
| Live refresh | **3 sequential requests / 5 s** | `/api/live` 688B + `/api/inverter/id/0` 595B + `/api/inverter/id/1` 596B ≈ 1.88 KB |
| Cascade wall time | 136–292 ms | |
| Changing data | **41 floats / inverter** (`ch[0]`=13, `ch[1..4]`=4×7) | Everything else is static-per-session but re-sent every 5 s. |

**The smoking gun:** steady state is **3 × ~12.8 KB near-whole-block allocations every 5 seconds**, each re-sending the static `generic` block, while MQTT (tx 22.5k) and WiFi compete for the same heap. That is the instability.

---

## 2. Target architecture

ESP serves a **tiny SPA shell once** + **one small fixed-size data frame on a timer**. Browser owns everything else.

```
Browser (SPA shell, loaded once)
  ├─ on first load:  GET /api/meta     → static per-session data (1 shot, cached)
  ├─ on timer (1 in-flight max):  GET /api/frame  → flat live numbers, fixed ≤2KB
  └─ on demand only:  alarms / grid profile / radio stats / version (modal opens)

ESP8266
  ├─ /api/meta   : built rarely, can be larger, not in steady state
  ├─ /api/frame  : FIXED 2KB JsonDocument (or flat writer), bounded forever
  └─ everything else: on demand, never in the steady-state path
```

### 2.1 `/api/frame` — the steady-state endpoint

Single request replaces the 3-request cascade. **Flat positional payload** — field meanings live in the JS index map, not as repeated JSON keys.

Proposed shape (illustrative):

```json
{
  "t": 1782733707,
  "g": [-68, 15928, 1305, 0],
  "iv": [
    [2, 655.2, 7887, 5713.866, 689.7, 67.3, 100, 656.4, /* ch1.. */ 171.7, 172.4, 172, 173.6],
    [2, 1085.2, ...]
  ]
}
```

- `g` = generic: `[rssi, heap_free, uptime, flags]` — only what changes / is worth watching live.
- `iv[n]` = flat float array per inverter, fixed field order documented in the JS map.
- **No** serial/version/name/units here — those come from `/api/meta` once.

**Allocation budget (the bulletproof core):**

```
frame_doc = 512 B (header/generic) + 320 B per inverter, capped at 4 inverters
          = 512 + 4*320 = 1792 B  →  allocate a FIXED 2 KB StaticJsonDocument / fixed buffer
```

- ~2 KB vs ~12.8 KB today → **~15 % of the largest block instead of ~96 %.**
- **Constant** regardless of heap state. Never call `getMaxFreeBlockSize()` in this path again.
- If even 2 KB can't be had → `503` + static `{"e":1}` (12 bytes), browser keeps last frame.

Even better (phase 1b): skip ArduinoJson entirely for `/api/frame` and stream a flat
CSV/array directly into the response — near-zero node overhead. Flat-JSON first (safe, debuggable), CSV later if we want to shave more.

### 2.2 `/api/meta` — one-shot static data

Per-session constants, fetched once when the dashboard first renders, cached in the browser: inverter `name`, `serial`, `generation`, `max_pwr`, `ch_name`, `ch_max_pwr`, field units/names, host, version, build. Never in the steady-state loop.

### 2.3 On-demand only

Alarms, grid profile, radio stats, firmware version, power-limit control — fetched only when the user opens that card/modal. Zero steady-state cost. These can keep a larger (but still bounded) document since they're rare and user-initiated.

---

## 3. Bulletproofing rules (firmware side)

1. **Fixed web memory budget.** `/api/frame` uses a compile-time-sized buffer. Define `WEB_FRAME_MAX_IV` (default 4); document size is constant.
2. **Heap guard.** Before building any response, if `free < FLOOR` (e.g. 6 KB) return `503` immediately with a static body. The UI must keep working from cached state.
3. **OTA lockout.** During OTA, `/api/frame` returns `503 busy` (the OTA path already pauses WiFi self-heal in v0.8.162 — frame serving should bow out too, not allocate).
4. **No concurrent heavy builds.** A single mutex/flag so two overlapping requests can't both allocate the frame doc.
5. **Serialize directly to the response stream** where possible, so peak = doc size, not doc + serialized copy.

## 4. Bulletproofing rules (browser side)

1. **Single in-flight request.** Abort/skip a tick if the previous `/api/frame` hasn't returned. No stacking.
2. **Stale-tolerant rendering.** Keep last good frame; on error or short payload, mark values "stale" (dimmed + timestamp), don't blank the UI.
3. **Backoff on failure.** 1 fail → retry next tick; N fails → widen interval (5 s → 15 s → 30 s) until success, then snap back. Protects the device when it's already struggling.
4. **Pause when not watched.** `document.hidden` → stop polling. Night window (device knows sunrise/sunset) → poll slowly or stop.
5. **Delta DOM updates.** Build cards once; each frame writes only changed text nodes. No `replaceChildren`, no flicker, minimal CPU.

## 5. SPA shell + assets

- One `app.html` + one `app.js` + one `app.css`, loaded once, hash-routed views (`#/now`, `#/system`, `#/setup`, `#/history`). CSS/JS parsed once, not per navigation.
- Retire per-page boilerplate (saves flash) and the 68 KB `setup.html` becomes a view.
- Replace the bootstrap-clone grid (`col-1…12`, `fs-1…10`) + imperative `ml()` builder with CSS grid + a thin render helper. Smaller bundle.
- Keep CSS-variable theming + dark/light.

## 6. Phone-first dashboard (`#/now`)

- Hero card: total AC power (big, live) + today's yield + sparkline.
- Responsive grid of inverter cards: status dot (producing/idle/offline/disabled = color), name, power, thin per-channel bars. Tap → inline channel detail.
- System view: WiFi/RTC/loss diagnostics as compact stat tiles, not table dumps.

---

## 7. Before / after

| | Today | After |
|---|---|---|
| Requests / refresh | 3 sequential | **1** |
| Transient alloc | 3 × ~12.8 KB | **1 × fixed 2 KB** |
| Alloc vs. max block | ~96 % each | **~15 %** |
| Static data re-sent | every 5 s | **once** |
| Heap floor protection | none | `503` below floor |
| In-flight requests | can stack | **1 max** |
| Render | full rebuild | delta only |

## 8. Implementation plan (phased, low risk → high reward)

Each phase is independently shippable and verifiable. Phases 0–1 are pure firmware/transport (no visual change); 2+ touch the UI. Nothing in a later phase is required for an earlier one to ship.

### Phase 0 — OTA hardening (ship NOW, standalone patch e.g. v0.8.163)

Addresses active OTA instability; **independent of the redesign** (no SPA, no new endpoints). Full detail in §19.

- [x] **A. OTA = global quiesce.** Extend `setOtaActive`: during OTA, data endpoints `503`; RF polling + MQTT publishing stand down; serial buffer dropped. (Also lays the `heavy-op token` groundwork reused in Phase 1.) — *`isOtaActive()` exposed via IApp; `tickSend` + `mMqtt.loop()` gated in `app.cpp`; `/api/*` returns static `503 {"e":"ota"}` in `RestApi::onApi`; web-serial buffer dropped in `web.h::tickSecond`.*
- [x] **B. Pre-flight checks** before `Update.begin` — refuse cleanly if `free heap < OTA_HEAP_FLOOR` or `Content-Length > free sketch space`. — *`showUpdate2`: `OTA_HEAP_FLOOR=8192`, `contentLength()` vs `getFreeSketchSpace()`; `mOtaDenied` flag skips all writes and stays on current fw.*
- [x] **C. Browser-side integrity** — compute firmware MD5 in `update.html`, send `X-MD5` (matches the `curl` path). — *embedded compact blueimp MD5 over raw file bytes; `X-MD5` header set on the XHR; falls back to size-only if hashing fails.*
- [x] **D. Watchdog during slow writes** — verify/feed WDT in the write path (runs outside `loop()`). — *`yield()` after each `Update.write` chunk to service the soft WDT + network stack.*
- [x] **E. Honest-failure UX** — update view surfaces "failed, still on old firmware". — *`showUpdate` returns HTTP 500 on failure; `update.html` XHR `load` checks `xhr.status` instead of always claiming success.*
- *Verify per §19.3. Exit criteria: OTA completes with a web client polling + MQTT publishing + serial connected; corrupt/oversized images rejected cleanly.*

### Phase 1 — Bounded data path (firmware/transport; no visual change)

The biggest stability win, measurable against the §1 baseline.

- [x] `/api/frame` (§15.1) — single endpoint, schema-versioned, flat positional payload. — *`RestApi::getFrame()`; FIXED `AsyncJsonResponse(false, WEB_FRAME_DOC_SIZE=3072)` (constant, never `getMaxFreeBlockSize()`); `g[]`=`[rssi,heap_free,uptime,Te,flags]` (Te=`sendInterval` until Phase 2); per-iv `[status,pl_read,alarm_cnt,rssi,age, 13×AC, 7×DC/ch]` mirroring `getInverter()`; intercepted in `onApi` before the legacy ~12.8 KB alloc.*
- [x] `/api/meta` (§15.2) one-shot static data; `/api/auth` (§14.2) lock state. — *`getMeta()` (host/version/build/esp_type/refresh/region/tz, `prot{}`, AC+DC units+names once, per-iv id/name/serial/gen/max_pwr/enabled/ch_names/ch_max_pwr — no secrets); `getAuth()` returns `{protected,unlocked,mask}` in a 256 B doc.*
- [x] Global `HEAP_FLOOR` on the web steady-state path; `getMaxFreeBlockSize()` removed from the steady-state path. — *`WEB_HEAP_FLOOR=6144`; below it `/api/frame` returns static `503 {"e":1}` so a struggling device degrades (client keeps last frame). `/api/frame` is the new steady state and never calls `getMaxFreeBlockSize()`; legacy `/api/live` etc. (compat shim only) still do.*
- [~] Heavy-op token (§10.3) across web + MQTT + OTA — **deferred to Phase 2.** *Once `/api/frame` is a fixed ≤3 KB alloc (not 12.8 KB), two overlapping builds are ~6 KB, not catastrophic, and OTA already provides global quiesce (Phase 0). A token held across AsyncWebServer's lazy/async serialization can't be released at the right time without a stuck-token (always-503) risk — a stability regression. Folded into Phase 2 where MQTT publish chunking lives and the token has a natural synchronous release point.*
- [x] Legacy `/api/*` endpoints kept as compat shim (§11.1). — *untouched; all legacy paths still dispatch in `onApi`. New endpoints are purely additive.*
- *Exit criteria: §9 verification — peak alloc bounded/constant, 1 request/refresh, heap floor respected, 24 h soak clean. **Builds clean (esp8266, RAM 62.8 %, Flash 58.6 %); not yet flashed/verified on device** (device still on 0.8.162 — remote OTA is wedged at eboot, needs serial flash).*

### Phase 2 — Adaptive RF cadence (firmware; the "fast + stable" core)

- [ ] Closed-loop controller (§12) replacing fixed `sendInterval`; `adaptive` toggle (default on), `T_min`/`T_max` bounds.
- [ ] Hard backpressure (skip enqueue on full queue); per-inverter slow-probe for offline units.
- [ ] Expose `Te` + health in `/api/frame` `g[]` and `net_diag`.
- *Exit criteria: §10.4 — cadence shortens when healthy, backs off under induced loss, no queue overflow; MQTT freshness improves per §12.5 without destabilising.*

### Phase 3 — SPA shell + delta rendering (UI foundation)

- [ ] `app.html`/`app.js`/`app.css` shell, hash routing, single-in-flight + backoff (§4, §5).
- [ ] Delta DOM updates; pause on hidden/night.
- [ ] Per-language build bundles (§16); auth = global lock, UI hiding cosmetic (§14).
- *Exit criteria: navigation instant, no flicker, German build verified.*

### Phase 4 — Phone-first dashboard + view migration

- [ ] `#/now` dashboard (§6); system/diag tiles.
- [ ] Migrate setup/system/history/serial/update/wizard into the shell; retire standalone pages.
- [ ] **Full §11.5 parity checklist ticked**; settings migration verified (§13.3); MQTT/HA discovery untouched.
- *Exit criteria: §17 definition of done fully met.*

### Phase 5 — (optional, measured) Push updates

- [ ] SSE/WS delta stream — only if heap headroom is proven; costs a persistent socket. Revisit after Phases 1–2 free heap.

## 9. Verification plan

Re-run the §1 measurements after Phase 1 and confirm:
- `/api/frame` peak alloc ≤ 2 KB (instrument with a heap-low-water mark around the build).
- 1 request/refresh, static data sent once.
- Heap min-free under load (MQTT + frame + OTA) stays above floor.
- 24 h soak with no reboot/dead-link increment in `net_diag`.

---

## 10. Whole-system bulletproofing (RF · MQTT · NTP · Web · OTA)

The UI is only one consumer. The integration links share the same scarce resources, so reliability is a *system* property. This section covers the device side; §2–§9 cover the web/UI consumer that must comply with it.

### 10.1 The execution & contention model (as-built)

ESP8266 = **single cooperative core**. Everything runs in `loop()` (`app.cpp:131`):

```
loop():
  esp_task_wdt_reset()
  mNrfRadio.loop()        // RF reception/IRQ — time-critical, frames on a tight clock
  Scheduler::loop()       // runs each DUE ticker callback to COMPLETION, yield() after each
  mCommunication.loop()   // RF state machine IDLE→START→WAIT→CHECK_FRAMES (non-blocking timers)
  mMqtt.loop()            // MQTT pump
  yield()
```

Plus **AsyncWebServer runs in TCP-stack callbacks *outside* `loop()`** — a web JSON build can fire between loop iterations and grab heap mid-MQTT-publish.

Three structural facts:

1. **Any long callback stalls the RF link.** The cooperative scheduler runs each ticker to completion. A big MQTT publish-burst or a 12.8 KB web build blocks `mCommunication.loop()` + `mNrfRadio.loop()` for its whole duration → **missed inverter frames** (data loss) *and* delayed WiFi/MQTT servicing (the "associated but dead" risk). Speed and stability are coupled through blocking.
2. **One heap, many claimants, no mutual exclusion.** Web doc (12.8 KB today), MQTT buffers, OTA, RF payloads all draw from the same ~13.3 KB largest block. Overlap = fragmentation/OOM window.
3. **No backpressure between links.** `tickSend` (`app.cpp:370`) enqueues all inverters every `sendInterval` regardless of RF health; it only *warns* when the CommQueue is nearly full (`app.cpp:374`). Inverter RSSI ≈ −75 → retransmits cost real time, but cadence doesn't adapt.

### 10.2 Priority ladder (what must never be starved)

1. **RF state-machine timing** — inverter data freshness. Time-critical.
2. **WiFi/TCP + MQTT keepalive** — link liveness.
3. **Serialization for consumers** (web frame, MQTT publish) — bounded, chunked, yield-friendly.
4. **OTA** — exclusive "quiesce everything" mode.

### 10.3 Mechanisms (device-side concepts)

- **Global heap floor + budget map.** One `HEAP_FLOOR`. Every heavy allocator checks it and *defers* rather than allocating into the danger zone. Replaces `getMaxFreeBlockSize()` grabs (web §2.1, and audit MQTT/OTA the same way).
- **Single "heavy-op" token.** Only one big serialization in flight at a time — web frame *or* MQTT publish-all *or* OTA. They take turns; worst-case overlap becomes impossible.
- **Time-box every ticker (~50–100 ms).** Chunk big jobs across loop iterations with a cursor (publish N fields/inverters per pass), so RF + WiFi are serviced between chunks. Biggest stability lever in a cooperative model.
- **Stream, don't buffer.** Web frame and MQTT publish serialize incrementally → small peak heap.
- **Adaptive RF cadence (closed loop).** The "fast *and* stable" knob: speed up when CommQueue fill is low and loss is low; back off when fill is high or retransmits spike. Replace fixed `sendInterval` with a controller bounded by [min, max]. Persist health in `net_diag`-style counters.
- **Decouple acquisition from publication.** RF acquires into the record struct at the fast cadence; MQTT/web read snapshots. A slow MQTT publish must never gate RF (mostly true via listeners today, but publish bursts still run in-loop — chunk them).
- **Non-blocking external I/O.** Guarantee NTP/DNS/MQTT-connect never block `loop()` for seconds (DNS is the classic offender). Watchdog-guard or make async.
- **OTA global quiesce.** Extend v0.8.161/162: during flash, pause RF polling + MQTT publish + web frames; keep heap maximally free.

### 10.4 System verification (beyond §9)

- Instrument **per-callback max duration**; assert none exceeds the time-box under load.
- Track **RF freshness** (age of newest frame per inverter) while a web client polls + MQTT publishes — must not regress vs. idle.
- Track **min-free-heap low-water mark** across a full cycle of {RF poll + MQTT publish + web frame + OTA}; must stay above floor.
- **Adaptive cadence** observed to shorten in good conditions and lengthen under induced loss, without queue overflow.
- 24 h soak: no reboot, no `net_diag` dead-link/offline increments, no MQTT-reconnect storm.

---

## 11. Migration, compatibility & feature parity

**This redesign changes the UI and the web transport. It is NOT a feature cull and NOT a contract break.** Everything users rely on is ported; the two external contracts are frozen.

### 11.1 Frozen contracts (must not change)

- **MQTT topics + Home Assistant auto-discovery.** HA entities, dashboards, automations, and long-term history key off exact topic names and `unique_id`s. Renaming anything orphans entities and loses history. → MQTT publish + discovery are **out of scope / untouched** by this redesign.
- **Existing REST API** (`/api/live`, `/api/inverter/id/N`, `/api/system`, `/api/index`, …). Third-party scripts and HA-REST depend on them. → Keep legacy endpoints as a **compatibility shim**; the new flat `/api/frame` + `/api/meta` are *additive* (or namespaced `/api/v2/*`). Removal only after a deprecation window.
- **Prometheus `/metrics`** — frozen, external scrapers depend on it.
- **Settings export/import JSON format** — users' backups must restore on the new firmware (the migration safety net). Keep the schema or provide a converter.

### 11.2 Settings migration

Config persists as a versioned struct. The new firmware **must read the existing config** (same keys / migrate in place), or users lose all settings on OTA. Verify: flash old config → OTA to new → all settings intact, no factory-reset. Export/import is the fallback path and must round-trip.

### 11.3 Auth model (single global lock — NOT per-page)

Auth is **not per page**. There is one global lock: a single optional password; when set, a client unlocks a session (by IP, plus a 16-char token for API calls) with an auto-logout timeout. `prot_mask` only chooses which **menu items are hidden** — it is cosmetic, not a security boundary. Many users run with **no password at all** (`pwd_set=false` on the reference device). See §14 for the full spec. The only real requirement for the SPA: sensitive endpoints keep checking the existing global lock server-side; UI hiding is never relied on as protection.

### 11.4 Localization

`{#TOKEN}` is resolved at build time (en/de). The SPA needs an explicit i18n strategy (e.g. a small per-language string map fetched once, or build-time bundles) or German is lost.

### 11.5 Feature parity checklist (nothing ships until ticked or consciously dropped)

Views: [ ] dashboard [ ] live [ ] history/charts [ ] web-serial [ ] setup [ ] system/diag [ ] update/OTA [ ] about [ ] login/logout [ ] first-run wizard

Controls / functions: [ ] power-limit (persistent/nonpersistent × relative/absolute) [ ] inverter on/off [ ] inverter restart [ ] DTU reboot [ ] grid-profile decode (`grid_info.json`) [ ] alarm history [ ] radio statistics [ ] firmware-version readout [ ] night-comm pause (sun) [ ] scheduled midnight reboot [ ] zero-values-on-unavailable [ ] yield-day correction / module config [ ] settings export/import [ ] coredump download [ ] custom nav link

Config sections: [ ] sys/device/timezone/region [ ] password protection [ ] network/ip/eth [ ] nrf24 [ ] cmt (ESP32) [ ] ntp [ ] sun [ ] serial/debug [ ] led [ ] mqtt + HA discovery [ ] inst (sendInterval/retries/reset) [ ] display plugin [ ] per-inverter config

Integrations: [ ] MQTT [ ] HA discovery [ ] REST API (legacy) [ ] Prometheus [ ] syslog [ ] display [ ] Ethernet

### 11.6 Foreseeable user issues (watch list)

1. HA entities orphaned / history lost → mitigated by 11.1.
2. Third-party REST scripts break → mitigated by compat shim 11.1.
3. Settings wiped on upgrade → mitigated by 11.2.
4. Silent feature gap → mitigated by 11.5 checklist.
5. Protected controls exposed via SPA → mitigated by 11.3.
6. German lost → mitigated by 11.4.
7. Very old browsers unsupported by SPA → acceptable (phone-first), note in release.

---

## 12. Adaptive RF cadence controller (the "fast + stable" core)

**Goal:** poll inverters as fast as RF health allows, automatically backing off before the link or queue is overwhelmed. Replaces the fixed `sendInterval` (default **15 s**, `config.h:207`) with a bounded controller. This is the single mechanism that satisfies both "as quick as possible" and "absolute stability."

### 12.1 Bounds (grounded in RF timing)

One request cycle per inverter ≈ `DURATION_TXFRAME (85ms) + frames×DURATION_ONEFRAME (~50ms) + reserve` → ~0.4–0.6 s per inverter per attempt, more with retransmits (`hmDefines.h`).

- `T_max` = the user's configured `sendInterval` (default 15 s) — the **baseline ceiling**, never slower than today.
- `T_min` = `max(3 s, ceil(N_enabled_iv × 0.7 s))` — never faster than the link can physically drain for the inverter count. Hard floor; never violated.
- Effective interval `Te ∈ [T_min, T_max]`.

### 12.2 Inputs (all already tracked)

- **Queue fill ratio** = `getFillState()/getMaxFill()` (`app.cpp:372`, CommQueue).
- **Loss / retransmit rate** from radio stats: `rx_fail`, `rx_fail_answer`, `retransmits` vs `tx_cnt` (RestApi radiostat).
- **Per-inverter availability/status** (skip/slow-probe offline inverters so a dead unit can't drag global cadence).
- **Heap floor status** (never speed up while heap is near floor).

### 12.3 Algorithm — gentle speed-up, fast back-off (stability-first AIMD)

```
each control tick:
  if heap < floor  OR  fill > 0.8  OR  loss_rate > LOSS_HI:
        Te = min(T_max, Te * 2)          # multiplicative back-off (aggressive)
        reset healthy_streak
  elif fill low AND loss_rate < LOSS_LO:
        healthy_streak++
        if healthy_streak >= N_HEALTHY:  # hysteresis: require sustained health
            Te = max(T_min, Te - STEP)   # additive speed-up (gentle)
            healthy_streak = 0
  # else: hold
```

- **Hysteresis** (`N_HEALTHY` consecutive good ticks before each speed-up) prevents oscillation.
- **Hard backpressure:** if `fill > high-watermark`, *skip enqueue entirely* this round — never pile onto a full queue (today it only warns, `app.cpp:374`).
- **Per-inverter probe:** offline inverters polled at a slow fixed probe interval, excluded from the fast loop.

### 12.4 Compatibility & observability

- Keep `sendInterval` as `T_max`; add an **`adaptive` on/off toggle (default on)** + optional `T_min` override. Adaptive **off** ⇒ behaves exactly as today (safe fallback, no behavior change for users who want it).
- Expose current `Te` + health score in `/api/frame` `g[]` and `net_diag` so the controller is *observable* and the §10.4 verification can confirm it shortens in good conditions and lengthens under induced loss.

### 12.5 Effect on MQTT data rate

**MQTT publishing is event-driven off the RF poll, not a separate timer.** In the default config (`mqtt.interval = 0`, "off"), fresh inverter data is published the moment RF receives it (`pubMqtt.h:180`, `:261`). So **MQTT freshness = RF poll cadence**, and the adaptive controller governs it directly:

| Condition | Existing firmware | New concept |
|---|---|---|
| Default, healthy link | every **15 s** (fixed `sendInterval`) | adaptive down to **~3 s** floor (2 iv: `max(3, 2×0.7)`) → up to **~5× fresher** |
| Degraded link (loss/retransmits, RSSI ≈ −75) | every 15 s | backs off toward **15 s** — same as today |
| `mqtt.interval = N > 0` set | every N s | every N s — unchanged (fixed MQTT timer overrides) |
| Night / not producing | paused | paused — same |

Honest framing: default users get **fresher MQTT, never slower than today** (today's 15 s is the controller's ceiling); the gain is **link-dependent** ("as fast as the link safely allows," not a guaranteed 3 s). Users with a fixed `mqtt.interval` see unchanged cadence — only each publish's data is fresher.

**Coupling:** faster RF ⇒ more frequent publishes ⇒ more publish load. This is why §10.3's chunked/time-boxed publish + heavy-op token exist — they let the data rate rise *without* the extra publishes destabilising the device. The two are designed together.

---

## 13. Settings migration approach

**Chosen approach: read-in-place (no converter needed for forward migration).**

### 13.1 Why it works

Settings persist as **JSON in LittleFS `/settings.json`** with `CONFIG_VERSION` (currently 11). Load path: `loadDefaults()` → overlay each field via `getVal<key>()` (`settings.h:287+`). Missing keys keep their default. So a new firmware that **keeps the existing JSON key names** reads an old file transparently; new fields get defaults. The version field gates any semantic migration.

### 13.2 Rules

1. **Never rename an existing JSON key.** Rename = silent data loss. If a concept must change, read *both* old and new key during a transition window.
2. **`loadDefaults()` always runs first** (already does) → partial/old/corrupt files are safe.
3. **Bump `CONFIG_VERSION` only for semantic changes** (units/meaning), and add an explicit migration step keyed on the old version for that field.
4. **Export/import JSON stays identical** so user backups round-trip on the new firmware.
5. **Partition table must not change.** A different partition CSV / FS layout wipes LittleFS = total settings loss on OTA. Keep the partition map identical. (This is the real residual risk, not the JSON.)

### 13.3 Verification matrix

- Flash representative v0.8.162 config → OTA to new firmware → **diff exported JSON before/after**; assert every field intact, no factory reset.
- Import an old JSON backup on new firmware → all fields restored.
- Confirm partition table byte-identical to current release.
- Corrupt/truncate `/settings.json` → boots on defaults, no crash loop.

### 13.4 Downgrade safety (flashing an OLD firmware must keep working)

**Guaranteed by construction**, given the §13.2 rules:

1. **OTA mechanism:** flashing an old `.bin` is a normal single-slot `Update`. Phase 0 pre-flight passes (old image is smaller; `X-MD5` is computed over the uploaded file). Nothing in this plan blocks it. (Single-slot caveat unchanged: power-loss mid-flash still needs a serial reflash — §19.2.)
2. **Settings survive downgrade:** `readSettings()` runs `loadDefaults()` then overlays known keys (`settings.h:288`); an old firmware **ignores keys it doesn't know** (future `adaptive`/`tmin`/…). The version-mismatch path is `loadAddedDefaults()` — **not a wipe** — and is **forward-only** (`if(configVersion < N)`, `settings.h:513`), so a *higher* file version fires **no** block → existing settings untouched.
3. **Therefore downgrade is safe iff** the three frozen rules hold: partition table byte-identical, no key renames, new fields additive-with-defaults. **`loadAddedDefaults` must never use `>`/`!=` clobber logic or factory-reset on mismatch** — keep it `< N` forward-only.

Verify: flash new firmware (write settings) → OTA **back** to a prior release → settings intact, boots clean, no factory reset.

---

## 14. Authentication & authorization model

**Auth is a single global lock, not per-page and not per-endpoint granular.** Keep the existing `Protection` mechanism (`src/web/Protection.h`) as-is; the redesign only changes how the SPA *talks* to it.

### 14.1 As-built (keep)

- One optional shared password (`mPwd`). **If empty, nothing is protected** — common case (`pwd_set=false` on the reference device).
- When set, a client "unlocks" a session: web UI is recognised by **client IP** (token `"*"` = "the web UI on the unlocked IP"); programmatic API callers get a **16-char token** bound to their IP. Auto-logout after `LOGOUT_TIMEOUT`.
- `isProtected(clientIp, token, askedFromWeb)` is evaluated **per request** already — so enforcement is inherently per-call, with a single global lock state. `prot_mask` only hides menu entries (cosmetic).

### 14.2 What the redesign requires (small)

1. **Server-side check stays the source of truth.** Sensitive endpoints call `isProtected` and return **401** when locked — this already happens for control/setup; just make sure the new `/api/*` endpoints do the same. No new per-page logic.
2. **UI hiding is cosmetic only.** The SPA may hide nav items based on the lock state, but never relies on hiding for security.
3. **Don't leak secrets to a locked client.** `/api/meta` and any setup read must **redact** WiFi/MQTT passwords unless the caller is unlocked.
4. **SPA login flow:** `GET /api/auth` → `{ protected, unlocked, mask }`; if `protected && !unlocked`, show login; `POST` password → token; hold token in memory (sessionStorage) and send it on protected calls. The existing IP/`"*"` path keeps working for same-origin convenience.

### 14.3 Explicitly out of scope

Hardening the IP-based session into a cryptographic cookie/token for the web path too (LAN IP spoofing / shared-NAT weakness) is **not** part of this redesign — keep current behavior to avoid breaking anyone. Noted as a possible future item only.

---

## 15. Exact data contracts (+ serializer)

Schema-versioned so the browser can detect mismatch. Field **order is the contract**; the index map lives in `app.js`.

### 15.1 `/api/frame` (steady state, fixed ≤2 KB)

```
{
  "t":  <device epoch, uint32>,
  "v":  1,                       // frame schema version
  "g":  [rssi, heap_free, uptime, Te, flags],
  "iv": [ <per-inverter flat array>, ... ]
}
```

`flags` bitfield: bit0 night-comm active · bit1 mqtt connected · bit2 OTA in progress · bit3 adaptive cadence on. `Te` = current effective RF interval (§12).

Per-inverter array (order fixed):
```
[ status, pl_read, alarm_cnt, rssi, age,                 // 5 scalars (age = t - ts_last_success)
  U_AC,I_AC,P_AC,F_AC,PF_AC,Temp,YieldTotal,YieldDay,P_DC,Eff,Q_AC,MaxPower,MaxTemp,   // ch0 AC, 13
  (U_DC,I_DC,P_DC,YieldDay,YieldTotal,Irradiation,MaxPower) × N_channels ]             // 7 per DC ch
```
Length = `5 + 13 + 7·Nch`. Matches the §1 baseline (41 floats/iv for 4 ch) + 5 scalars. Field names confirmed from device: ch0 = `U_AC,I_AC,P_AC,F_AC,PF_AC,Temp,YieldTotal,YieldDay,P_DC,Efficiency,Q_AC,MaxPower,MaxTemp`; DC ch = `U_DC,I_DC,P_DC,YieldDay,YieldTotal,Irradiation,MaxPower`.

Buffer sizing: `WEB_FRAME_MAX_IV` (default 4) × `WEB_FRAME_MAX_CH` (default 6) → worst case ≈ `4·(5+13+42)·~7 B ≈ 1.7 KB` → **fixed 2 KB**.

### 15.2 `/api/meta` (one-shot, cached by browser)

```
{
  "host","version","build","esp_type","refresh","region","timezone",
  "prot": { "protected":bool, "unlocked":bool, "mask":uint },
  "u_ac":[...], "f_ac":[...],          // AC field units + names (once)
  "u_dc":[...], "f_dc":[...],          // DC field units + names (once)
  "iv": [ { "id","name","serial","gen","max_pwr","enabled","ch_names":[...],"ch_max_pwr":[...] }, ... ]
}
```
Larger but **user-initiated and one-shot**, so still bounded and never in the steady-state path. Secrets redacted per §14.2.3.

### 15.3 Serializer (bulletproof path)

Preferred: **direct flat writer to a chunked/`AsyncResponseStream`** using a small fixed `char` scratch (`snprintf` per number) — no JSON tree, peak heap = response object + scratch. The flat positional shape makes this trivial. Acceptable first cut: `StaticJsonDocument<2048>` (stack/fixed, never `getMaxFreeBlockSize()`). Either way: check `HEAP_FLOOR` and the heavy-op token (§10.3) before building; on failure emit static `{"e":1}` + 503.

---

## 16. Build pipeline & localization (i18n)

- **Asset pipeline unchanged in shape:** `scripts/convertHtml.py` still gzips each asset into a PROGMEM `.h`. The SPA is just fewer, larger files (`app.html`/`app.js`/`app.css`) instead of ~10 pages — net **less** flash (no per-page boilerplate ×10). Flash is not the constraint (app 609 KB / 2.5 MB; FS 24 KB / 1 MB).
- **i18n: keep build-time, single-language bundles.** The project already builds per-language envs (`…-de` → `lang=de` in `convertHtml.py`). Apply the same `{#TOKEN}` substitution to the SPA bundle so each firmware ships exactly one language **baked into the gzipped JS** — **zero runtime heap/CPU cost** on the ESP8266 (preferred over fetching a lang map at runtime). German is preserved automatically.
- Preprocessor `IF_ESP32` / `IF_ENABLE_*` blocks continue to gate optional features in the bundle.

---

## 17. Definition of done / acceptance criteria

**Stability (vs §1 baseline, measured on device):**
- [ ] `/api/frame` peak alloc ≤ 2 KB, constant; `getMaxFreeBlockSize()` removed from the steady-state path.
- [ ] 1 request/refresh; static data sent once via `/api/meta`.
- [ ] No web/MQTT/OTA op consumes the largest free block; all respect `HEAP_FLOOR` + heavy-op token.
- [ ] No ticker callback exceeds the ~50–100 ms time-box under combined load.
- [ ] RF data freshness while a client polls + MQTT publishes ≥ freshness at idle (no regression).
- [ ] Adaptive cadence shortens under good health, backs off under induced loss, never overflows the queue.
- [ ] 24 h soak: no reboot, no `net_diag` dead-link/offline increments, no MQTT reconnect storm.

**Parity & compatibility:**
- [ ] Every item in §11.5 checklist ticked (or consciously dropped, recorded in §18).
- [ ] MQTT topics + HA discovery byte-identical (no entity churn).
- [ ] Legacy `/api/*` endpoints still answer (compat shim) for third parties.
- [ ] Settings round-trip: old config OTA → all fields intact; partition table byte-identical.
- [ ] **Downgrade works:** OTA back to a prior release → boots clean, settings intact, no factory reset (§13.4).
- [ ] Secrets never sent to a locked client.
- [ ] German build verified.

**UX:**
- [ ] Phone-first dashboard usable one-handed; delta rendering, no flicker.
- [ ] Polling pauses when tab hidden / at night.

---

## 18. Open questions & decisions log

**Decided:**
- Scope = full clean-room redesign (diverge from upstream OK). ✔
- Priority = whole-system stability before visuals. ✔
- Targets = ESP8266-primary + phone-first. ✔
- "Links" = integrations (RF/MQTT/NTP/REST/OTA), not GUI hyperlinks. ✔
- Auth = single global lock, not per-page; keep existing `Protection`, SPA hiding is cosmetic. ✔
- Settings migration = read-in-place (keep JSON keys); partition table frozen. ✔
- RF cadence = closed-loop adaptive (gentle up / fast down), `adaptive` toggle default on. ✔
- i18n = build-time single-language bundles. ✔

**Remaining (tune during implementation, not blockers):**
- Exact `T_min` coefficient (≈0.7 s/inverter) and `LOSS_HI/LOSS_LO`, `N_HEALTHY`, `STEP` — calibrate on-device against real RSSI ≈ −75 inverters.
- `HEAP_FLOOR` value (start ~6 KB) — tune from low-water-mark instrumentation.
- How long to keep the legacy `/api/*` shim before deprecation.
- Push (SSE/WS) — deferred; revisit only if heap headroom is proven (§8.5).

---

## 19. OTA hardening

Recent OTA instability traces to **heap contention during the flash**. Today `setOtaActive(true)` (`web.h:132`) only suspends the **WiFi self-heal** (`AhoyNetwork.h:184`, with `OTA_MAX_MS` failsafe auto-expire). It does **not** pause the other heavy heap consumers, which keep running mid-flash on the ~13 KB heap:

- **RF polling** — `tickSend` keeps enqueuing; CommQueue + radio keep allocating.
- **MQTT publishing** — keeps publishing.
- **Web data endpoint** — AsyncWebServer can serve `/api/live` (**12.8 KB doc**) *during* the upload (TCP-callback context) → direct collision with `Update.write`.
- **Web-serial SSE buffer** — held if a serial client is connected.

Plus: **browser uploads skip integrity** — `update.html` never sends `X-MD5`, so MD5 verification only protects CLI (`curl`) uploads; the browser path is size-only.

### 19.1 Improvements (A–E = Phase 0 in §8; shippable now, independent of the redesign)

- **A. OTA = true global quiesce** (biggest win). Extend `setOtaActive`: while OTA is active, data endpoints return `503`, RF polling + MQTT publishing stand down, serial buffer dropped. Frees max heap for `Update.write`, removes the collision window. This *is* the §10.3 quiesce + heavy-op token made real.
- **B. Pre-flight checks before `Update.begin`** — refuse cleanly (stay on current fw) if `free heap < OTA_HEAP_FLOOR` or `Content-Length > free sketch space`. Honest early "no" beats a half-written flash.
- **C. Browser-side integrity** — compute firmware MD5 client-side in the update view and send `X-MD5`, matching the `curl` path. (Flash is not the constraint.)
- **D. Watchdog during slow writes** — writes run *outside* `loop()`'s `esp_task_wdt_reset()`; confirm `runAsync(true)` yields enough, else feed the WDT in the write path so slow flash can't trip the hardware WDT.
- **E. Honest-failure UX** — firmware already does not reboot on a corrupt image (`mUpdateOk`/`Update.end(true)`); the update view must surface "failed, still on old firmware", never a fake success + hung reload.

### 19.2 Out of scope (flagged tradeoff)

- **F. Two-slot / rollback OTA** for power-loss safety: possible on 4 MB ESP8266 but changes the partition table → **wipes LittleFS/settings (§13)** and halves app space. Not recommended unless a one-time settings reset is accepted. Default: no.

### 19.3 Verification

- OTA while a web client polls + MQTT publishes + a serial client is connected → min-free-heap stays above floor; flash completes.
- Corrupt/truncated image (browser and curl) → rejected, device stays on current firmware, UI shows failure.
- Oversized image → rejected at pre-flight with a clear message.
- Power-loss mid-flash recovery behavior documented (single-slot = serial reflash required).
