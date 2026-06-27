# Roadmap

This fork exists to keep one setup solid: **ESP8266 DTU → MQTT → Home Assistant** on a FRITZ! Mesh.
Items below are planned, not yet implemented. Priority order, top = next.

## 1. Home Assistant integration
- **Audit MQTT topics vs. the HA examples.** Compare what the firmware actually publishes
  (`src/publisher/pubMqtt*.h`) against [tools/homeassistant/](tools/homeassistant/)
  (`autodiscovery.yaml`, `manual.yaml`, `dashboard.yaml`). The example YAML predates this fork and
  likely drifts from current topics/units.
- **Expose the new WiFi diagnostics in HA.** `wifi_reconnects` and `wifi_disc_reason` (added in
  v0.8.157, defined in `src/publisher/pubMqttDefs.h`) should appear as HA sensors so stability is
  trendable. Add them to the dashboard/manual YAML and verify they flow through MQTT discovery.
- **Refresh the dashboard.** Update `dashboard.yaml` and the screenshot
  (`HomeAssistantDashboardAhoy.png`) to the current entity set; the README image now points at this
  fork's raw path.
- **Goal: zero-YAML setup.** Evaluate the firmware's MQTT auto-discovery coverage so a fresh HA
  install gets all entities (power, energy, per-string, inverter status, WiFi diagnostics) without
  hand-written YAML. Document any gaps that still need `manual.yaml`.

## 2. ESP8266 stability & heap
- **Watch the WiFi metrics, then retire the nightly reboot.** v0.8.157 kept the GUI
  `sys.schedReboot` as a backstop. After observing `wifi_reconnects` / `wifi_disc_reason` in HA over
  enough mesh-roaming events, decide whether to disable it.
- **Heap visibility.** Consider publishing largest-contiguous-free-block as an MQTT metric — heap
  fragmentation (not CPU) is the scarce resource here, and a trend line would catch slow leaks before
  they cause a crash/reconnect.

## 3. Build & release ergonomics
- **Browser-OTA-friendly release filename.** Name the released `.bin` like
  `..._esp8266.bin` so the web `/update` page's filename parser accepts it and the browser flash path
  works without curl. (See the filename gotcha in [manual/Updating.md](manual/Updating.md).)
- **Auto-generate release notes** from `src/CHANGES.md` in `compile_release.yml`.

## Out of scope
- Other boards (ESP32, Ethernet). This fork builds `esp8266` only; use
  [upstream AhoyDTU](https://github.com/lumapu/ahoy) for anything else.
- Changing the WiFi/router configuration — the firmware must cope with the existing FRITZ! Mesh.
