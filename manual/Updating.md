# Building & Updating the firmware (ESP8266)

This fork targets a single device: an **ESP8266 DTU** on a FRITZ! Mesh network. This page documents
the build and the *reliable* flashing path for that device. Replace `<dtu-ip>` with your DTU's IP
(e.g. `10.0.0.129`).

## TL;DR
```bash
# build
C:\Users\chris\.platformio\penv\Scripts\platformio.exe run -e esp8266 -d "<repo>\src"
# output: src/.pio/build/esp8266/firmware.bin   (~585 KB, ~3 min clean build)

# flash (recommended — see why below)
curl.exe -m 240 --no-keepalive --limit-rate 30k \
  -F "update=@<repo>\src\.pio\build\esp8266\firmware.bin" \
  http://<dtu-ip>/update

# verify after reboot
curl.exe http://<dtu-ip>/api/system   # check generic.version / build
```

## Flashing options

### Option A — curl (recommended for this device)
```
curl.exe -m 240 --no-keepalive --limit-rate 30k -F "update=@firmware.bin" http://<dtu-ip>/update
```
- **`--limit-rate 30k` is required.** At full speed the upload resets mid-transfer (curl exit 56,
  around 450–520 KB) because the heap-starved ESP8266 can't erase/flash sectors fast enough.
  Throttled to ~30 KB/s it completes in ~19 s with `Update: success / rebooting`.
- curl ignores the filename, so **no renaming is needed** — a plain `firmware.bin` is fine.
- The PC must be on the same LAN as the DTU.

### Option B — browser `/update` page
The web update page now does an XHR upload with a progress bar and surfaces errors (it no longer
hangs silently). It works, but it **cannot throttle**, so a full-speed browser upload may still reset
mid-transfer on this heap-limited device. Prefer curl.

> **Filename gotcha (browser only):** `update.html` parses the filename in JS as
> `fw.split("_")[2].split(".")`. A plain `firmware.bin` has no underscores → it throws → the
> Update button silently does nothing. For the browser the file must be named like
> `YYMMDD_ahoy_X.Y.Z_<sha>_esp8266.bin` (it must end in `esp8266.bin`; a minor version of `9` is
> blocked). curl avoids all of this.

## Safety / rollback
- OTA is **transactional**: a failed or partial upload leaves the existing firmware untouched.
- **Settings survive OTA** — they live in a separate LittleFS partition (`CONFIG_VERSION` in
  [src/config/settings.h](../src/config/settings.h)). You can roll back by flashing an older `.bin`,
  as long as that build's `CONFIG_VERSION` is unchanged.

## Release flow (maintainer)
Releases are automated by GitHub Actions on this fork:
1. Bump `VERSION_MAJOR` / `VERSION_MINOR` / `VERSION_PATCH` in [src/defines.h](../src/defines.h).
2. Push to `main`.
3. `compile_release.yml` builds the `esp8266` env, tags `ahoy_vX.Y.Z`, and publishes a GitHub Release
   with both the zip **and** the raw `esp8266` `.bin` as a direct download.
   A release fires **only when the version in `defines.h` changes**.
4. The web UI "Downloads" link and the "new version available" check both point at
   [`JustChr/ahoy` releases](https://github.com/JustChr/ahoy/releases/latest).

Non-`main` branches and PRs run `compile_development.yml` (build-only, no release).
