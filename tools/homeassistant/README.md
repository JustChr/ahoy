# HomeAssistant Examples

## Recommended: MQTT auto-discovery

This fork's firmware publishes Home Assistant MQTT discovery configs for you. Enable
**MQTT discovery** on the DTU (Settings → MQTT) and press **Send discovery config** — HA
then creates all inverter entities automatically, with no YAML. The `manual.yaml` /
`dashboard.yaml` examples below are the older hand-config approach and are only needed if
you don't use discovery (note: their fixed entity names won't match discovery-generated
ones, which are named after your inverter).

### DTU diagnostics (WiFi / system)

Since v0.8.158 the DTU also auto-discovers its **own** diagnostics as a separate device
named after the DTU (entity_category *diagnostic*): `uptime`, `wifi_rssi`, `free_heap`,
`heap_frag`, `wifi_reconnects`, `wifi_disc_reason`, `ip_addr`, `version`. These appear
automatically once discovery is sent — useful for watching FRITZ! Mesh stability.

To put the WiFi-stability metrics on a dashboard (replace `ahoy_dtu` with your DTU's
entity prefix if you renamed it):

```yaml
type: entities
title: DTU WiFi health
entities:
  - entity: sensor.ahoy_dtu_wifi_reconnects
  - entity: sensor.ahoy_dtu_wifi_disc_reason
  - entity: sensor.ahoy_dtu_wifi_rssi
  - entity: sensor.ahoy_dtu_free_heap
  - entity: sensor.ahoy_dtu_heap_frag
  - entity: sensor.ahoy_dtu_uptime
```

## Legacy manual examples

Disclaimer: these are collected examples from https://www.mikrocontroller.net/topic/525778 (Page 12)

in manual.yaml you will find the setup for manual configuration, adapt your name (Terrasse) and the topic (inverter) to your needs and place it into configuration.yaml

in autodiscovery.yaml you will find the setup for automatic discovery of the inverter

in dashboard.yaml you will find the raw configuration of a dashboard:
![Dashboard Image](https://raw.githubusercontent.com/JustChr/ahoy/main/tools/homeassistant/HomeAssistantDashboardAhoy.png)

Note: the config might need adaption to your system (mqtt, homeassistant etc)
