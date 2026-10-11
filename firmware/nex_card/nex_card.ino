/*
 * NEX-GATE ID card firmware - ESP32-C3 Mini
 *
 *  phone (GPS) --WiFi hotspot--> ESP32-C3 card --HTTPS--> NEX-GATE server on Render
 *
 * The card never has GPS hardware. The phone sends its coordinates to the card
 * (http://<card>/gps?lat=..&lng=..&acc=..), and the card forwards them to the
 * server as its own position. Libraries: only the ESP32 Arduino core (v2.x or v3.x).
 *
 * Board: "ESP32C3 Dev Module", USB CDC On Boot = Enabled.
 */
#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include "config.h"

WebServer web(80);
char cardId[16];
char host[32];

double gLat = 0, gLng = 0, gAcc = 0;
bool haveFix = false;
uint32_t fixAt = 0, lastPing = 0, lastWifiTry = 0, pingsOk = 0, pingsFail = 0;
int8_t lastInside = -1;          // -1 unknown, 0 outside, 1 inside (answer from the server)
uint32_t blinkUntil = 0;

static const char BRIDGE_PAGE[] PROGMEM = R"HTML(<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>NEX card %ID%</title>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#0b1424;color:#e6eefb;display:grid;place-items:center;min-height:100vh}
main{width:min(380px,92vw);padding:26px;border:1px solid #26385a;border-radius:20px;background:#101c31}
h1{margin:0 0 4px;font-size:22px}p{color:#8a99b6;margin:6px 0}b{color:#e6eefb}
#st{margin:18px 0;padding:14px;border-radius:12px;background:#16253f;font-weight:600}
.ok{color:#3fe0c5}.bad{color:#ffb454}
</style></head><body><main>
<h1>Card %ID%</h1><p>Keep this page open. Your phone's location is sent to the card, and the card reports it to the gate system.</p>
<div id="st" class="bad">Waiting for location permission...</div>
<p>Accuracy: <b id="ac">-</b> &nbsp; Sent: <b id="n">0</b></p>
<script>
let n=0,wl=null;
function ok(p){const c=p.coords;
 fetch('/gps?lat='+c.latitude+'&lng='+c.longitude+'&acc='+Math.round(c.accuracy||0)).then(()=>{n++;
 document.getElementById('st').className='ok';document.getElementById('st').textContent='Sending your location';
 document.getElementById('ac').textContent=Math.round(c.accuracy||0)+' m';document.getElementById('n').textContent=n;}).catch(()=>{});}
function err(e){const s=document.getElementById('st');s.className='bad';s.textContent='Location blocked: '+e.message+'. See README step "Phone setup".';}
navigator.geolocation.watchPosition(ok,err,{enableHighAccuracy:true,maximumAge:2000,timeout:20000});
try{navigator.wakeLock&&navigator.wakeLock.request('screen').then(l=>wl=l);}catch(e){}
</script></main></body></html>)HTML";

void led(bool on) { digitalWrite(LED_PIN, (on ^ LED_ACTIVE_LOW) ? HIGH : LOW); }

void handleRoot() {
  String p = FPSTR(BRIDGE_PAGE);
  p.replace("%ID%", cardId);
  web.send(200, "text/html", p);
}

void handleGps() {                       // GET or POST /gps?lat=&lng=&acc=
  if (!web.hasArg("lat") || !web.hasArg("lng")) { web.send(400, "text/plain", "lat and lng required"); return; }
  double la = web.arg("lat").toDouble(), lo = web.arg("lng").toDouble();
  if (fabs(la) > 90 || fabs(lo) > 180 || (la == 0 && lo == 0)) { web.send(400, "text/plain", "bad coordinates"); return; }
  gLat = la; gLng = lo; gAcc = web.hasArg("acc") ? web.arg("acc").toDouble() : 0;
  haveFix = true; fixAt = millis();
  web.sendHeader("Access-Control-Allow-Origin", "*");
  web.send(200, "text/plain", "ok");
}

void handleInfo() {
  char b[200];
  snprintf(b, sizeof b, "{\"id\":\"%s\",\"fix\":%s,\"ok\":%lu,\"fail\":%lu,\"rssi\":%d}",
           cardId, haveFix ? "true" : "false", (unsigned long)pingsOk, (unsigned long)pingsFail, WiFi.RSSI());
  web.send(200, "application/json", b);
}

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  WiFi.setTxPower(WIFI_POWER_8_5dBm);    // many Super Mini boards only join reliably at reduced TX power
  lastWifiTry = millis();
}

void sendPing() {
  if (WiFi.status() != WL_CONNECTED) return;
  WiFiClientSecure tls;
  tls.setInsecure();                     // simple; for strict TLS pin the Render root CA instead
  HTTPClient http;
  String url = String("https://") + SERVER_HOST + "/api/ping";
  if (!http.begin(tls, url)) return;
  http.setTimeout(10000);
  http.addHeader("Content-Type", "application/json");

  char body[256];
  bool fresh = haveFix && (millis() - fixAt < FIX_MAX_AGE_MS);
  if (fresh)
    snprintf(body, sizeof body, "{\"id\":\"%s\",\"key\":\"%s\",\"lat\":%.7f,\"lng\":%.7f,\"acc\":%.0f,\"rssi\":%d}",
             cardId, DEVICE_KEY, gLat, gLng, gAcc, WiFi.RSSI());
  else
    snprintf(body, sizeof body, "{\"id\":\"%s\",\"key\":\"%s\",\"rssi\":%d}", cardId, DEVICE_KEY, WiFi.RSSI());

  int code = http.POST((uint8_t*)body, strlen(body));
  if (code == 200) {
    pingsOk++;
    String r = http.getString();
    lastInside = r.indexOf("\"inside\":true") >= 0 ? 1 : (r.indexOf("\"inside\":false") >= 0 ? 0 : -1);
    blinkUntil = millis() + 120;
    Serial.printf("[ping] ok  inside=%d  fix=%s\n", lastInside, fresh ? "yes" : "no");
  } else {
    pingsFail++;
    Serial.printf("[ping] failed code=%d (Render may be waking up)\n", code);
  }
  http.end();
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT); led(false);

  uint64_t mac = ESP.getEfuseMac();
  snprintf(cardId, sizeof cardId, "NEX-%02X%02X%02X", (uint8_t)(mac >> 24), (uint8_t)(mac >> 32), (uint8_t)(mac >> 40));
  snprintf(host, sizeof host, "nexcard-%s", cardId + 4);
  Serial.printf("\n=== NEX-GATE card ===\nCard ID: %s\n", cardId);

  connectWifi();
  web.on("/", handleRoot);
  web.on("/gps", handleGps);
  web.on("/info", handleInfo);
  web.begin();
}

void loop() {
  web.handleClient();

  if (WiFi.status() == WL_CONNECTED) {
    static bool announced = false;
    if (!announced) {
      announced = true;
      MDNS.begin(host);
      MDNS.addService("http", "tcp", 80);
      Serial.printf("WiFi ok. Phone page: http://%s.local/  or  http://%s/\n", host, WiFi.localIP().toString().c_str());
    }
    if (millis() - lastPing >= PING_EVERY_MS) { lastPing = millis(); sendPing(); }
  } else if (millis() - lastWifiTry > 15000) {
    Serial.println("WiFi lost, retrying...");
    WiFi.disconnect(); connectWifi();
  }

  // LED: solid = inside the geofence, short blink = ping sent, off = outside / unknown
  led(millis() < blinkUntil ? true : lastInside == 1);
}
