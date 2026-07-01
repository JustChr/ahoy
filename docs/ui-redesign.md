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
- [x] **D. Watchdog during slow writes** — verify/feed WDT in the write path (runs outside `loop()`). — *⚠️ CORRECTED: an early build used `yield()` per chunk — **illegal in the AsyncTCP/SYS callback context, panics `__yield`** and crashed every OTA (0.8.163–165). Fixed 0.8.167: use `#ifndef ESP32 ESP.wdtFeed()`, **never** `yield()`/`delay()` here.*
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

- [x] Closed-loop controller (§12) replacing fixed `sendInterval`; `adaptive` toggle (default on), `T_min`/`T_max` bounds. — *`app::rfCadenceCtrl(fill,maxFill)` runs once per poll inside `tickSend`, recomputes `mRfTe ∈ [T_min, T_max=sendInterval]` and re-arms "tSend" via new `Scheduler::setReloadByName()` (clamps pending timeout down so speed-ups apply next fire). AIMD: `Te*2` back-off on overload, `Te-RF_STEP_S` speed-up after `RF_N_HEALTHY` healthy ticks. Inputs: queue fill %, loss% from `radioStatistics.{retransmits,rxFail}/txCnt` deltas, `ESP.getFreeHeap()` vs `RF_HEAP_FLOOR`. Tunables in `config.h`. Settings: `inst.rfAdaptive`(default on)+`inst.rfTmin`(0=auto) — additive JSON keys `rfAdpt`/`rfTmin`, no `CONFIG_VERSION` bump, downgrade-safe (§13.4).*
- [x] Hard backpressure (skip enqueue on full queue). — *`rfCadenceCtrl` returns true when `fill% > RF_FILL_HI_PCT` → `tickSend` skips the enqueue loop this round (was warn-only).* **[~] per-inverter slow-probe for offline units deferred** — global cadence already adapts; `sendIv` skips disabled/night inverters. Per-iv probe scheduling is a refinement, not load-bearing for the core controller.
- [x] Expose `Te` + adaptive flag in `/api/frame` `g[]`. — *`g[3]=getRfInterval()` (live Te), `g[4]` flags bit3=adaptive on. `net_diag` exposure deferred (frame `g[]` already makes the controller observable for §10.4 verification).*
- *Exit criteria: §10.4 — cadence shortens when healthy, backs off under induced loss, no queue overflow; MQTT freshness improves per §12.5 without destabilising.* **HEALTHY-LINK ARM VERIFIED LIVE (2026-07-01, device on v0.8.178, `ahoy.home.arpa`, 2 inverters producing @ RSSI ≈ −67):** sampled `/api/frame` `g[3]` (Te) every 11 s for ~2 min — adaptive flag stayed on (`g[4]` bit3), Te actively adapted `5 s → 3 s` (reached `T_min = max(3, ⌈2×0.7⌉) = 3 s`) after healthy ticks, then AIMD-backed-off to 5 s and oscillated, **always bounded in [T_min 3 s, T_max 15 s]**, both inverters stayed status 2, free heap steady ~14.4–15.4 KB (no drift). Confirms speed-up-when-healthy + bounded + non-destabilising. **Still open (needs physical access):** induced-loss back-off arm and 24 h soak.

### Phase 3 — SPA shell + delta rendering (UI foundation)

- [x] `app.html`/`app.js`/`app.css` shell, hash routing, single-in-flight + backoff (§4, §5). — *Standalone shell served **additively** at `/app` (legacy `/` untouched until Phase 4). `#/now` + `#/system` are SPA views; setup/history/serial/update link out for now. Self-contained light/dark (both palettes in `app.css`, localStorage toggle, no `/colors.css` fetch). Data layer hits Phase 1 `/api/meta` (once) + `/api/frame` (timer): single in-flight, `AbortController` timeout, backoff `5→15→30s`.*
- [x] Delta DOM updates; pause on hidden/night. — *Cards built once on meta load; frames mutate only text nodes + bar widths (no `replaceChildren`). Pause on `document.hidden`; slow `30s` poll when all inverters OFF (night proxy — real sunrise/sunset not yet in `/api/meta`, deferred). Stale-tolerant: last good frame kept + dimmed with age on error/503.*
- [x] Per-language build bundles (§16); auth = global lock, UI hiding cosmetic (§14). — *`window.T={#APP_*}` in `app.html` (build i18n runs on `.html` only; `app.js` reads chrome labels from it). `lang.json` `"app.html"` entry, 15 tokens en+de; `-de` build verified (bakes German, no leftover tokens). `/app` honours `PROT_MASK_INDEX`; no secrets in shell — gating stays server-side per `/api` call.*
- *Exit criteria: navigation instant, no flicker, German build verified.* **Builds clean (esp8266 RAM 62.8 % unchanged, Flash 58.7→59.4 % ≈ +7 KB; esp8266-de clean). On-device runtime verification of `/app` still pending.**

### Phase 4 — Phone-first dashboard + view migration

> **Strategy (decided 2026-06-30): ADDITIVE migration, keep legacy as the safety net.** Per the user's "must not lose old UI functionality" constraint, no standalone page is removed until its SPA replacement is verified at §11.5 parity. Legacy `/`, `/setup`, `/history`, `/serial`, `/update` stay fully reachable throughout Phase 4. Page *retirement* is the final step, gated on the parity checklist — not done incrementally.

- [~] **Slice 4a — dashboard polish + system/diag tiles (DONE, client-side only).** `#/now`: tap an inverter card to expand a full AC+DC field table (labelled from `meta.f_ac/u_ac` + `meta.f_dc/u_dc`, one card open at a time, delta-updated while open). `#/system`: grouped stat tiles — **Live** (from steady-state `frame.g[]`, keeps updating) + on-demand **Network / Diagnostics / Radio / MQTT / Memory** from a single `/api/system` fetch on view entry (`loadSystem`, single in-flight, keeps last good on error). Zero firmware-contract change (`/api/system` already existed); purely additive `app.{html,css,js}` + `lang.json` (17 new `APP_*` tokens en+de). Builds clean esp8266 (RAM 62.8 % unchanged, Flash 59.4→59.6 % ≈ +2 KB) + esp8266-de (German baked, 0 leftover tokens, verified by decompress). **Not yet committed/flashed.**
- [~] **Slice 4b — inverter controls (DONE, client-side).** Expanded card now has a controls block (when unlocked): On/Off (`cmd power` val 1/0), Restart (`cmd restart`, confirm), and a power-limit form — number + `%`/`W` toggle + `persistent` checkbox → `cmd limit_{persistent|nonpersistent}_{absolute|relative}`, val=number. POST `/api/ctrl` via `sendCtrl()` (adds `id`+`token`); transient toast on result. System view gained a **Reboot DTU** action (reuses the legacy `/reboot` route, same as system.html). All endpoints pre-exist; no firmware change.
- [~] **Slice 4b-auth — SPA login/logout (DONE, client-side).** `loadAuth()` reads `/api/auth`; when `protected && !unlocked` a login bar (in `<main>` above `#view`) takes a password → `POST /api/ctrl {auth}` → token held in `sessionStorage` (`doUnlock`). Controls are hidden while locked (cosmetic; server still enforces — `sendCtrl` re-locks the UI on an `AUTH/PROT` error). Logout button in system view clears the token. Covers §11.5 login/logout. Reference device has `pwd_set=false` → nothing locked, controls always shown.
- [~] **Slice 4d-readonly — on-demand Info/Alarms/Radio (DONE, client-side).** Expanded card has three tabs that fetch on click: **Info** (`/api/inverter/version/N` → firmware/hw/part/prod KV table), **Alarms** (`/api/inverter/alarm/N` → code+text rows, "No alarms" when empty), **Radio stats** (`/api/inverter/radiostat/N` → rx/tx/loss/retransmit KV). Covers §11.5 alarm history + firmware-version readout + radio statistics. Read-only, additive.
- *Builds clean (4a+4b+4d together): esp8266 RAM 62.8 % unchanged, Flash 59.4→59.9 % ≈ +5 KB total; esp8266-de German baked, 0 leftover tokens. **Not yet committed/flashed.***
- [x] **Slice 4c — native settings/config view (DONE, client-side).** `#/settings` rebuilds the esp8266 config form natively in `app.js` (collapsible sections: System, Network, Protection, Inverters, NTP, Sun, MQTT, Pinout/NRF24, Serial console). **SAFETY BY CONSTRUCTION:** the form carries the *exact same input `name`s* the legacy `/save` handler reads and POSTs urlencoded to `/save` — byte-identical to the legacy submission (any missing field would clobber NRF/LED pins to GPIO0). Every field is populated from `/api/setup`; `pwd`/`adminpwd` keep the `{PWD}` "unchanged" sentinel. Per-inverter edit uses the same `save_iv` JSON to `/api/setup` (incl. `convHerf` for A-serials). NTP set/sync, MQTT HA-discovery, settings export (`/get_setup`) + import (multipart `/upload`) + factory-reset (`/erase`) all reuse the legacy endpoints. Scoped to the shipped esp8266 feature set (no CMT/ethernet/display — those are stripped from the legacy form too, verified against processed `tmp/setup.html`).
- [x] **Slice 4e — web-serial + OTA upload (DONE, client-side).** `#/serial` = native console over the `/events` EventSource (`<rn>`→newline, bounded 60 KB buffer, autoscroll/clear/copy, `serial_utc_offset` POST). `#/update` = faithful port of `update.html`'s OTA upload: **verbatim bluimp MD5 → `X-MD5`** for end-to-end integrity, env-mismatch/dev-version guard, XHR progress, and the subtle success-on-socket-drop-after-upload semantics (a drop *after* all bytes sent = device rebooted = success). **First-run wizard intentionally NOT ported** — it runs in AP setup mode where the SPA's data endpoints have no data; legacy `/wizard` stays. History charts still skipped (shipped `esp8266` env has no `-DENABLE_HISTORY`).
- [x] **§11.5 parity checklist audited (see §11.5).** SPA now covers all config sections, inverter/per-string config, all controls, serial, OTA, login/logout, grid-profile/alarms/radio/version. Conscious legacy-only keeps: **about** (cosmetic credits), **first-run wizard** (AP-mode onboarding). MQTT/HA discovery + REST + Prometheus contracts untouched.
- [ ] **Retire standalone pages** — STILL GATED on **on-device verification** of the native settings-save round-trip + OTA (cannot be tested off-device from the build host; user flashes + verifies). Until then legacy `/`, `/setup`, `/serial`, `/update`, `/wizard`, `/about` remain served as the safety net (nav no longer surfaces them from `/app`). This is the documented additive gate, not an oversight.
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

> **Audit (2026-07-01, v0.8.179, esp8266 SPA `/app`).** `[x]` = ported to SPA; `[N/A]` = not in shipped esp8266 build; `[legacy]` = consciously kept only on the standalone page (see Phase-4 notes).

Views: [x] dashboard (`#/now`) [x] live (`#/now` expanded field table) [N/A] history/charts (no `-DENABLE_HISTORY`) [x] web-serial (`#/serial`) [x] setup (`#/settings`) [x] system/diag (`#/system`) [x] update/OTA (`#/update`) [legacy] about [x] login/logout [legacy] first-run wizard (AP-mode onboarding)

Controls / functions: [x] power-limit (persistent/nonpersistent × relative/absolute) [x] inverter on/off [x] inverter restart [x] DTU reboot [x] grid-profile decode (`grid_info.json`) [x] alarm history [x] radio statistics [x] firmware-version readout [x] night-comm pause (sun) [x] scheduled midnight reboot [x] zero-values-on-unavailable [x] yield-day correction / module config [x] settings export/import [N/A] coredump download (ESP32) [x] custom nav link (configurable in `#/settings`; SPA nav intentionally minimal)

Config sections: [x] sys/device/timezone/region [x] password protection [x] network/ip [N/A] eth [x] nrf24 [N/A] cmt (ESP32) [x] ntp [x] sun [x] serial/debug [x] led [x] mqtt + HA discovery [x] inst (sendInterval/retries/reset) [N/A] display plugin [x] per-inverter config

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

**OBSERVED REGRESSION + FIX (2026-07-01, device on v0.8.178).** The coupling above bit in practice: user reported "regular dropouts". Live diag (`/api/system`) showed `reboot_reason = "Software Watchdog"`, `boot_cnt = 22`, and MQTT `tx_cnt` climbing **~17 msg/s** (full ~40-field set × 2 iv on every ~3 s adaptive receive), fragmenting the 14 KB heap (frag 2→12 %, `blk_min` 14376→12512) until a publish drain stalled `loop()` past the soft-WDT (~3 s) → reboot (~13 s offline each = the "dropouts"). **User's insight: don't need every field fresh — only per-inverter power + total power.** Fix (v0.8.180, `pubMqtt.h::payloadEventListener` + new `publishHotPower`): in event-driven mode (`interval==0`) publish only the **hot power topics** (`<name>/ch0/P_AC` + `total/P_AC` — the *same* topics, no new ones, HA-transparent) on every receive, and throttle the **full field-set** to `MQTT_LIVE_FULL_S = 15 s`. Forced/`nullptr` recalc triggers + availability changes still publish the full set immediately. Cuts steady-state MQTT ~17/s → ~6/s while keeping power fresh at the fast RF cadence. Builds clean; **needs on-device confirmation the WDT reboots stop.** Immediate no-reflash mitigation offered to user: set `mqtt.interval = 15`.

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

> **⚠️ Root-cause update (post-0.8.170).** The original hypothesis below — that OTA failures were *heap contention during the flash* — was **wrong as the primary cause**. Serial capture proved two unrelated bugs (§19.4): an illegal `yield()` in the write handler (panic) and an RTC offset-0 collision that clobbered the eboot apply command (silent revert). The heap-quiesce work (A) is still valid hardening, but it did **not** fix the failures. Keep the §19.4 findings authoritative over the heap framing here.

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
- **D. Watchdog during slow writes** — writes run *outside* `loop()`'s `esp_task_wdt_reset()`; feed the WDT in the write path with **`ESP.wdtFeed()`** so slow flash can't trip the hardware WDT. ⚠️ **Never `yield()`/`delay()` in this handler** — it runs in AsyncTCP/SYS context and panics (`__yield`). See §19.4.
- **E. Honest-failure UX** — firmware already does not reboot on a corrupt image (`mUpdateOk`/`Update.end(true)`); the update view must surface "failed, still on old firmware", never a fake success + hung reload.

### 19.2 Out of scope (flagged tradeoff)

- **F. Two-slot / rollback OTA** for power-loss safety: possible on 4 MB ESP8266 but changes the partition table → **wipes LittleFS/settings (§13)** and halves app space. Not recommended unless a one-time settings reset is accepted. Default: no.

### 19.4 Post-mortem — actual root cause (0.8.165→170)

The "OTA succeeds (HTTP 200, MD5 ok, `end(true)`) but reboots back to the old firmware" failures were **not** heap, size, partition, or offsets. Two distinct bugs, both found only via a 115200 serial capture of the post-OTA boot:

1. **Illegal `yield()` in the upload handler.** The Phase-0 item-D `yield()` per `Update.write` chunk runs in the **AsyncTCP/SYS context** and panics (`__yield`, `core_esp8266_main.cpp:191`) → OTA crashed mid-upload (HTTP 000 ~9.4 s). **Fix (0.8.167):** `#ifndef ESP32 ESP.wdtFeed()`. **Rule: never `yield()`/`delay()` in an AsyncTCP callback.**
2. **RTC offset-0 collision (the silent revert).** ESP8266's eboot apply command (`eboot_command`) lives at the **start of RTC user memory** (32 dwords @ `0x60001200`). `Update.end()` writes it there to tell the bootloader to apply the staged image. ahoy's **NetDiag (added 0.8.159 — exactly when OTA broke)** wrote diagnostics via `ESP.rtcUserMemoryWrite(0,…)` = offset 0, clobbering the command during the 3 s post-OTA reboot window. eboot then read no valid command (`~`) and booted the **old** image. **Fix (0.8.169):** `NETDIAG_RTC_OFFSET = 32`. Confirmed: OTA 169→170 applied cleanly over WiFi after 5+ deterministic reverts.

**Standing rules for any future RTC/OTA change (enforce):**
- Never `ESP.rtcUserMemoryWrite/Read` at offset < 32 — keep all app RTC data past the 32-dword eboot_command.
- Never `yield()`/`delay()` in the OTA write handler / any AsyncTCP callback — use `ESP.wdtFeed()`.
- When OTA "succeeds but reverts," capture serial @115200 on the post-OTA boot: `@`/`cp:` = applying, `~` = no valid command (clobbered) → distinguishes apply-failure from a bad image.
- Serial gotcha: this CH340 board has inverted DTR — hand-rolled pyserial `dtr=False` forces UART download mode (`boot mode:(1,6)`, looks dead). Use `pio device monitor`/esptool; recover with a power cycle.

### 19.3 Verification

- OTA while a web client polls + MQTT publishes + a serial client is connected → min-free-heap stays above floor; flash completes.
- Corrupt/truncated image (browser and curl) → rejected, device stays on current firmware, UI shows failure.
- Oversized image → rejected at pre-flight with a clear message.
- Power-loss mid-flash recovery behavior documented (single-slot = serial reflash required).
