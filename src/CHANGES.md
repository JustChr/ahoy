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
