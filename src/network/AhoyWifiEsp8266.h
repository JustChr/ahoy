//-----------------------------------------------------------------------------
// 2024 Ahoy, https://ahoydtu.de
// Creative Commons - https://creativecommons.org/licenses/by-nc-sa/4.0/deed
//-----------------------------------------------------------------------------

#ifndef __AHOY_WIFI_ESP8266_H__
#define __AHOY_WIFI_ESP8266_H__

#if defined(ESP8266)
#include <functional>
#include <list>
#include <WiFiUdp.h>
#include "AhoyNetwork.h"
#include "ESPAsyncWebServer.h"

class AhoyWifi : public AhoyNetwork {
    public:
        void begin() override {
            // don't write the WiFi config to flash on every WiFi.begin() (flash wear + latency)
            WiFi.persistent(false);
            // keep the radio fully awake: modem-sleep is a common cause of silent drops on ESP8266
            WiFi.setSleepMode(WIFI_NONE_SLEEP);
            // our state machine owns reconnects; don't let the SDK silently retry the same
            // (possibly steering) BSSID behind our back
            WiFi.setAutoReconnect(false);

            mAp.enable();

            WiFi.setHostname(mConfig->sys.deviceName);
            mBSSIDList.clear();

            mLastOnlineMs = millis(); // start the offline-reboot watchdog from boot
        }

        void tickNetworkLoop() override {
            AhoyNetwork::tickNetworkLoop();
            if(mAp.isEnabled())
                mAp.tickLoop();

            mCnt++;

            #if !defined(AP_ONLY)
            // last-resort recovery: if we cannot get back online for a long time, reboot.
            // skip while a client is using the soft-AP (e.g. someone is configuring the DTU).
            if((millis() - mLastOnlineMs) >= OFFLINE_REBOOT_MS) {
                if(WiFi.softAPgetStationNum() == 0) {
                    DBGPRINTLN(F("offline too long, rebooting"));
                    mDiag.onOfflineReboot();
                    Serial.flush();
                    ESP.restart();
                } else
                    mLastOnlineMs = millis(); // postpone while AP is in use
            }
            #endif

            switch(mStatus) {
                case NetworkState::DISCONNECTED:
                    if(mConnected) {
                        mConnected = false;
                        mWifiConnecting = false;
                        mWifiReconnects++;
                        mOfflineSinceMs = millis();
                        mDiag.onReconnect();
                        mOnNetworkCB(false);
                        mAp.enable();
                        MDNS.end();
                    }

                    if (WiFi.softAPgetStationNum() > 0) {
                        DBGPRINTLN(F("AP client connected"));
                    }
                    #if !defined(AP_ONLY)
                    else if (!mScanActive) {
                        DBGPRINT(F("scanning APs with SSID "));
                        DBGPRINTLN(String(mConfig->sys.stationSsid));
                        mScanCnt = 0;
                        mCnt = 0;
                        mScanActive = true;
                        WiFi.scanNetworks(true, true, 0U, ([this]() {
                            if (mConfig->sys.isHidden)
                                return (uint8_t*)NULL;
                            return (uint8_t*)(mConfig->sys.stationSsid);
                        })());
                    } else if(getBSSIDs()) {
                        mStatus = NetworkState::SCAN_READY;
                        DBGPRINT(F("connect to network '")); Serial.flush();
                        DBGPRINTLN(mConfig->sys.stationSsid);
                    }
                    #endif
                    break;

                case NetworkState::SCAN_READY:
                    mStatus = NetworkState::CONNECTING;
                    DBGPRINT(F("try to connect to BSSID:"));
                    uint8_t bssid[6];
                    for (int j = 0; j < 6; j++) {
                        bssid[j] = mBSSIDList.front();
                        mBSSIDList.pop_front();
                        DBGPRINT(" "  + String(bssid[j], HEX));
                    }
                    DBGPRINTLN("");
                    setStaticIp();
                    WiFi.begin(mConfig->sys.stationSsid, mConfig->sys.stationPwd, 0, &bssid[0]);
                    mWifiConnecting = true;
                    mConnectStartMs = millis(); // real elapsed-time timeout for this attempt
                    break;

                case NetworkState::CONNECTING:
                    if ((millis() - mConnectStartMs) >= CONNECT_TIMEOUT_MS) {
                        WiFi.disconnect();
                        mWifiConnecting = false;
                        mStatus = mBSSIDList.empty() ? NetworkState::DISCONNECTED : NetworkState::SCAN_READY;
                    }
                    break;

                case NetworkState::CONNECTED:
                    break;

                case NetworkState::GOT_IP:
                    // backstop watchdog: catch a silent link loss where the SDK never fires
                    // STA_DISCONNECTED. Without this the state machine stays in GOT_IP forever.
                    if(WiFi.status() != WL_CONNECTED) {
                        if((millis() - mLastOnlineMs) >= LINK_LOST_TIMEOUT_MS) {
                            DBGPRINTLN(F("link lost without event, forcing reconnect"));
                            mStatus = NetworkState::DISCONNECTED;
                            break;
                        }
                    } else {
                        mLastOnlineMs = millis();

                        // "associated but dead": WiFi.status() still says connected but the
                        // mesh node's backhaul is gone, so every status-based watchdog is blind.
                        // Use MQTT as the liveness signal - but only if it worked at least once
                        // this session, so a merely-down broker can't trigger us. Force ONE
                        // re-associate (not a reboot), rate-limited, to re-home onto a live node.
                        if(mConnected && mMqttEnabled && mMqttWasConnected && !mMqttConnected
                            && ((millis() - mLastMqttOkMs) >= DEAD_LINK_TIMEOUT_MS)
                            && ((millis() - mLastDeadLinkMs) >= DEAD_LINK_REASSOC_MIN_MS)) {
                            DBGPRINTLN(F("link dead (assoc, no MQTT), forcing reconnect"));
                            mLastDeadLinkMs = millis();
                            mDiag.onDeadLink();
                            WiFi.disconnect();
                            mStatus = NetworkState::DISCONNECTED;
                            break;
                        }
                    }

                    if(!mConnected) {
                        mAp.disable();
                        mConnected = true;
                        if(0 != mOfflineSinceMs) {
                            mDiag.setOfflineDuration((millis() - mOfflineSinceMs) / 1000);
                            mOfflineSinceMs = 0;
                        }
                        ah::welcome(WiFi.localIP().toString(), F("Station"));
                        MDNS.begin(mConfig->sys.deviceName);
                        MDNSResponder::hMDNSService hRes = MDNS.addService(NULL, "http", "tcp", 80);
                        MDNS.addServiceTxt(hRes, "path", "/");
                        MDNS.announce();
                        mOnNetworkCB(true);
                    }

                    MDNS.update();

                    if(WiFi.channel() > 11)
                        mWasInCh12to14 = true;
                    break;
            }
        }

        String getIp(void) override {
            return WiFi.localIP().toString();
        }

        String getMac(void) override {
            return WiFi.macAddress();
        }

        bool getWasInCh12to14() override {
            return mWasInCh12to14;
        }

    private:
        void setStaticIp() override {
            setupIp([this](IPAddress ip, IPAddress gateway, IPAddress mask, IPAddress dns1, IPAddress dns2) -> bool {
                return WiFi.config(ip, gateway, mask, dns1, dns2);
            });
        }

        void pushBSSID(const uint8_t *bssid) {
            DBGPRINT(F("BSSID:"));
            for (int j = 0; j < 6; j++) {
                DBGPRINT(" " + String(bssid[j], HEX));
                mBSSIDList.push_back(bssid[j]);
            }
            DBGPRINTLN("");
        }

        bool getBSSIDs() {
            bool result = false;
            int n = WiFi.scanComplete();
            if (n < 0) {
                if (++mScanCnt < 20)
                    return false;
            }
            if(n > 0) {
                mBSSIDList.clear();
                int sort[n];
                sortRSSI(&sort[0], n);
                int deferred = -1; // index of the node that just dropped us (try it last)
                for (int i = 0; i < n; i++) {
                    if(mBadBssidValid && (0 == memcmp(WiFi.BSSID(sort[i]), mBadBssid, 6)) && (n > 1)) {
                        deferred = sort[i];
                        continue;
                    }
                    pushBSSID(WiFi.BSSID(sort[i]));
                }
                if(deferred >= 0) // append as last resort so it's never fully excluded
                    pushBSSID(WiFi.BSSID(deferred));

                mBadBssidValid = false; // only deprioritize for this one reconnect cycle
                result = true;
            }
            mScanActive = false;
            WiFi.scanDelete();
            return result;
        }

    private:
        uint8_t mCnt = 0;
        uint8_t mScanCnt = 0;
        std::list<uint8_t> mBSSIDList;
        bool mWasInCh12to14 = false;
        uint32_t mConnectStartMs = 0;   // start of the current connect attempt
        uint32_t mLastOnlineMs = 0;     // last time we were confirmed online (WL_CONNECTED)
        uint32_t mOfflineSinceMs = 0;   // when we last went offline (0 = online), for duration
        uint32_t mLastDeadLinkMs = 0;   // last forced re-associate due to a dead link
        static constexpr uint32_t CONNECT_TIMEOUT_MS  = 20000;  // per connect attempt
        static constexpr uint32_t LINK_LOST_TIMEOUT_MS = 30000; // silent link loss before forced reconnect
        static constexpr uint32_t OFFLINE_REBOOT_MS   = 300000; // 5 min offline -> reboot
        static constexpr uint32_t DEAD_LINK_TIMEOUT_MS = 240000;     // assoc but no MQTT this long -> dead
        static constexpr uint32_t DEAD_LINK_REASSOC_MIN_MS = 360000; // min spacing between forced re-associates
};

#endif /*ESP8266*/
#endif /*__AHOY_WIFI_ESP8266_H__*/
