# NEX-GATE: ID-card geofence login / logout

ESP32 Dev Module cards report their identity and online status; a paired phone supplies GPS through a secure tracker link. The server decides inside or outside the college geofence, logs **Login** (entered) and **Logout** (left), and shows everything on a live Leaflet map.

```
Phone GPS --secure HTTPS tracker link──┐
                                      ├──► NEX-GATE server ──SSE──► live admin map
ESP32 card --phone hotspot + HTTPS ping┘
```

* No database and no cloud storage. The gate log lives in memory and keeps **only the last 20 entries**; each new one pushes the oldest out.
* `/admin` live map: moving cards with trails, geofence (circle or polygon, editable), activity feed, sound alerts.
* `/register` registers cards that power on and creates per-card phone GPS links.
* Both pages are behind one admin password.

## Project description

NEX-GATE is a lightweight, real-time attendance and location-monitoring system for ID cards. Each ESP32 card identifies itself to the server and periodically reports the GPS position supplied by the student's phone. Administrators define a circular or polygon geofence on a live map. The server checks each reported position against that boundary, records a login when a card enters and a logout when it leaves, and streams card locations and activity to the admin dashboard.

The card does not contain a GPS receiver. A paired phone supplies location through a secure HTTPS tracker page, while the ESP32 reports its presence over the phone hotspot. The server associates the phone's GPS fixes with that registered card and evaluates the geofence.

## Architecture

```text
Phone browser geolocation ── secure, per-card HTTPS link ─┐
                                                         ├──► Node.js + Express server
ESP32 Dev Module ── phone hotspot + HTTPS / JSON pings ──┘
                                                     │
                          ┌──────────────────────────┼──────────────────────────┐
                          ▼                          ▼                          ▼
                   Fence evaluation             Attendance log          Server-Sent Events
                          │                          │                          │
                          └──────────────────────────┴──────────────────────────┘
                                                     ▼
                                          Admin web app + Leaflet map
```

The phone's browser gets its location from the Geolocation API and sends it over HTTPS using a unique, revocable per-card link. The ESP32 continues to report its identity and online status over the phone hotspot; no firmware change is required. The server is authoritative for geofence checks and login/logout transitions. The admin page gets an initial snapshot and receives live card, fence, and activity updates through Server-Sent Events (SSE). Administrators manage cards and edit fences through authenticated JSON APIs. Card registry and fence settings are stored in a local JSON file and can be exported; the activity log is deliberately in-memory and capped at 20 events.

## Architecture principles

- **Server-authoritative attendance:** Devices report identity and coordinates; the server decides whether a card is inside the configured boundary and produces attendance events.
- **Clear responsibility boundaries:** Firmware handles Wi-Fi and device reporting; the secure phone tracker provides GPS; the server handles authentication, validation, fence geometry, and event decisions; the browser handles administration and visualization.
- **Live, lightweight updates:** SSE updates the dashboard without frequent polling or a separate message broker.
- **Reliable boundary transitions:** A change in inside/outside status requires consecutive fixes, and low-accuracy fixes are ignored for boundary flips to reduce GPS-jitter false events.
- **Privacy-conscious retention:** The system uses no database or cloud storage by default. The activity log is bounded and memory-only; the card registry and fence are stored locally.
- **Simple deployment and operation:** A single Node.js service serves the admin UI and APIs and can run locally or on Render.

## Technologies used

| Area | Technologies |
|---|---|
| ID card firmware | ESP32 Dev Module, Arduino framework / ESP32 Arduino core, C++ |
| Phone location bridge | Browser Geolocation API, HTTPS, HTML, CSS, JavaScript |
| Server | Node.js 18+, Express 4, REST-style JSON APIs, Server-Sent Events |
| Admin dashboard | HTML, CSS, vanilla JavaScript, Leaflet 1.9.4 |
| Maps and tiles | Leaflet; OpenStreetMap street tiles and Esri World Imagery |
| Authentication and device access | Signed HTTP-only session cookie, HMAC-SHA256, shared device key, per-card random GPS link tokens |
| Configuration and persistence | Environment variables, local JSON store and backup |
| Hosting | Render |

## 1. Try it locally (no hardware)

```bash
npm install
ADMIN_PASSWORD=pick-one DEVICE_KEY=secret123 npm start     # http://localhost:3000
DEVICE_KEY=secret123 npm run simulate                       # second terminal: 5 fake cards
```
Open `/register`, register `SIM-001` to `SIM-005`, then watch `/admin`. (Windows PowerShell: set `$env:ADMIN_PASSWORD="..."` first.)

## 2. Deploy on Render

1. Push this folder to a GitHub repo (for example under Nexus-labs2).
2. Render, **New, Blueprint**, pick the repo (it reads `render.yaml`). Or **New, Web Service** with build `npm install` and start `npm start`.
3. Set environment variables:
   * `ADMIN_PASSWORD`: your admin login.
   * `DEVICE_KEY`: auto-generated by the blueprint. Copy it, the firmware needs it.
   * `SESSION_SECRET`: auto-generated.
   * `STORE_SEED` (optional, see below).
4. Open `https://<your-service>.onrender.com`, sign in, then drag the geofence over your college (**Edit boundary**, then **Save boundary**).

**Free plan notes**
* Free services sleep after ~15 min with no traffic, and their writable filesystem is not durable across restarts/deploys. The local JSON file alone therefore cannot guarantee that cards remain registered.
* To keep two registered cards without registering again on Render Free, first open `/register` on the currently running service and click **Copy backup**. Paste the complete JSON into Render's `STORE_SEED` environment variable **before deploying an update**. On every later card registration, GPS-link creation/rotation, or geofence edit, copy a new backup and replace `STORE_SEED`. This backup includes the registered cards, fence, and hashed tracker credentials. If the running service has already lost its cards and no backup exists, the IDs/details must be entered once again before creating a new backup. A Render persistent disk or external database is needed for automatic persistence without manual seed updates.

## 3. Flash a card

1. Arduino IDE, install the **esp32** board package. Select *ESP32 Dev Module*.
2. Edit `firmware/nex_card/config.h`: phone hotspot name and password (2.4 GHz), your Render hostname, `DEVICE_KEY`.
3. Upload `firmware/nex_card/nex_card.ino`. The serial monitor prints the **Card ID** (like `NEX-1A2B3C`) and the card's address.
4. Power it on near the phone hotspot. The card appears under **Cards waiting to be registered** on `/register`.

The default LED configuration uses GPIO 2, active-high, as on many ESP32 Dev Module boards. Board revisions vary; if the LED does not behave as expected, set `LED_PIN` and `LED_ACTIVE_LOW` in `firmware/nex_card/config.h` to match your board. On-board LED: solid = inside the geofence, short blink = report sent.

## 4. Phone setup (secure GPS tracking without firmware changes)

The card has no GPS. Use the hosted HTTPS tracker instead of relying on the ESP32's plain-HTTP GPS page, which modern phone browsers block:

1. Register each card once on `/register`.
2. Click **Phone GPS link** beside a card and share that link with the phone whose hotspot the card uses. The link identifies only that card and can be revoked by creating a new one.
3. Open the link on that phone, allow location, and keep the page open. Once the card pings the server, its phone's location will appear automatically and geofence login/logout will work.

The tracker uses HTTPS, so it avoids browser secure-origin exceptions. A mobile browser may suspend location when the page is closed or heavily backgrounded; keep it open and allow background activity if the phone offers that setting. The card powering on by itself cannot produce GPS coordinates: without firmware changes, the phone tracker must already be running. The old `http://<card>/` page remains available as a fallback only on browsers/devices that explicitly permit location on insecure origins.

## 5. How decisions are made

* Inside or outside is computed on the server (distance for circles, point-in-polygon for polygons).
* A flip needs **2 consecutive readings** and an accuracy better than 150 m, so GPS jitter at the boundary does not spam the log.
* A card's first fix sets its baseline: starting inside logs a Login; starting outside logs nothing.
* A card with no ping for 45 s shows as Offline. Editing the fence re-baselines cards silently, so it never creates fake logouts.

## Files

```
server.js            API, geofence logic, 20-entry log, live stream, auth
public/              login, admin map, register page (+ assets/)
firmware/nex_card/   ESP32 sketch + config.h
tools/simulate.js    fake cards for testing
render.yaml          Render blueprint
```
