Changelog v0.8.178 (JustChr fork)

* UI: UI-redesign Phase 4 - the /app shell grows into a usable phone-first dashboard (still additive; legacy pages untouched and reachable). New solar visual identity (warm light/dark palette, gold accent). #/now is now a sun-disc ring gauge showing live output vs installed capacity, with Today / Capacity / Producing stats; inverter cards are quieter (status, power, one capacity bar) and expand on tap.
* UI: tapping an inverter shows curated stats (voltage, frequency, temperature, efficiency, cos phi) and per-string cards (power + bar vs string max + V/A/today) instead of a raw field dump, plus on-demand tabs: Info (firmware/hardware), Alarms, Radio stats, and Grid profile (decoded against grid_info.json, same scheme as the legacy page).
* UI: inverter controls in the SPA (on/off, restart, power-limit persistent/non-persistent x relative/absolute) and a DTU reboot, gated by the existing global lock (login/logout); #/system gains Network / Diagnostics / Radio / MQTT / Memory tiles from /api/system.
* Heap: fix web-path heap fragmentation regression on ESP8266. /api/frame now streams its flat JSON straight to the socket instead of building a ~3 KB JsonDocument every poll, so the dominant recurring transient is gone (measured: largest free block ~8.7 -> ~13.1 KB, fragmentation ~28 -> ~12 % after load). Legacy /api/* keep the per-endpoint tiered document sizing from the prior fix.
* Heap: permanent, cheap watermarks (since-boot minimum free heap, minimum largest block, maximum fragmentation) exposed in /api/system and shown in the #/system Memory tiles, so web-path heap regressions stay visible.
* Build: convertHtml.py now reads/writes all web sources and lang.json as UTF-8 explicitly. Local Windows builds previously misread UTF-8 glyphs/umlauts as cp1252 (e.g. a chevron rendering as "a-euro"); local builds now match the Linux CI byte-for-byte.

Changelog v0.8.172 (JustChr fork)

* UI: new single-page web app (UI-redesign Phase 3) served additively at /app. The existing pages are untouched and stay the default - /app is a parallel, phone-first shell so it can be tried side-by-side and only becomes the default once it's proven (Phase 4). It loads once, hash-routes between views (#/now dashboard, #/system tiles) with no page reloads, and renders by mutating only the changed text/bars each frame (no flicker, minimal CPU).
* UI: the new shell consumes only the bounded Phase 1 endpoints - /api/meta once (static, cached) then /api/frame on a timer - with all the browser-side bulletproofing: one request in flight at a time (never stacks), keeps the last good frame and dims it on error instead of blanking, widens the poll interval on repeated failure (5->15->30 s) and snaps back, pauses entirely when the tab is hidden and slows to 30 s when every inverter is off. Self-contained light/dark theme (toggled client-side, remembered) with no extra request.
* UI: #/now shows total AC power + today's yield up top and a responsive card per inverter (producing/idle/offline/disabled status dot, per-channel power bars vs configured max); #/system shows live RSSI / free heap / uptime / effective RF interval / MQTT / adaptive-RF tiles from the frame. Localised via the existing build-time pipeline (English + German verified). (~7 KB flash, no measurable RAM change)

Changelog v0.8.171 (JustChr fork)

* RF: adaptive inverter poll cadence (UI-redesign Phase 2). The fixed send interval is now a ceiling, not a constant - a closed-loop controller polls as fast as the RF link safely allows and backs off the instant it can't. Effective interval Te moves within [T_min, sendInterval]: T_min = max(3 s, ceil(N_inverters x 0.7 s)) or an explicit override. Stability-first AIMD - it halves the interval immediately when the send queue fills (>80 %), retransmit/loss rate spikes (>25 %), or free heap nears the floor, and only speeds up by a small step after two consecutive healthy cycles (hysteresis, so it can't oscillate). When healthy this makes inverter data - and event-driven MQTT - up to several times fresher than the old fixed 15 s, never slower. New backpressure: when the queue is hot the round is skipped entirely instead of piling on (previously it only warned).
* RF: new "adaptive RF cadence" setting (on by default) and optional T_min override under instance settings. Turning it off restores exactly the previous fixed-interval behaviour. Settings are additive (no config-version bump) so flashing back to an older firmware keeps every setting intact.
* API: /api/frame now reports the live effective interval Te and an "adaptive on" flag, so the controller is observable (watch Te shorten on a good link and stretch under induced loss). (negligible RAM/flash cost)

Changelog v0.8.170 (JustChr fork)

* OTA: fix ESP8266 OTA that silently reverted to the old firmware ("OTA success" but no upgrade) since 0.8.159. Root cause: the bootloader's `eboot_command` (which tells eboot to apply the staged image) lives at the very start of RTC user memory, and the 0.8.159 network diagnostics wrote to `rtcUserMemoryWrite(0, ...)` - the same bytes - clobbering the command's magic/CRC during the post-OTA reboot window, so eboot found no valid command and booted the running image. NetDiag now uses RTC offset 32, clear of the 32-dword command. This is the actual fix for the OTA failures the 0.8.161-163 hardening was chasing.
* OTA: fix a hard crash mid-upload on ESP8266 (`Panic __yield`, core_esp8266_main.cpp:191). The 0.8.163 watchdog-feed called `yield()` from the AsyncTCP upload callback, which runs in the SDK (SYS) context where yield()/delay() are forbidden and panic. Replaced with `ESP.wdtFeed()`, which services the watchdog without the illegal context switch.
* OTA: stage the new image using its actual size instead of the whole free sketch space, so the staged copy lands clear of the running (~600 KB) sketch with margin instead of one sector above it.

Changelog v0.8.163 (JustChr fork)

* OTA: turn the update into a true global quiesce so the flash has the ~13 KB heap to itself. While an update is in flight the firmware now stands down every other heap/CPU co-tenant: RF inverter polling pauses, the MQTT pump pauses, the web data API (/api/*) answers a tiny static 503 instead of allocating a multi-KB JSON doc in a TCP callback (the old collision that could grab heap out from under the flash), and the web-serial buffer is dropped. All gated on the existing OTA-active flag, which already self-expires after 5 min so nothing can get stuck paused.
* OTA: pre-flight the image before touching the flash - refuse cleanly (and stay on the current firmware) if free heap is below a safe floor or the upload is larger than the free sketch space, instead of half-writing a sketch that bricks until a serial reflash.
* OTA: the browser update page now computes the firmware MD5 client-side and sends it as X-MD5, so a corrupt/truncated browser upload is rejected end-to-end exactly like the curl path (previously only curl could send the hash). Falls back to the size check if hashing fails.
* OTA: feed the watchdog during slow flash writes (the upload runs in a network callback, outside the main loop's watchdog reset) so a slow sector write can't trip a reset mid-image.
* OTA: honest failure in the browser - the update page now reads the HTTP status and shows "failed - still running the previous firmware" on a real failure, instead of always claiming success and reloading. (negligible RAM/flash cost)

Changelog v0.8.162 (JustChr fork)

* OTA: pause the WiFi self-heal while an update is in flight. A slow upload starves the main loop and silences the MQTT heartbeat, which the 0.8.159/160 "associated but dead" watchdog mistook for a dead link - it would disconnect (159) or even reboot (160) the DTU mid-flash, truncating the image (the silent rollbacks 0.8.161 then surfaced as honest failures). The /update handler now flags an OTA active on the first chunk so neither the dead-link re-associate nor the offline-reboot can fire during the transfer; the flag clears on failure (success reboots anyway) and self-expires after 5 min as a failsafe against a dropped upload. (no measurable RAM/flash cost)

Changelog v0.8.161 (JustChr fork)

* OTA: harden the web update so it can't silently "succeed" then roll back. The old handler sized the update to free flash and called Update.end(true) (commit even if incomplete), reporting success from !hasError() - so a truncated/corrupt upload was committed and then rejected by the bootloader at boot, with no visible error. Now: (1) if the client sends an X-MD5 header the image is verified end-to-end and a mismatch fails the update before commit; (2) "success" and the reboot are gated on Update.end() actually finalizing a whole image - a failed OTA stays on the current firmware instead of bouncing; (3) all OTA status (start / success+bytes / failure reason) goes through the debug log so it shows on the web /serial console. Flash with curl ... -H "X-MD5: <md5>" to use the integrity check.

Changelog v0.8.160 (JustChr fork)

* WiFi: fix the "associated but dead" self-heal that stayed blind during a real 209-min outage. The 0.8.159 detector gated on mqtt.connected(), but on a half-open socket (mesh node associated, backhaul gone) the async MQTT client reports connected the whole time, so it never fired (dead_link_cnt stayed 0). Liveness is now a true broker round-trip: the per-minute uptime publish is sent at QoS1 and only its PUBACK refreshes the watchdog. No round-trip for ~4 min while associated -> forced re-associate; if that doesn't restore the round-trip, escalate to a reboot. Worst-case recovery ~209 min -> ~4-10 min. (no new MQTT topic; negligible RAM/flash)

Changelog v0.8.159 (JustChr fork)

* WiFi: detect "associated but dead" mesh links (WiFi.status() stays connected but the mesh node's backhaul is gone) using MQTT as a liveness signal, and force a single rate-limited re-associate to re-home onto a live node (no reboot loop)
* Diagnostics: persistent network counters in RTC memory that survive watchdog reboots (boot count, cumulative wifi reconnects, offline-reboot count, dead-link recoveries, last offline duration, last disconnect/reset reason); exposed via /api/system (net_diag) and MQTT (+ HA discovery: wifi_reconn_total, offline_reboots, last_offline_dur)

Changelog v0.8.158 (JustChr fork)

* MQTT: auto-discover the DTU's own WiFi/system diagnostics in Home Assistant (uptime, RSSI, free heap, heap fragmentation, wifi_reconnects, wifi_disc_reason, IP, version) as a separate <name>_DTU device with entity_category diagnostic
* docs/links: re-homed to JustChr/ahoy (web UI, README, manual); new manual/Updating.md and ROADMAP.md

Changelog v0.8.157 (JustChr fork)

* ESP8266 WiFi: self-heal from drops without the nightly reboot; cooperate with FRITZ! Mesh steering (no modem sleep, state-machine owns reconnects, link-loss + offline-reboot watchdogs, BSSID deprioritization)
* MQTT diagnostics: wifi_reconnects, wifi_disc_reason
* web update page: XHR upload with progress + error reporting (no more silent hang); Downloads link points to this fork's GitHub releases
* CI: build/release on this fork; releases also attach the raw esp8266 .bin

Changelog v0.8.156

* add HMS1000-2T with leading 1410 serial number #1845

This fork tracks upstream [lumapu/ahoy](https://github.com/lumapu/ahoy); for the full upstream version log see its [Development Log](https://github.com/lumapu/ahoy/blob/development03/src/CHANGES.md).
