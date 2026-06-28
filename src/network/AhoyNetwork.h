//-----------------------------------------------------------------------------
// 2024 Ahoy, https://ahoydtu.de
// Creative Commons - https://creativecommons.org/licenses/by-nc-sa/4.0/deed
//-----------------------------------------------------------------------------

#ifndef __AHOY_NETWORK_H__
#define __AHOY_NETWORK_H__

#include "AhoyNetworkHelper.h"
#include "../config/settings.h"
#include "../utils/helper.h"
#include "AhoyWifiAp.h"
#include "NetDiag.h"
#include "AsyncJson.h"
#include <lwip/dns.h>

#define NTP_PACKET_SIZE 48
class AhoyNetwork {
    public:
        typedef std::function<void(bool)> OnNetworkCB;
        typedef std::function<void(uint32_t utcTimestamp)> OnTimeCB;

    public:
        void setup(settings_t *config, OnNetworkCB onNetworkCB, OnTimeCB onTimeCB) {
            mConfig = config;
            mOnNetworkCB = onNetworkCB;
            mOnTimeCB = onTimeCB;

            mNtpIp = IPADDR_NONE;

            if('\0' == mConfig->sys.deviceName[0])
                snprintf(mConfig->sys.deviceName, DEVNAME_LEN, "%s", DEF_DEVICE_NAME);

            #if defined(ESP8266)
            mDiag.begin((uint8_t)ESP.getResetInfoPtr()->reason);
            #else
            mDiag.begin(0);
            #endif

            mAp.setup(&mConfig->sys);

            #if defined(ESP32)
            WiFi.onEvent([this](WiFiEvent_t event, arduino_event_info_t info) -> void {
                OnEvent(event);
            });
            #else
            wifiConnectHandler = WiFi.onStationModeConnected(
                [this](const WiFiEventStationModeConnected& event) -> void {
                OnEvent((WiFiEvent_t)SYSTEM_EVENT_STA_CONNECTED);
            });
            wifiGotIPHandler = WiFi.onStationModeGotIP(
                [this](const WiFiEventStationModeGotIP& event) -> void {
                OnEvent((WiFiEvent_t)SYSTEM_EVENT_STA_GOT_IP);
            });
            wifiDisconnectHandler = WiFi.onStationModeDisconnected(
                [this](const WiFiEventStationModeDisconnected& event) -> void {
                // keep the reason and which BSSID dropped us, so the reconnect logic can
                // deprioritize a mesh node that just steered/deauthed us (FRITZ! Mesh)
                mLastDisconnectReason = (uint8_t)event.reason;
                mDiag.setDiscReason((uint8_t)event.reason);
                memcpy(mBadBssid, event.bssid, 6);
                mBadBssidValid = true;
                OnEvent((WiFiEvent_t)SYSTEM_EVENT_STA_DISCONNECTED);
            });
            #endif
        }

        virtual void tickNetworkLoop() {
            if(mDnsCallbackReady) {
                mDnsCallbackReady = false;
                startNtpUpdate();
            }

            if(mNtpTimeoutSec) {
                mNtpTimeoutSec--;
                if(!mNtpTimeoutSec)
                    mOnTimeCB(0); // timeout
            }
        }

        bool isConnected() const {
            return ((mStatus == NetworkState::CONNECTED) || (mStatus == NetworkState::GOT_IP));
        }

        static void dnsCallback(const char *name, const ip_addr_t *ipaddr, void *pClass) {
            AhoyNetwork *obj = static_cast<AhoyNetwork*>(pClass);
            if (ipaddr) {
                #if defined(ESP32)
                obj->mNtpIp = ipaddr->u_addr.ip4.addr;
                #else
                obj->mNtpIp = ipaddr->addr;
                #endif
            }
            obj->mDnsCallbackReady = true;
        }

        void updateNtpTime() {
            if(mNtpIp != IPADDR_NONE) {
                startNtpUpdate();
                return;
            }

            mNtpTimeoutSec = 30;

            ip_addr_t ipaddr;
            mNtpIp = WiFi.gatewayIP();
            // dns_gethostbyname runs asynchronous and sets the member mNtpIp which is then checked on
            // next call of updateNtpTime
            err_t err = dns_gethostbyname(mConfig->ntp.addr, &ipaddr, dnsCallback, this);

            if (err == ERR_OK) {
                #if defined(ESP32)
                mNtpIp = ipaddr.u_addr.ip4.addr;
                #else
                mNtpIp = ipaddr.addr;
                #endif
                startNtpUpdate();
            }
        }

    protected:
        void startNtpUpdate() {
            DPRINTLN(DBG_INFO, F("get time from: ") + mNtpIp.toString());
            if (!mUdp.connected()) {
                if (!mUdp.connect(mNtpIp, mConfig->ntp.port)) {
                    mOnTimeCB(0);
                    return;
                }
            }

            mUdp.onPacket([this](AsyncUDPPacket packet) {
                this->handleNTPPacket(packet);
            });
            sendNTPpacket();

            // reset to start with DNS lookup next time again
            mNtpIp = IPADDR_NONE;
        }

    public:
        virtual void begin() = 0;
        virtual String getIp(void) = 0;
        virtual String getMac(void) = 0;

        virtual bool getWasInCh12to14() {
            return false;
        }

        uint8_t getLastDisconnectReason() const {
            return mLastDisconnectReason;
        }

        uint16_t getWifiReconnectCnt() const {
            return mWifiReconnects;
        }

        const netDiag_t& getDiag() const {
            return mDiag.get();
        }

        // app-level liveness signal: lets the WiFi self-heal see through a
        // "associated but dead" mesh link. Fed every second. Neither WiFi.status()
        // nor mqtt.connected() can be trusted here - both stay "up" on a half-open
        // socket. The only proof data actually leaves the device is a broker
        // round-trip, so liveness ticks ONLY when the QoS1 heartbeat's PUBACK count
        // advances (mqttAckCnt). A rising edge on connect gives a grace window.
        void setLink(bool mqttEnabled, bool mqttConnected, uint32_t mqttAckCnt) {
            mMqttEnabled = mqttEnabled;
            if(mqttConnected) {
                if(!mMqttConnected) {                   // just (re)connected: grace before we judge the link
                    mLastMqttOkMs = millis();
                    mMqttAckCnt = mqttAckCnt;
                } else if(mqttAckCnt != mMqttAckCnt) {  // a PUBACK arrived => data really reached the broker
                    mMqttAckCnt = mqttAckCnt;
                    mLastMqttOkMs = millis();
                }
                mMqttWasConnected = true;
            }
            mMqttConnected = mqttConnected;
        }

        virtual bool isWiredConnection() {
            return false;
        }

        bool isApActive() {
            return mAp.isEnabled();
        }

        bool getAvailNetworks(JsonObject obj, IApp *app) {
            if(!mScanActive) {
                app->addOnce([this]() {scan();}, 1, "scan");
                return false;
            }

            int n = WiFi.scanComplete();
            if (WIFI_SCAN_RUNNING == n)
                return false;

            if(n > 0) {
                JsonArray nets = obj.createNestedArray(F("networks"));
                int sort[n];
                sortRSSI(&sort[0], n);
                for (int i = 0; i < n; ++i) {
                    nets[i][F("ssid")] = WiFi.SSID(sort[i]);
                    nets[i][F("rssi")] = WiFi.RSSI(sort[i]);
                }
            }
            mScanActive = false;
            WiFi.scanDelete();

            return true;
        }

        void scan(void) {
            mScanActive = true;
            if(mWifiConnecting) {
                mWifiConnecting = false;
                WiFi.disconnect();
            }
            WiFi.scanNetworks(true, true);
        }

    protected:
        virtual void setStaticIp() = 0;

        void setupIp(std::function<bool(IPAddress ip, IPAddress gateway, IPAddress mask, IPAddress dns1, IPAddress dns2)> cb) {
            if(mConfig->sys.ip.ip[0] != 0) {
                IPAddress ip(mConfig->sys.ip.ip);
                IPAddress mask(mConfig->sys.ip.mask);
                IPAddress dns1(mConfig->sys.ip.dns1);
                IPAddress dns2(mConfig->sys.ip.dns2);
                IPAddress gateway(mConfig->sys.ip.gateway);
                if(cb(ip, gateway, mask, dns1, dns2))
                    DPRINTLN(DBG_ERROR, F("failed to set static IP!"));
            }
        }

        virtual void OnEvent(WiFiEvent_t event) {
            switch(event) {
                case SYSTEM_EVENT_STA_CONNECTED:
                    [[fallthrough]];
                case ARDUINO_EVENT_ETH_CONNECTED:
                    if(NetworkState::CONNECTED != mStatus) {
                        mStatus = NetworkState::CONNECTED;
                        DPRINTLN(DBG_INFO, F("Network connected"));
                    }
                    break;

                case SYSTEM_EVENT_STA_GOT_IP:
                    [[fallthrough]];
                case ARDUINO_EVENT_ETH_GOT_IP:
                    mStatus = NetworkState::GOT_IP;
                    break;

                case ARDUINO_EVENT_WIFI_STA_LOST_IP:
                    [[fallthrough]];
                case ARDUINO_EVENT_WIFI_STA_STOP:
                    [[fallthrough]];
                case SYSTEM_EVENT_STA_DISCONNECTED:
                    [[fallthrough]];
                case ARDUINO_EVENT_ETH_STOP:
                    [[fallthrough]];
                case ARDUINO_EVENT_ETH_DISCONNECTED:
                    mStatus = NetworkState::DISCONNECTED;
                    break;

                default:
                    break;
            }
        }

        void sortRSSI(int *sort, int n) {
            for (int i = 0; i < n; i++)
                sort[i] = i;
            for (int i = 0; i < n; i++)
                for (int j = i + 1; j < n; j++)
                    if (WiFi.RSSI(sort[j]) > WiFi.RSSI(sort[i]))
                        std::swap(sort[i], sort[j]);
        }

    protected:
        void sendNTPpacket(void) {
            uint8_t buf[NTP_PACKET_SIZE];
            memset(buf, 0, NTP_PACKET_SIZE);

            buf[0] = 0b11100011; // LI, Version, Mode
            buf[1] = 0;          // Stratum
            buf[2] = 6;          // Max Interval between messages in seconds
            buf[3] = 0xEC;       // Clock Precision

            mUdp.write(buf, NTP_PACKET_SIZE);
        }

        void handleNTPPacket(AsyncUDPPacket packet) {
            char buf[80];

            memcpy(buf, packet.data(), sizeof(buf));

            unsigned long highWord = word(buf[40], buf[41]);
            unsigned long lowWord = word(buf[42], buf[43]);

            // combine the four bytes (two words) into a long integer
            // this is NTP time (seconds since Jan 1 1900):
            unsigned long secsSince1900 = highWord << 16 | lowWord;

            mUdp.close();
            mNtpTimeoutSec = 0; // clear timeout
            mOnTimeCB(secsSince1900 - 2208988800UL);
        }

    protected:
        enum class NetworkState : uint8_t {
            DISCONNECTED,
            CONNECTED,
            GOT_IP,
            SCAN_READY, // ESP8266
            CONNECTING // ESP8266
        };

    public:
        bool mDnsCallbackReady = false;

    protected:
        settings_t *mConfig = nullptr;
        bool mConnected = false;
        bool mScanActive = false;
        bool mWifiConnecting = false;
        uint8_t mNtpTimeoutSec = 0;

        uint8_t mLastDisconnectReason = 0;  // last WiFi disconnect reason code (ESP8266)
        uint16_t mWifiReconnects = 0;       // number of reconnect cycles since boot
        uint8_t mBadBssid[6] = {0};         // BSSID that last dropped us (mesh node to avoid)
        bool mBadBssidValid = false;

        NetDiag mDiag;                      // RTC-persistent diagnostics (survive reboots)
        bool mMqttEnabled = false;          // app-fed liveness inputs (see setLink)
        bool mMqttConnected = false;
        bool mMqttWasConnected = false;     // MQTT worked at least once this session
        uint32_t mLastMqttOkMs = 0;         // last confirmed broker round-trip (QoS1 PUBACK)
        uint32_t mMqttAckCnt = 0;           // last seen PUBACK count, to detect new round-trips

        OnNetworkCB mOnNetworkCB;
        OnTimeCB mOnTimeCB;

        NetworkState mStatus = NetworkState::DISCONNECTED;

        AhoyWifiAp mAp;
        DNSServer mDns;

        IPAddress mNtpIp;

        AsyncUDP mUdp; // for time server
        #if defined(ESP8266)
            WiFiEventHandler wifiConnectHandler, wifiDisconnectHandler, wifiGotIPHandler;
        #endif
};

#endif /*__AHOY_NETWORK_H__*/
