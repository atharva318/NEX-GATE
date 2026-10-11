/* shared helpers for admin + register pages */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let skew = 0;                                  // server clock minus browser clock
const now = () => Date.now() + skew;
const STALE_MS = 45000;                        // no ping for this long = offline

async function api(url, method = 'GET', body) {
  const r = await fetch(url, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 401 && !url.includes('/login')) { location.href = '/login'; throw new Error('Signed out'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}

function toast(title, msg = '', kind = '') {
  let box = $('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.innerHTML = `<b>${esc(title)}</b><span>${esc(msg)}</span>`;
  box.appendChild(t);
  setTimeout(() => { t.classList.add('bye'); setTimeout(() => t.remove(), 320); }, 4200);
}

function ago(ts) {
  if (!ts) return 'never seen';
  const s = Math.max(0, Math.round((now() - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  return m < 60 ? m + 'm ago' : Math.floor(m / 60) + 'h ago';
}
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const initials = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

function statusOf(c) {
  if (!c || !c.lastSeen || now() - c.lastSeen > STALE_MS) return 'off';
  if (c.inside === null || c.lat === null) return 'nofix';
  return c.inside ? 'in' : 'out';
}
const STATUS_LABEL = { in: 'Inside', out: 'Outside', off: 'Offline', nofix: 'No GPS' };

function stream(handlers, onState) {
  const es = new EventSource('/api/stream');
  ['snapshot', 'card', 'log', 'registry', 'fence'].forEach((ev) =>
    es.addEventListener(ev, (e) => {
      const m = JSON.parse(e.data);
      skew = m.t - Date.now();
      if (handlers[ev]) handlers[ev](m.d);
    }));
  es.onopen = () => onState && onState(true);
  es.onerror = async () => {
    onState && onState(false);
    try { const r = await fetch('/api/me', { credentials: 'same-origin' }); if (r.status === 401) location.href = '/login'; } catch (e) { /* offline */ }
  };
}
async function signOut() { try { await api('/api/logout', 'POST'); } finally { location.href = '/login'; } }
