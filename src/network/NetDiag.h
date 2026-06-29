//-----------------------------------------------------------------------------
// 2024 Ahoy, https://ahoydtu.de
// Creative Commons - https://creativecommons.org/licenses/by-nc-sa/4.0/deed
//-----------------------------------------------------------------------------

#ifndef __NET_DIAG_H__
#define __NET_DIAG_H__

#include <Arduino.h>
#include <string.h>

// Persistent network diagnostics kept in RTC user memory. RTC user RAM survives
// the software/watchdog reboots that the WiFi self-heal performs (it is only
// cleared by a cold power-on), so the *history* of a connectivity incident is
// preserved instead of being wiped on every reboot. No flash wear.
struct netDiag_t {
    uint32_t magic;
    uint16_t bootCnt;          // boots since cold power-on
    uint16_t reconnTotal;      // cumulative WiFi reconnect cycles across reboots
    uint16_t offlineReboots;   // times the offline-reboot watchdog fired
    uint16_t deadLinkCnt;      // "associated but dead" recoveries (Phase B)
    uint16_t lastOfflineDur;   // seconds offline during the most recent incident
    uint8_t  lastDiscReason;   // last WiFi disconnect reason code
    uint8_t  lastResetReason;  // ESP reset reason of the most recent boot
    uint32_t crc;
};                             // 20 bytes, 4-byte aligned (RTC needs multiple of 4)

#define NETDIAG_MAGIC 0xA40D1A60

// RTC user-memory offset (in 4-byte blocks). MUST stay clear of the ESP8266 OTA eboot_command,
// which the Updater writes as 32 dwords at the very start of RTC user memory (RTC_MEM
// 0x60001200). Writing at offset 0 (the old behaviour, 0.8.159) clobbered the eboot_command's
// magic/CRC during the post-OTA reboot window, so the bootloader rejected the staged image and
// silently reverted to the running firmware ("OTA success" but no upgrade). Offset 32 sits past
// the 32-dword command in either RTC base mapping. This broke OTA on ESP8266 from 0.8.159 on.
#define NETDIAG_RTC_OFFSET 32

class NetDiag {
    public:
        void begin(uint8_t resetReason) {
            if(!load()) {
                memset(&mData, 0, sizeof(mData));
                mData.magic = NETDIAG_MAGIC;
            }
            if(mData.bootCnt < 0xFFFF)
                mData.bootCnt++;
            mData.lastResetReason = resetReason;
            save();
        }

        void onReconnect() {
            if(mData.reconnTotal < 0xFFFF)
                mData.reconnTotal++;
            save();
        }
        void onOfflineReboot()  { if(mData.offlineReboots < 0xFFFF) mData.offlineReboots++; save(); }
        void onDeadLink()       { if(mData.deadLinkCnt < 0xFFFF) mData.deadLinkCnt++; save(); }
        void setDiscReason(uint8_t r) { mData.lastDiscReason = r; save(); }
        void setOfflineDuration(uint32_t sec) {
            mData.lastOfflineDur = (sec > 0xFFFF) ? 0xFFFF : (uint16_t)sec;
            save();
        }

        const netDiag_t& get() const { return mData; }

    private:
        uint32_t calcCrc() const {
            const uint8_t *p = (const uint8_t*)&mData;
            uint32_t c = 0x1234abcd;
            for(size_t i = 0; i < sizeof(netDiag_t) - sizeof(uint32_t); i++)
                c = (c << 1) ^ (c >> 31) ^ p[i];
            return c;
        }

        bool load() {
            #if defined(ESP8266)
            if(!ESP.rtcUserMemoryRead(NETDIAG_RTC_OFFSET, (uint32_t*)&mData, sizeof(mData)))
                return false;
            return (mData.magic == NETDIAG_MAGIC) && (mData.crc == calcCrc());
            #else
            return false;
            #endif
        }

        void save() {
            mData.crc = calcCrc();
            #if defined(ESP8266)
            ESP.rtcUserMemoryWrite(NETDIAG_RTC_OFFSET, (uint32_t*)&mData, sizeof(mData));
            #endif
        }

        netDiag_t mData{};
};

#endif /*__NET_DIAG_H__*/
