[![CC BY-NC-SA 4.0][cc-by-nc-sa-shield]][cc-by-nc-sa]
[![Ahoy Build][release-action-badge]][release-action-link] [![Ahoy Dev Build][dev-action-badge]][dev-action-link]

This work is licensed under a
[Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License][cc-by-nc-sa].

[![CC BY-NC-SA 4.0][cc-by-nc-sa-image]][cc-by-nc-sa]

[cc-by-nc-sa]: https://creativecommons.org/licenses/by-nc-sa/4.0/deed.de
[cc-by-nc-sa-image]: https://licensebuttons.net/l/by-nc-sa/4.0/88x31.png
[cc-by-nc-sa-shield]: https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg

[release-action-badge]: https://github.com/JustChr/ahoy/actions/workflows/compile_release.yml/badge.svg
[release-action-link]: https://github.com/JustChr/ahoy/actions/workflows/compile_release.yml

[dev-action-badge]: https://github.com/JustChr/ahoy/actions/workflows/compile_development.yml/badge.svg
[dev-action-link]: https://github.com/JustChr/ahoy/actions/workflows/compile_development.yml


# 🖐 Ahoy! — JustChr fork
![Logo](https://github.com/JustChr/ahoy/blob/main/doc/logo1_small.png?raw=true)

A personal fork of [AhoyDTU](https://github.com/lumapu/ahoy) tuned for **one specific setup: an ESP8266 DTU feeding a Hoymiles micro-inverter's data into Home Assistant over MQTT**, on an AVM FRITZ! Mesh network. Upstream AhoyDTU is a general-purpose project supporting many boards; this fork narrows the focus to keep that one path rock-solid.

> **Based on [lumapu/ahoy](https://github.com/lumapu/ahoy)** and licensed under CC BY-NC-SA 4.0. All credit for the original work goes to the AhoyDTU project and its contributors. This fork only repoints links/docs to its own repo and hardens the ESP8266 + Home Assistant path.

## What's different in this fork
- **ESP8266 WiFi self-healing** for FRITZ! Mesh: link-loss backstop watchdog, mesh-aware BSSID handling, no reliance on a nightly reboot (since v0.8.157). See [src/CHANGES.md](src/CHANGES.md).
- **MQTT WiFi diagnostics** (`wifi_reconnects`, `wifi_disc_reason`) for monitoring stability in Home Assistant.
- **Fork-hosted releases & update-check** — the web UI checks `JustChr/ahoy` for new versions and the Downloads link points at this repo's [Releases](https://github.com/JustChr/ahoy/releases/latest).
- A documented, reliable **flashing procedure** for this device — see [manual/Updating.md](manual/Updating.md).

This fork builds the **`esp8266`** environment only. For any other board, use [upstream AhoyDTU](https://github.com/lumapu/ahoy) instead.

## Changelog
[Latest release notes](https://github.com/JustChr/ahoy/blob/main/src/CHANGES.md)

## Getting Started
1. [Guide: start with an ESP module](manual/Getting_Started.md)
2. [Ahoy Configuration](manual/ahoy_config.md)
3. [Building & updating the firmware](manual/Updating.md)
4. [Home Assistant integration](tools/homeassistant/README.md)

## Hardware
| Board | MI | HM | HMS/HMT | comment |
| ----- | -- | -- | ------- | ------- |
| ESP8266 + nRF24L01+, C++ | ✔️ | ✔️ | ❌ | the board this fork targets |

⚠️ **HMS-XXXXW-2T WiFi inverters are not supported** (they have a 'W' in the name and a DTU serial on the sticker).

## Roadmap
See [ROADMAP.md](ROADMAP.md) for planned Home Assistant and ESP8266 stability work.

## Support & issues
Use this repo's [issue tracker](https://github.com/JustChr/ahoy/issues). For the wider community and the original project, see [upstream AhoyDTU](https://github.com/lumapu/ahoy) and its [Discord](https://discord.gg/WzhxEY62mB).

### Related Projects
- [OpenDTU](https://github.com/tbnobody/OpenDTU) — sister project for Hoymiles HM- and HMS-/HMT-series (ESP32 only).
- [hms-mqtt-publisher](https://github.com/DennisOSRM/hms-mqtt-publisher) — for WiFi inverters like HMS-XXXXW-2T.
