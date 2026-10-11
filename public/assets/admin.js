(() => {
  const COLORS = { in: '#3fe0c5', out: '#ffb454', off: '#617089', nofix: '#617089' };
  const map = L.map('map', { zoomControl: false, attributionControl: false, zoomSnap: 0.5 }).setView([18.6298, 73.7997], 16);
  map.createPane('darkTiles').classList.add('map-tiles-dark');
  L.control.zoom({ position: 'bottomleft' }).addTo(map);
  L.control.attribution({ position: 'bottomleft', prefix: false }).addTo(map);
  const tiles = {
    dark: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, pane: 'darkTiles', attribution: '&copy; OpenStreetMap' }),
    sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles &copy; Esri' }),
    street: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' })
  };
  let tile = 'dark'; tiles.dark.addTo(map);
  $('#tiles').onclick = (e) => {
    const k = e.target.dataset.tile; if (!k || k === tile) return;
    map.removeLayer(tiles[tile]); tiles[k].addTo(map); tile = k;
    $$('#tiles button').forEach((b) => b.classList.toggle('on', b.dataset.tile === k));
  };

  /* ---------------- state ---------------- */
  let fence = null, log = [], max = 20, sound = false, firstFit = true;
  const cards = new Map();   // id -> combined card object from server
  const M = new Map();       // id -> { marker, trail, acc, st }
  let fenceLayer = null;

  /* ---------------- geo helpers ---------------- */
  const hav = (a, b, c, d) => { const R = 6371000, r = Math.PI / 180, x = (c - a) * r, y = (d - b) * r; const h = Math.sin(x / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(y / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
  const offset = (c, m, bearing) => { const b = bearing * Math.PI / 180; return { lat: c.lat + (m * Math.cos(b)) / 111320, lng: c.lng + (m * Math.sin(b)) / (111320 * Math.cos(c.lat * Math.PI / 180)) }; };

  /* ---------------- fence drawing ---------------- */
  function drawFence(f, draft = false) {
    if (fenceLayer) { map.removeLayer(fenceLayer); fenceLayer = null; }
    const col = draft ? '#8fa8ff' : '#3fe0c5';
    const o = { className: 'fence-shape' + (draft ? ' draft' : ''), color: col, weight: 2.5, fillColor: col, fillOpacity: 0.08, interactive: false };
    if (f.type === 'circle') fenceLayer = L.circle([f.center.lat, f.center.lng], { ...o, radius: f.radius });
    else if (f.polygon.length >= 3) fenceLayer = L.polygon(f.polygon.map((p) => [p.lat, p.lng]), o);
    else if (f.polygon.length) fenceLayer = L.polyline(f.polygon.map((p) => [p.lat, p.lng]), o);
    if (fenceLayer) fenceLayer.addTo(map).bringToBack();
  }
  function fenceText(f) { return f.type === 'circle' ? `Circle, ${f.radius} m radius` : `Polygon, ${f.polygon.length} corners`; }
  function renderFenceSummary() { $('#fsum').textContent = fence ? fenceText(fence) + '. Cards inside are logged in, cards leaving are logged out.' : 'Loading'; }

  /* ---------------- markers ---------------- */
  const pinIcon = (c, st) => L.divIcon({ className: 'pin-wrap', iconSize: [0, 0], html: `<div class="pin ${st}"><span class="pulse"></span><span class="dot">${esc(initials(c.name))}</span><span class="tag">${esc(c.name.split(' ')[0])}</span></div>` });
  function glide(m, to, ms = 1100) {
    const from = m.getLatLng(), t0 = performance.now(); cancelAnimationFrame(m._raf);
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      m.setLatLng([from.lat + (to[0] - from.lat) * e, from.lng + (to[1] - from.lng) * e]);
      if (k < 1) m._raf = requestAnimationFrame(step);
    };
    m._raf = requestAnimationFrame(step);
  }
  function popupHtml(id) {
    const c = cards.get(id); if (!c) return '';
    const st = statusOf(c);
    return `<div class="pop"><h4>${esc(c.name)}</h4><span class="chip ${st}">${STATUS_LABEL[st]}</span>
      <dl><dt>Roll no</dt><dd>${esc(c.roll || 'none')}</dd><dt>Card</dt><dd>${esc(c.id)}</dd>
      <dt>Position</dt><dd>${c.lat != null ? c.lat.toFixed(5) + ', ' + c.lng.toFixed(5) : 'no fix yet'}</dd>
      <dt>Accuracy</dt><dd>${c.acc != null ? c.acc + ' m' : 'unknown'}</dd>
      <dt>Wi-Fi</dt><dd>${c.rssi != null ? c.rssi + ' dBm' : 'unknown'}</dd>
      <dt>Last ping</dt><dd>${ago(c.lastSeen)}</dd></dl></div>`;
  }
  function upsertMarker(c) {
    if (c.lat == null) return removeMarker(c.id);
    const st = statusOf(c), ll = [c.lat, c.lng];
    let m = M.get(c.id);
    if (!m) {
      const marker = L.marker(ll, { icon: pinIcon(c, st), zIndexOffset: 500 }).addTo(map);
      marker.bindPopup(() => popupHtml(c.id), { className: 'nex-popup', closeButton: false, offset: [0, -12] });
      const trail = L.polyline(c.trail && c.trail.length ? c.trail : [ll], { color: COLORS[st], weight: 3, opacity: 0.55, lineCap: 'round', interactive: false }).addTo(map);
      const acc = L.circle(ll, { radius: c.acc || 0, color: COLORS[st], weight: 1, opacity: 0.4, fillOpacity: 0.06, interactive: false }).addTo(map);
      m = { marker, trail, acc, st }; M.set(c.id, m);
    } else {
      glide(m.marker, ll);
      if (c.trail) m.trail.setLatLngs(c.trail);
      m.acc.setLatLng(ll); m.acc.setRadius(c.acc || 0);
      if (m.st !== st) { m.marker.setIcon(pinIcon(c, st)); m.st = st; m.trail.setStyle({ color: COLORS[st] }); m.acc.setStyle({ color: COLORS[st] }); }
    }
    if (m.marker.isPopupOpen()) m.marker.getPopup().setContent(popupHtml(c.id));
  }
  function removeMarker(id) {
    const m = M.get(id); if (!m) return;
    [m.marker, m.trail, m.acc].forEach((l) => map.removeLayer(l)); M.delete(id);
  }
  function ripple(lat, lng, type) {
    const r = L.marker([lat, lng], { icon: L.divIcon({ className: 'pin-wrap', iconSize: [0, 0], html: `<div class="ripple ${type === 'LOGIN' ? 'in' : 'out'}"></div>` }), interactive: false, zIndexOffset: 100 }).addTo(map);
    setTimeout(() => map.removeLayer(r), 1800);
  }

  /* ---------------- sidebar ---------------- */
  const ORDER = { in: 0, out: 1, nofix: 2, off: 3 };
  let lastStats = '';
  function renderStats() {
    const n = { in: 0, out: 0, off: 0 };
    cards.forEach((c) => { const s = statusOf(c); n[s === 'nofix' ? 'off' : s]++; });
    const key = JSON.stringify(n);
    [['sIn', 'in'], ['sOut', 'out'], ['sOff', 'off']].forEach(([id, k]) => {
      const el = $('#' + id), b = el.querySelector('b');
      if (b.textContent !== String(n[k])) { b.textContent = n[k]; el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
    });
    $('#nCards').textContent = cards.size; lastStats = key;
  }
  function renderCards() {
    const rows = [...cards.values()].sort((a, b) => ORDER[statusOf(a)] - ORDER[statusOf(b)] || a.name.localeCompare(b.name));
    $('#cardList').innerHTML = rows.length ? rows.map((c) => {
      const st = statusOf(c);
      return `<li class="crow" data-id="${esc(c.id)}"><div class="av ${st}">${esc(initials(c.name))}</div>
        <div class="meta"><b>${esc(c.name)}</b><small>${esc(c.roll || c.id)}</small></div>
        <div class="right"><span class="chip ${st}">${STATUS_LABEL[st]}</span><small>${ago(c.lastSeen)}</small></div></li>`;
    }).join('') : `<li class="empty"><b>No cards registered</b>Add the first one on the <a href="/register">Register cards</a> page.</li>`;
  }
  function renderLog(freshSeq) {
    $('#nAct').textContent = log.length;
    $('#bufTxt').textContent = `${log.length} of ${max} entries kept`;
    $('#bufBar').style.width = (log.length / max * 100) + '%';
    $('#logList').innerHTML = log.length ? log.map((e) => {
      const inn = e.type === 'LOGIN';
      return `<li class="ev ${inn ? 'in' : 'out'} ${e.seq === freshSeq ? 'fresh' : ''}" data-id="${esc(e.cardId)}">
        <span class="ico">${inn ? '&#8601;' : '&#8599;'}</span>
        <div class="t"><b>${esc(e.name)}</b><small>${inn ? 'Logged in' : 'Logged out'}${e.roll ? ', ' + esc(e.roll) : ''}</small></div>
        <time>${clock(e.ts)}</time></li>`;
    }).join('') : `<li class="empty"><b>No gate activity yet</b>Entries appear here the moment a card crosses the boundary. Only the latest ${max} are kept.</li>`;
  }
  function focusCard(id) {
    const c = cards.get(id), m = M.get(id);
    if (!c || c.lat == null || !m) return toast('No position yet', (c ? c.name : 'This card') + ' has not sent a GPS fix.', 'err');
    map.flyTo([c.lat, c.lng], Math.max(map.getZoom(), 17), { duration: 1.1 });
    setTimeout(() => m.marker.openPopup(), 900);
  }
  $('#cardList').onclick = (e) => { const li = e.target.closest('.crow'); if (li) focusCard(li.dataset.id); };
  $('#logList').onclick = (e) => { const li = e.target.closest('.ev'); if (li) focusCard(li.dataset.id); };
  $('#tabs').onclick = (e) => {
    const p = e.target.closest('button')?.dataset.p; if (!p) return;
    $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.p === p));
    $$('.pane').forEach((x) => x.classList.toggle('on', x.id === p));
  };
  $('#clr').onclick = async () => { if (log.length && confirm('Clear all gate activity entries?')) await api('/api/log', 'DELETE'); };
  $('#fit').onclick = fitAll;
  function fitAll() {
    const pts = [];
    if (fenceLayer) { const b = fenceLayer.getBounds(); pts.push(b.getSouthWest(), b.getNorthEast()); }
    M.forEach((m) => pts.push(m.marker.getLatLng()));
    if (pts.length) map.flyToBounds(L.latLngBounds(pts), { padding: [90, 90], duration: 1 });
  }

  /* ---------------- sound ---------------- */
  let ac;
  function beep(type) {
    if (!sound) return;
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    const t = ac.currentTime, f = type === 'LOGIN' ? [660, 880] : [520, 390];
    f.forEach((hz, i) => {
      const o = ac.createOscillator(), g = ac.createGain(), s = t + i * 0.12;
      o.type = 'sine'; o.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, s); g.gain.exponentialRampToValueAtTime(0.15, s + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, s + 0.2);
      o.connect(g).connect(ac.destination); o.start(s); o.stop(s + 0.22);
    });
  }
  $('#snd').onclick = () => { sound = !sound; $('#snd').textContent = sound ? 'Sound on' : 'Sound off'; if (sound) beep('LOGIN'); };

  /* ---------------- geofence editor ---------------- */
  let draft = null, editing = false;
  const handles = L.layerGroup().addTo(map);
  const hIcon = (cls = '') => L.divIcon({ className: 'handle-wrap', iconSize: [0, 0], html: `<div class="handle ${cls}"></div>` });
  const clone = (o) => JSON.parse(JSON.stringify(o));

  function syncEditorUI() {
    $$('#fmode button').forEach((b) => b.classList.toggle('on', b.dataset.m === draft.type));
    $('#fcircle').style.display = draft.type === 'circle' ? '' : 'none';
    $('#fpoly').style.display = draft.type === 'polygon' ? '' : 'none';
    $('#rad').value = draft.radius || 300; $('#rv').textContent = (draft.radius || 300) + ' m';
  }
  function buildHandles() {
    handles.clearLayers();
    if (draft.type === 'circle') {
      const c = L.marker([draft.center.lat, draft.center.lng], { draggable: true, icon: hIcon(), zIndexOffset: 900 });
      const rp = () => offset(draft.center, draft.radius, 90);
      const r = L.marker([rp().lat, rp().lng], { draggable: true, icon: hIcon('r'), zIndexOffset: 900 });
      c.on('drag', (e) => { const p = e.target.getLatLng(); draft.center = { lat: p.lat, lng: p.lng }; const q = rp(); r.setLatLng([q.lat, q.lng]); drawFence(draft, true); });
      r.on('drag', (e) => {
        const p = e.target.getLatLng();
        draft.radius = Math.max(20, Math.min(20000, Math.round(hav(draft.center.lat, draft.center.lng, p.lat, p.lng))));
        $('#rad').value = Math.min(2000, draft.radius); $('#rv').textContent = draft.radius + ' m'; drawFence(draft, true);
      });
      r.on('dragend', () => { const q = rp(); r.setLatLng([q.lat, q.lng]); });
      handles.addLayer(c); handles.addLayer(r);
    } else {
      draft.polygon.forEach((p, i) => {
        const mk = L.marker([p.lat, p.lng], { draggable: true, icon: hIcon(), zIndexOffset: 900 });
        mk.on('drag', (e) => { const q = e.target.getLatLng(); draft.polygon[i] = { lat: q.lat, lng: q.lng }; drawFence(draft, true); });
        mk.on('contextmenu', () => { if (draft.polygon.length > 3) { draft.polygon.splice(i, 1); redrawDraft(); } else toast('Keep at least 3 corners', '', 'err'); });
        handles.addLayer(mk);
      });
    }
  }
  function redrawDraft() { drawFence(draft, true); buildHandles(); }
  function beginEdit() { draft = clone(fence); editing = true; document.body.classList.add('editing'); syncEditorUI(); redrawDraft(); }
  function endEdit() { editing = false; draft = null; handles.clearLayers(); document.body.classList.remove('editing'); drawFence(fence); }
  function squareAround(c, r) { return [45, 135, 225, 315].map((b) => offset(c, r * 1.2, b)); }
  function setMode(t) {
    if (!draft || draft.type === t) return;
    if (t === 'polygon') { if (draft.polygon.length < 3) draft.polygon = squareAround(draft.center, draft.radius || 300); }
    else if (draft.polygon.length >= 3) {
      const n = draft.polygon.length, c = draft.polygon.reduce((a, p) => ({ lat: a.lat + p.lat / n, lng: a.lng + p.lng / n }), { lat: 0, lng: 0 });
      draft.center = c; draft.radius = Math.max(50, Math.round(draft.polygon.reduce((s, p) => s + hav(c.lat, c.lng, p.lat, p.lng), 0) / n));
    }
    draft.type = t; syncEditorUI(); redrawDraft();
  }
  $('#fedit').onclick = beginEdit;
  $('#fcancel').onclick = endEdit;
  $('#fmode').onclick = (e) => { const m = e.target.dataset.m; if (m) setMode(m); };
  $('#rad').oninput = (e) => { draft.radius = +e.target.value; $('#rv').textContent = draft.radius + ' m'; redrawDraft(); };
  $('#undo').onclick = () => { if (draft.polygon.length > 3) { draft.polygon.pop(); redrawDraft(); } };
  $('#square').onclick = () => { draft.polygon = squareAround(draft.center.lat ? draft.center : map.getCenter(), draft.radius || 300); redrawDraft(); };
  map.on('click', (e) => { if (editing && draft.type === 'polygon') { draft.polygon.push({ lat: e.latlng.lat, lng: e.latlng.lng }); redrawDraft(); } });
  $('#fsave').onclick = async () => {
    try {
      if (draft.type === 'polygon' && draft.polygon.length < 3) throw new Error('A polygon needs at least 3 corners.');
      await api('/api/geofence', 'PUT', draft); endEdit(); toast('Boundary saved', 'Cards are now checked against the new fence.');
    } catch (e) { toast('Could not save boundary', e.message, 'err'); }
  };

  /* ---------------- live stream ---------------- */
  function setCards(list) {
    const ids = new Set(list.map((c) => c.id));
    [...cards.keys()].forEach((id) => { if (!ids.has(id)) { cards.delete(id); removeMarker(id); } });
    list.forEach((c) => { cards.set(c.id, c); upsertMarker(c); });
  }
  stream({
    snapshot(d) {
      fence = d.geofence; log = d.log; max = d.max;
      if (!editing) drawFence(fence);
      renderFenceSummary(); setCards(d.cards); renderStats(); renderCards(); renderLog();
      if (firstFit) { firstFit = false; fitAll(); }
    },
    card(c) {
      const prev = cards.get(c.id);
      c.trail = prev ? prev.trail.slice() : [];
      if (c.lat != null) { const l = c.trail[c.trail.length - 1]; if (!l || l[0] !== c.lat || l[1] !== c.lng) c.trail.push([c.lat, c.lng]); if (c.trail.length > 40) c.trail.shift(); }
      cards.set(c.id, c); upsertMarker(c); renderStats(); renderCards();
    },
    log(d) {
      log = d.log;
      renderLog(d.entry && d.entry.seq);
      if (d.entry) {
        const e = d.entry, inn = e.type === 'LOGIN';
        toast(e.name, inn ? 'logged in at the gate' : 'logged out at the gate', inn ? 'in' : 'out');
        ripple(e.lat, e.lng, e.type); beep(e.type);
      }
    },
    registry(d) { setCards(d.cards); renderStats(); renderCards(); },
    fence(f) { fence = f; if (!editing) drawFence(fence); renderFenceSummary(); }
  }, (ok) => { const l = $('#live'); l.classList.toggle('on', ok); l.lastElementChild.textContent = ok ? 'Live' : 'Reconnecting'; });

  /* statuses age with time (card goes offline when pings stop) */
  setInterval(() => {
    cards.forEach((c) => { const m = M.get(c.id); if (m && m.st !== statusOf(c)) upsertMarker(c); });
    renderStats(); renderCards();
    $('#clock').textContent = clock(now());
  }, 2000);
  $('#clock').textContent = clock(Date.now());
})();
