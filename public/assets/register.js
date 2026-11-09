(() => {
  let cards = [], pending = [], newId = null;
  const f = { id: $('#fId'), name: $('#fName'), roll: $('#fRoll'), dept: $('#fDept') };

  /* live ID card preview */
  function preview() {
    $('#pvName').textContent = f.name.value.trim() || 'Student name';
    $('#pvRoll').textContent = f.roll.value.trim() || 'Roll number';
    $('#pvDept').textContent = f.dept.value.trim() || 'Department';
    $('#pvId').textContent = f.id.value.trim() || 'NEX-000000';
    $('#pvAv').textContent = f.name.value.trim() ? initials(f.name.value) : '?';
    $$('.cardchip').forEach((c) => c.classList.toggle('sel', c.dataset.id === f.id.value.trim()));
  }
  Object.values(f).forEach((i) => i.addEventListener('input', () => { i.parentElement.classList.remove('bad'); preview(); }));
  $('#stage').addEventListener('pointermove', (e) => {
    const r = e.currentTarget.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5, c = $('#idcard');
    c.style.setProperty('--ry', (x * 22) + 'deg'); c.style.setProperty('--rx', (-y * 16) + 'deg'); c.style.setProperty('--sx', (120 - (x + 0.5) * 140) + '%');
  });
  $('#stage').addEventListener('pointerleave', () => { const c = $('#idcard'); ['--ry', '--rx', '--sx'].forEach((p) => c.style.removeProperty(p)); });

  /* detected (unregistered) cards */
  function renderPending() {
    const fresh = pending.filter((p) => now() - p.lastSeen < 5 * 60 * 1000);
    $('#dCount').textContent = fresh.length;
    $('#dChips').innerHTML = fresh.length
      ? fresh.map((p) => `<button type="button" class="cardchip" data-id="${esc(p.id)}"><i></i>${esc(p.id)}<small>${ago(p.lastSeen)}${p.rssi != null ? ', ' + p.rssi + ' dBm' : ''}</small></button>`).join('')
      : '<span class="none">No new cards heard yet. Power one on and keep it connected to a phone hotspot.</span>';
    preview();
  }
  $('#dChips').onclick = (e) => { const b = e.target.closest('.cardchip'); if (b) { f.id.value = b.dataset.id; preview(); f.name.focus(); } };

  /* registry table */
  function renderRows() {
    const q = $('#q').value.trim().toLowerCase();
    const rows = cards.filter((c) => !q || [c.name, c.roll, c.id, c.dept].some((v) => (v || '').toLowerCase().includes(q)));
    $('#rCount').textContent = cards.length;
    $('#rows').innerHTML = rows.length ? rows.map((c) => {
      const st = statusOf(c);
      return `<tr class="${c.id === newId ? 'new' : ''}"><td><div class="who"><div class="av ${st}">${esc(initials(c.name))}</div><div><b>${esc(c.name)}</b><small>${esc(c.roll || 'No roll number')}</small></div></div></td>
        <td>${esc(c.dept || '-')}</td><td class="idtxt">${esc(c.id)}</td>
        <td><span class="chip ${st}">${STATUS_LABEL[st]}</span> <small style="color:var(--mute)">${c.lastSeen ? ago(c.lastSeen) : ''}</small></td>
        <td class="registryActions"><button class="btn sm" data-gps="${esc(c.id)}">Phone GPS link</button><button class="btn danger sm" data-del="${esc(c.id)}">Remove</button></td></tr>`;
    }).join('') : `<tr><td colspan="5"><div class="empty"><b>${cards.length ? 'No matches' : 'No cards registered yet'}</b>${cards.length ? 'Try a different search.' : 'Register the first student card using the form above.'}</div></td></tr>`;
  }
  $('#q').oninput = renderRows;
  $('#rows').onclick = async (e) => {
    const gpsButton = e.target.closest('[data-gps]');
    if (gpsButton) {
      const id = gpsButton.dataset.gps;
      gpsButton.disabled = true;
      try {
        const result = await api('/api/cards/' + encodeURIComponent(id) + '/tracker', 'POST');
        $('#gpsLink').value = result.url;
        $('#gpsDialog').showModal();
      } catch (error) {
        toast('Could not create GPS link', error.message, 'err');
      } finally {
        gpsButton.disabled = false;
      }
      return;
    }
    const id = e.target.dataset.del; if (!id) return;
    const c = cards.find((x) => x.id === id);
    if (!confirm(`Remove ${c ? c.name : id}? Their card stops being tracked.`)) return;
    try { await api('/api/cards/' + encodeURIComponent(id), 'DELETE'); toast('Card removed', c ? c.name : id); } catch (er) { toast('Could not remove card', er.message, 'err'); }
  };
  $('#gpsCopy').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('#gpsLink').value);
      toast('GPS link copied', 'Open it on the phone paired with this card.');
    } catch (error) {
      $('#gpsLink').select();
      toast('Select and copy the link', 'Your browser did not allow clipboard access.', 'err');
    }
  };
  $('#gpsShare').onclick = async () => {
    try {
      if (!navigator.share) throw new Error('Sharing is not supported by this browser.');
      await navigator.share({ title: 'NEX-GATE phone GPS link', url: $('#gpsLink').value });
    } catch (error) {
      if (error.name !== 'AbortError') toast('Could not share GPS link', error.message, 'err');
    }
  };

  /* submit */
  function validate() {
    let ok = true;
    [['id', /^[A-Za-z0-9_-]{3,32}$/], ['name', /\S/]].forEach(([k, re]) => {
      const good = re.test(f[k].value.trim()); f[k].parentElement.classList.toggle('bad', !good); ok = ok && good;
    });
    return ok;
  }
  $('#form').onsubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return toast('Check the form', 'Card ID and student name are required.', 'err');
    const b = $('#fGo'); b.disabled = true;
    try {
      const r = await api('/api/cards', 'POST', { id: f.id.value.trim(), name: f.name.value.trim(), roll: f.roll.value.trim(), dept: f.dept.value.trim() });
      newId = r.card.id; setTimeout(() => { newId = null; }, 1500);
      toast('Card registered', r.card.name + ' is saved. Set up its Phone GPS link next.', 'in'); clearForm();
    } catch (er) { toast('Could not register card', er.message, 'err'); }
    b.disabled = false;
  };
  function clearForm() { Object.values(f).forEach((i) => { i.value = ''; i.parentElement.classList.remove('bad'); }); preview(); }
  $('#fClear').onclick = clearForm;

  $('#bk').onclick = async () => {
    try {
      const txt = JSON.stringify(await api('/api/backup'));
      await navigator.clipboard.writeText(txt);
      toast('Backup copied', 'For Render Free, paste it into STORE_SEED after card or GPS-link changes to keep them across restarts.');
    } catch (e) { toast('Could not copy backup', e.message, 'err'); }
  };

  const apply = (d) => { cards = d.cards; pending = d.pending; renderPending(); renderRows(); };
  stream({ snapshot: apply, registry: apply,
    card(c) { const i = cards.findIndex((x) => x.id === c.id); if (i >= 0) { cards[i] = { ...cards[i], ...c }; renderRows(); } }
  }, (ok) => { const l = $('#live'); l.classList.toggle('on', ok); l.lastElementChild.textContent = ok ? 'Live' : 'Reconnecting'; });
  setInterval(() => { renderPending(); renderRows(); }, 3000);
  preview();
})();
