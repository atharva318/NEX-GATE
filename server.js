'use strict';
/*  NEX-GATE server
 *  - ESP32 Dev Module cards ping /api/ping; paired phones report GPS over HTTPS
 *  - Server decides inside/outside the geofence and logs LOGIN / LOGOUT
 *  - Only the last 20 events are kept, in memory. No database, no cloud storage.
 *  - Admin pages get live updates through Server-Sent Events.
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DEVICE_KEY = process.env.DEVICE_KEY || 'nex-device-key';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const MAX_LOG = 20;            // the one and only history limit
const TRAIL_MAX = 40;          // points kept per card for the motion trail
const CONFIRM_READINGS = 2;    // consecutive readings needed to flip inside/outside (kills GPS jitter)
const MAX_FLIP_ACCURACY = 150; // metres - ignore fence flips from fixes worse than this
const PENDING_MAX = 20;
const PENDING_TTL = 10 * 60 * 1000;
const DATA_FILE = path.join(__dirname, 'data', 'store.json');

if (!process.env.ADMIN_PASSWORD) console.warn('[warn] ADMIN_PASSWORD not set - using insecure default "admin123"');
if (!process.env.DEVICE_KEY) console.warn('[warn] DEVICE_KEY not set - using insecure default');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

/* ------------------------------------------------------------------ state */
let geofence = { type: 'circle', center: { lat: 18.6298, lng: 73.7997 }, radius: 300, polygon: [] };
const cards = new Map();    // id -> {id,name,roll,dept,createdAt}   (registry)
const live = new Map();     // id -> runtime state
const pending = new Map();  // unregistered ids that have been heard
const trackerTokens = new Map(); // id -> SHA-256 hash of the phone GPS link token
let log = [];               // newest first, max 20

const ID_RE = /^[A-Za-z0-9_-]{3,32}$/;
const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
const okLat = (v) => Number.isFinite(v) && Math.abs(v) <= 90;
const okLng = (v) => Number.isFinite(v) && Math.abs(v) <= 180;

function cleanCard(c) {
  if (!c || typeof c !== 'object') return null;
  const id = String(c.id || '').trim();
  const name = String(c.name || '').trim().slice(0, 60);
  if (!ID_RE.test(id) || !name) return null;
  return {
    id, name,
    roll: String(c.roll || '').trim().slice(0, 30),
    dept: String(c.dept || '').trim().slice(0, 40),
    createdAt: Number(c.createdAt) || Date.now()
  };
}

function cleanFence(f) {
  if (!f || typeof f !== 'object') return null;
  if (f.type === 'circle') {
    const lat = num(f.center && f.center.lat), lng = num(f.center && f.center.lng), r = num(f.radius);
    if (!okLat(lat) || !okLng(lng) || !(r >= 20 && r <= 20000)) return null;
    return { type: 'circle', center: { lat, lng }, radius: Math.round(r), polygon: [] };
  }
  if (f.type === 'polygon') {
    if (!Array.isArray(f.polygon) || f.polygon.length < 3 || f.polygon.length > 100) return null;
    const poly = [];
    for (const p of f.polygon) {
      const lat = num(p && p.lat), lng = num(p && p.lng);
      if (!okLat(lat) || !okLng(lng)) return null;
      poly.push({ lat, lng });
    }
    const c = poly.reduce((a, p) => ({ lat: a.lat + p.lat / poly.length, lng: a.lng + p.lng / poly.length }), { lat: 0, lng: 0 });
    return { type: 'polygon', center: c, radius: 0, polygon: poly };
  }
  return null;
}

function loadStore() {
  const apply = (o) => {
    if (!o || typeof o !== 'object') return;
    const f = cleanFence(o.geofence);
    if (f) geofence = f;
    if (Array.isArray(o.cards)) for (const c of o.cards) { const m = cleanCard(c); if (m) cards.set(m.id, m); }
    if (o.trackerTokens && typeof o.trackerTokens === 'object' && !Array.isArray(o.trackerTokens)) {
      for (const [id, hash] of Object.entries(o.trackerTokens)) {
        if (ID_RE.test(id) && typeof hash === 'string' && /^[a-f0-9]{64}$/i.test(hash)) trackerTokens.set(id, hash);
      }
    }
  };
  try { if (process.env.STORE_SEED) apply(JSON.parse(process.env.STORE_SEED)); } catch (e) { console.warn('[warn] STORE_SEED is not valid JSON'); }
  try { if (fs.existsSync(DATA_FILE)) apply(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); }
  catch (e) { console.error(`[error] Could not load store file ${DATA_FILE}: ${e.message}`); }
}
function saveStore() {
  const tmpFile = DATA_FILE + '.tmp';
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(tmpFile, JSON.stringify(backup()));
    fs.renameSync(tmpFile, DATA_FILE);
    return true;
  } catch (e) {
    console.error(`[error] Could not persist store to ${DATA_FILE}: ${e.message}`);
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (cleanupError) {
      console.error(`[error] Could not remove temporary store file ${tmpFile}: ${cleanupError.message}`);
    }
    return false;
  }
}
const backup = () => ({ geofence, cards: [...cards.values()], trackerTokens: Object.fromEntries(trackerTokens) });
loadStore();

/* --------------------------------------------------------------- geometry */
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function insideFence(lat, lng) {
  const f = geofence;
  if (f.type === 'circle') return haversine(lat, lng, f.center.lat, f.center.lng) <= f.radius;
  let inside = false;
  const p = f.polygon;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const yi = p[i].lat, xi = p[i].lng, yj = p[j].lat, xj = p[j].lng;
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/* ------------------------------------------------------------------- SSE */
const clients = new Set();
function emit(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify({ t: Date.now(), d: data })}\n\n`;
  for (const r of clients) r.write(payload);
}
setInterval(() => { for (const r of clients) r.write(':hb\n\n'); }, 15000);

function pub(id, withTrail) {
  const m = cards.get(id), l = live.get(id) || {};
  return {
    id, name: m.name, roll: m.roll, dept: m.dept,
    lat: l.lat ?? null, lng: l.lng ?? null, acc: l.acc ?? null,
    fixTs: l.fixTs ?? null, lastSeen: l.lastSeen ?? null,
    inside: l.inside ?? null, rssi: l.rssi ?? null,
    trail: withTrail ? (l.trail || []) : undefined
  };
}
const allCards = () => [...cards.keys()].map((id) => pub(id, true));
const pendingList = () => [...pending.values()].sort((a, b) => b.lastSeen - a.lastSeen);
const registryPayload = () => ({ cards: allCards(), pending: pendingList() });
const snapshot = () => ({ geofence, log, max: MAX_LOG, ...registryPayload() });

function addLog(type, m, lat, lng, ts) {
  const entry = {
    seq: crypto.randomBytes(4).toString('hex'),
    type, cardId: m.id, name: m.name, roll: m.roll, dept: m.dept, lat, lng, ts
  };
  log.unshift(entry);
  if (log.length > MAX_LOG) log.length = MAX_LOG;   // oldest entry vanishes
  emit('log', { entry, log });
}

function evaluate(c, m, lat, lng, acc, ts) {
  const inside = insideFence(lat, lng);
  if (c.inside === null) {                 // first fix after (re)start: just establish the baseline
    c.inside = inside; c.cand = null; c.streak = 0;
    if (inside) {
      c.trail = [[lat, lng]];
      addLog('LOGIN', m, lat, lng, ts);
    } else {
      c.trail = [];
    }
    return;
  }
  if (inside === c.inside) { c.cand = null; c.streak = 0; return; }
  if (acc != null && acc > MAX_FLIP_ACCURACY) return;
  if (c.cand === inside) c.streak++; else { c.cand = inside; c.streak = 1; }
  if (c.streak >= CONFIRM_READINGS) {
    c.inside = inside; c.cand = null; c.streak = 0;
    c.trail = inside ? [[lat, lng]] : [];
    addLog(inside ? 'LOGIN' : 'LOGOUT', m, lat, lng, ts);
  }
}

function updateCardFix(id, lat, lng, acc, ts) {
  const m = cards.get(id);
  let c = live.get(id);
  if (!c) { c = { trail: [], inside: null, cand: null, streak: 0 }; live.set(id, c); }
  c.lat = lat; c.lng = lng; c.acc = acc; c.fixTs = ts;
  evaluate(c, m, lat, lng, acc, ts);
  if (c.inside) {
    if (!c.trail.length || c.trail[c.trail.length - 1][0] !== lat || c.trail[c.trail.length - 1][1] !== lng) c.trail.push([lat, lng]);
    if (c.trail.length > TRAIL_MAX) c.trail.shift();
  } else {
    c.trail = [];
  }
  emit('card', pub(id, true));
  return c;
}

/* ------------------------------------------------------------------ auth */
const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex');
function makeToken() { const p = String(Date.now() + 12 * 3600e3); return p + '.' + sign(p); }
function validToken(t) {
  if (!t) return false;
  const [p, s] = t.split('.');
  if (!p || !s) return false;
  const e = sign(p);
  if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return false;
  return Number(p) > Date.now();
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const authed = (req) => validToken(cookies(req).nex_session);
const apiAuth = (req, res, next) => (authed(req) ? next() : res.status(401).json({ error: 'Sign in required' }));
const pageAuth = (req, res, next) => (authed(req) ? next() : res.redirect('/login'));

const attempts = new Map();
app.post('/api/login', (req, res) => {
  const ip = req.ip, now = Date.now();
  const a = attempts.get(ip) || { n: 0, reset: now + 60000 };
  if (now > a.reset) { a.n = 0; a.reset = now + 60000; }
  if (a.n >= 6) return res.status(429).json({ error: 'Too many attempts. Wait a minute and try again.' });
  const pw = String((req.body && req.body.password) || '');
  const good = crypto.timingSafeEqual(Buffer.from(sign('pw:' + pw)), Buffer.from(sign('pw:' + ADMIN_PASSWORD)));
  if (!good) { a.n++; attempts.set(ip, a); return res.status(401).json({ error: 'Wrong password' }); }
  attempts.delete(ip);
  res.cookie('nex_session', makeToken(), { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 12 * 3600e3 });
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { res.clearCookie('nex_session'); res.json({ ok: true }); });
app.get('/api/me', apiAuth, (req, res) => res.json({ ok: true }));
app.get('/api/geofence', apiAuth, (req, res) => res.json({ ok: true, geofence }));

/* ------------------------------------------------------- device endpoint */
app.post('/api/ping', (req, res) => {
  const b = req.body || {};
  if (b.key !== DEVICE_KEY) return res.status(401).json({ error: 'bad key' });
  const id = String(b.id || '');
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'bad id' });

  const now = Date.now();
  const lat = num(b.lat), lng = num(b.lng !== undefined ? b.lng : b.lon);
  const hasFix = okLat(lat) && okLng(lng);
  const acc = Number.isFinite(num(b.acc)) ? Math.round(num(b.acc)) : null;
  const rssi = Number.isFinite(num(b.rssi)) ? Math.round(num(b.rssi)) : null;

  const m = cards.get(id);
  if (!m) {                                    // unknown card: surface it on the Register page
    const isNew = !pending.has(id);
    pending.set(id, { id, lastSeen: now, rssi, lat: hasFix ? lat : null, lng: hasFix ? lng : null });
    if (pending.size > PENDING_MAX) {
      const oldest = pendingList().pop();
      pending.delete(oldest.id);
    }
    emit('registry', registryPayload());
    return res.json({ ok: true, registered: false, isNew });
  }

  let c = live.get(id);
  if (!c) { c = { trail: [], inside: null, cand: null, streak: 0 }; live.set(id, c); }
  c.lastSeen = now; c.rssi = rssi;
  if (hasFix) {
    updateCardFix(id, lat, lng, acc, now);
  } else emit('card', pub(id, true));
  res.json({ ok: true, registered: true, inside: c.inside, name: m.name });
});

app.post('/api/track', (req, res) => {
  const b = req.body || {};
  const id = String(b.id || '');
  const token = String(b.token || '');
  const savedHash = trackerTokens.get(id);
  if (!ID_RE.test(id) || !savedHash || token.length > 200) return res.status(401).json({ error: 'Invalid card tracking link.' });
  const suppliedHash = crypto.createHash('sha256').update(token).digest();
  const expectedHash = Buffer.from(savedHash, 'hex');
  if (suppliedHash.length !== expectedHash.length || !crypto.timingSafeEqual(suppliedHash, expectedHash)) {
    return res.status(401).json({ error: 'Invalid card tracking link.' });
  }
  const lat = num(b.lat), lng = num(b.lng), acc = num(b.acc);
  if (!okLat(lat) || !okLng(lng) || !Number.isFinite(acc) || acc < 0 || acc > 10000) {
    return res.status(400).json({ error: 'A valid GPS position and accuracy are required.' });
  }
  if (acc > MAX_FLIP_ACCURACY) return res.json({ ok: true, waitingForAccuracy: true, accuracy: Math.round(acc) });

  const now = Date.now();
  const c = live.get(id);
  if (!c || !c.lastSeen || now - c.lastSeen > 45000) return res.json({ ok: true, waitingForCard: true });
  updateCardFix(id, lat, lng, Math.round(acc), now);
  res.json({ ok: true, waitingForCard: false });
});

/* --------------------------------------------------------- admin APIs */
app.get('/api/stream', apiAuth, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write(`event: snapshot\ndata: ${JSON.stringify({ t: Date.now(), d: snapshot() })}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.post('/api/cards', apiAuth, (req, res) => {
  const m = cleanCard({ ...req.body, createdAt: Date.now() });
  if (!m) return res.status(400).json({ error: 'Card ID (letters, numbers, - _) and a student name are required.' });
  if (cards.has(m.id)) return res.status(409).json({ error: `Card ${m.id} is already registered.` });
  cards.set(m.id, m);
  pending.delete(m.id);
  if (!saveStore()) {
    cards.delete(m.id);
    return res.status(503).json({ error: 'Card could not be saved. Check server storage configuration.' });
  }
  emit('registry', registryPayload());
  res.json({ ok: true, card: m });
});

app.post('/api/cards/:id/tracker', apiAuth, (req, res) => {
  const id = req.params.id;
  if (!cards.has(id)) return res.status(404).json({ error: 'Card not found.' });
  const token = crypto.randomBytes(32).toString('base64url');
  const previousToken = trackerTokens.get(id);
  trackerTokens.set(id, crypto.createHash('sha256').update(token).digest('hex'));
  if (!saveStore()) {
    if (previousToken) trackerTokens.set(id, previousToken);
    else trackerTokens.delete(id);
    return res.status(503).json({ error: 'GPS link could not be saved. Check server storage configuration.' });
  }
  const protocol = req.secure ? 'https' : 'http';
  res.json({ ok: true, url: `${protocol}://${req.get('host')}/track?card=${encodeURIComponent(id)}#${token}` });
});

app.delete('/api/cards/:id', apiAuth, (req, res) => {
  const id = req.params.id;
  const card = cards.get(id);
  if (!card) return res.status(404).json({ error: 'Card not found.' });
  const trackerToken = trackerTokens.get(id);
  const runtime = live.get(id);
  cards.delete(id);
  trackerTokens.delete(id);
  live.delete(id);
  if (!saveStore()) {
    cards.set(id, card);
    if (trackerToken) trackerTokens.set(id, trackerToken);
    if (runtime) live.set(id, runtime);
    return res.status(503).json({ error: 'Card could not be removed from storage.' });
  }
  emit('registry', registryPayload());
  res.json({ ok: true });
});

app.put('/api/geofence', apiAuth, (req, res) => {
  const f = cleanFence(req.body);
  if (!f) return res.status(400).json({ error: 'Invalid geofence. Circles need a centre and 20 m to 20 km radius; polygons need 3 or more points.' });
  const previous = geofence;
  geofence = f;
  if (!saveStore()) {
    geofence = previous;
    return res.status(503).json({ error: 'Geofence could not be saved. Check server storage configuration.' });
  }
  for (const [id, c] of live) {                // re-baseline silently so editing the fence never fakes a logout
    if (c.lat != null) { c.inside = insideFence(c.lat, c.lng); c.cand = null; c.streak = 0; }
    c.trail = c.inside ? (c.lat != null ? [[c.lat, c.lng]] : []) : [];
  }
  emit('fence', geofence);
  emit('registry', registryPayload());
  res.json({ ok: true });
});

app.delete('/api/log', apiAuth, (req, res) => {
  log = [];
  emit('log', { entry: null, log });
  res.json({ ok: true });
});

app.get('/api/backup', apiAuth, (req, res) => res.json(backup()));

/* ----------------------------------------------------------------- pages */
const pubDir = path.join(__dirname, 'public');
app.use('/assets', express.static(path.join(pubDir, 'assets'), { maxAge: '5m' }));
app.get('/', (req, res) => res.redirect('/admin'));
app.get('/healthz', (req, res) => res.send('ok'));
app.get('/login', (req, res) => (authed(req) ? res.redirect('/admin') : res.sendFile(path.join(pubDir, 'login.html'))));
app.get('/admin', pageAuth, (req, res) => res.sendFile(path.join(pubDir, 'admin.html')));
app.get('/register', pageAuth, (req, res) => res.sendFile(path.join(pubDir, 'register.html')));
app.get('/track', (req, res) => res.sendFile(path.join(pubDir, 'track.html')));
app.use((req, res) => res.status(404).send('Not found'));

setInterval(() => {                             // forget unregistered cards that went quiet
  const cut = Date.now() - PENDING_TTL;
  let changed = false;
  for (const [id, p] of pending) if (p.lastSeen < cut) { pending.delete(id); changed = true; }
  if (changed) emit('registry', registryPayload());
}, 30000);

app.listen(PORT, () => console.log(`NEX-GATE listening on :${PORT}`));
