// Fake ID cards walking in and out of the geofence - lets you test everything without hardware.
//   npm start                       (terminal 1)
//   npm run simulate                (terminal 2)  then register SIM-001..SIM-005 on the Register page
// Env: SERVER (default http://localhost:3000)  DEVICE_KEY  LAT  LNG  RADIUS  CARDS
const SERVER = process.env.SERVER || 'http://localhost:3000';
const KEY = process.env.DEVICE_KEY || 'nex-device-key';
const C = { lat: +(process.env.LAT || 18.6298), lng: +(process.env.LNG || 73.7997) };
const R = +(process.env.RADIUS || 300);
const N = +(process.env.CARDS || 5);

const at = (distM, bearingDeg) => {
  const b = (bearingDeg * Math.PI) / 180;
  return { lat: C.lat + (distM * Math.cos(b)) / 111320, lng: C.lng + (distM * Math.sin(b)) / (111320 * Math.cos((C.lat * Math.PI) / 180)) };
};
let t = 0;
async function tick() {
  t++;
  for (let i = 0; i < N; i++) {
    const d = R * 1.25 + R * 0.95 * Math.sin(t * 0.07 + i * 1.3);   // sweeps from ~0.3R to ~2.2R, crossing the fence
    const p = at(d, i * (360 / N) + t * 0.4);
    const body = { id: 'SIM-' + String(i + 1).padStart(3, '0'), key: KEY,
      lat: p.lat + (Math.random() - 0.5) * 0.00004, lng: p.lng + (Math.random() - 0.5) * 0.00004,
      acc: 5 + Math.round(Math.random() * 8), rssi: -45 - Math.round(Math.random() * 30) };
    try {
      const r = await fetch(SERVER + '/api/ping', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) console.log(body.id, 'HTTP', r.status);
    } catch (e) { console.log('server unreachable:', e.message); }
  }
}
console.log(`Simulating ${N} cards around ${C.lat}, ${C.lng} (fence radius ${R} m) -> ${SERVER}`);
tick(); setInterval(tick, 2000);
