#pragma once
// ---- edit these four lines, then flash ----
#define WIFI_SSID    "YOUR_PHONE_HOTSPOT_NAME"   // the student's phone hotspot (2.4 GHz)
#define WIFI_PASS    "YOUR_HOTSPOT_PASSWORD"
#define SERVER_HOST  "nex-gate.onrender.com"     // your Render hostname, no https:// and no slash
#define DEVICE_KEY   "PASTE_DEVICE_KEY_FROM_RENDER"

// ---- optional tuning ----
#define PING_EVERY_MS     5000     // how often the card reports to the server
#define FIX_MAX_AGE_MS    20000    // a phone fix older than this is treated as lost
#define LED_PIN           8        // ESP32-C3 Super Mini on-board LED
#define LED_ACTIVE_LOW    true     // that LED is active-low
