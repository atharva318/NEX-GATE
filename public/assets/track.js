(() => {
  const status = document.querySelector('#status');
  const cardId = document.querySelector('#cardId');
  const accuracy = document.querySelector('#accuracy');
  const id = new URLSearchParams(location.search).get('card') || '';
  const token = location.hash.slice(1);
  let latest = null, sending = false, watchId = null, lock = null;

  function show(message, kind = '') {
    status.textContent = message;
    status.className = 'trackStatus' + (kind ? ' ' + kind : '');
  }

  async function sendLatest() {
    if (!latest || sending || Date.now() - latest.at > 30000) return;
    sending = true;
    try {
      const response = await fetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ id, token, lat: latest.lat, lng: latest.lng, acc: latest.acc })
      });
      const result = await response.json();
      if (response.status === 401) {
        clearInterval(retry);
        if (watchId !== null) navigator.geolocation.clearWatch(watchId);
        show(result.error || 'This GPS link is no longer valid. Ask the administrator for a new link.', 'err');
        return;
      }
      if (!response.ok) throw new Error(result.error || 'Could not send GPS location.');
      if (result.waitingForAccuracy) show(`GPS accuracy is ${result.accuracy} m. Waiting for a more accurate fix (150 m or better)…`);
      else show(result.waitingForCard ? 'GPS is ready. Waiting for the paired ID card to power on…' : 'Live: this phone is sending location to the powered card.', result.waitingForCard ? '' : 'ok');
    } catch (error) {
      show(error.message + ' Check your internet connection.', 'err');
    } finally {
      sending = false;
    }
  }

  if (!/^[A-Za-z0-9_-]{3,32}$/.test(id) || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) {
    cardId.textContent = 'Invalid link';
    show('This tracking link is incomplete. Ask the administrator to create a new card GPS link.', 'err');
    return;
  }
  cardId.textContent = id;
  if (!window.isSecureContext || !navigator.geolocation) {
    show('Phone GPS requires a secure HTTPS page and a browser with location support.', 'err');
    return;
  }

  const retry = setInterval(sendLatest, 5000);
  watchId = navigator.geolocation.watchPosition((position) => {
    latest = {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      acc: Math.round(position.coords.accuracy || 0),
      at: Date.now()
    };
    accuracy.textContent = latest.acc + ' m';
    sendLatest();
  }, (error) => {
    const message = error.code === error.PERMISSION_DENIED
      ? 'Location permission is blocked. Allow location for this site in your phone settings.'
      : error.code === error.POSITION_UNAVAILABLE
        ? 'Phone GPS is unavailable. Turn on Location services and retry.'
        : 'Phone GPS timed out. Keep Location services enabled; retrying…';
    show(message, 'err');
  }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 });

  if ('wakeLock' in navigator) {
    navigator.wakeLock.request('screen').then((value) => {
      lock = value;
      lock.addEventListener('release', () => { lock = null; });
    }).catch(() => {});
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !lock && 'wakeLock' in navigator) {
      navigator.wakeLock.request('screen').then((value) => {
        lock = value;
        lock.addEventListener('release', () => { lock = null; });
      }).catch(() => {});
    }
  });
})();
