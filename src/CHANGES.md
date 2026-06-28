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
