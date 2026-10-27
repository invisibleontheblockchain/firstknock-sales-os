import { LOCATION_PUBLISH_MS, LOCATION_FIX_MAX_AGE_MS, LOCATION_RETRY_MAX_MS, validLocation } from '../../base44/shared/repLocations.js';

// One writer per sharing session. Stop waits for an outstanding publish so a
// slow response cannot switch sharing back on after the rep stops.
export function startRepLocationSession({ geolocation, invoke, sessionId, onState, now = Date.now,
  setTimer = setInterval, clearTimer = clearInterval }) {
  let stopped = false;
  let inFlight = null;
  let lastAttempt = -Infinity;
  let retryAt = -Infinity;
  let failures = 0;
  let permissionBlocked = false;
  let watchId;
  let timer;
  let stopPromise;
  const gpsError = (error) => {
    if (stopped) return;
    // Coming back to the app asks for a fix again, so allowing access is all it takes.
    onState({ error: error?.code === 1 ? 'Location permission is blocked. Allow location access for FirstKnock in your phone settings, then return to the app.'
      : 'Waiting for GPS. Keep the app open with location access enabled.' });
  };
  const onPosition = (position) => {
    if (stopped || inFlight || permissionBlocked) return;
    const time = now();
    if (time < retryAt) return;
    const point = { lat: position?.coords?.latitude, lng: position?.coords?.longitude };
    const timestamp = position?.timestamp;
    if (!validLocation(point) || !Number.isFinite(timestamp) || time - timestamp > LOCATION_FIX_MAX_AGE_MS) {
      onState({ error: 'Waiting for a fresh GPS location.' });
      return;
    }
    if (time - lastAttempt < LOCATION_PUBLISH_MS) return;
    lastAttempt = time;
    inFlight = Promise.resolve().then(() => invoke({ action: 'publish', session_id: sessionId, ...point,
      accuracy: position.coords.accuracy, observed_at: new Date(timestamp).toISOString() }))
      .then(() => {
        failures = 0;
        retryAt = -Infinity;
        if (!stopped) onState({ error: '', lastPublished: timestamp });
      })
      .catch(error => {
        failures += 1;
        retryAt = now() + Math.min(LOCATION_PUBLISH_MS * 2 ** failures, LOCATION_RETRY_MAX_MS);
        const status = Number(error?.status || error?.response?.status || 0);
        permissionBlocked = status === 401 || status === 403;
        if (!stopped) onState({ error: error?.response?.data?.error || (permissionBlocked
          ? 'Location sharing permission changed. Restart sharing after your team access is restored.'
          : 'Location could not sync. Retrying when connected.') });
      }).finally(() => { inFlight = null; });
  };
  const options = { enableHighAccuracy: true, timeout: 12_000, maximumAge: 0 };
  if (!geolocation) onState({ error: 'Location sharing is unavailable on this device.' });
  else {
    try {
      watchId = geolocation.watchPosition(onPosition, gpsError, options);
      // Stationary reps still need fresh fixes, even if watchPosition is quiet.
      timer = setTimer(() => {
        if (!stopped && !inFlight && !permissionBlocked && now() >= retryAt) geolocation.getCurrentPosition(onPosition, gpsError, options);
      }, LOCATION_PUBLISH_MS);
    } catch { gpsError({ code: 1 }); }
  }
  return {
    // Ask for a fix now, for when the app comes back to the foreground after the
    // phone was locked: the browser paused GPS and timers while it was hidden.
    refresh() {
      if (!stopped && !inFlight && !permissionBlocked && geolocation && now() >= retryAt) {
        try { geolocation.getCurrentPosition(onPosition, gpsError, options); } catch { gpsError({ code: 1 }); }
      }
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopped = true;
      if (watchId !== undefined) geolocation.clearWatch(watchId);
      if (timer !== undefined) clearTimer(timer);
      stopPromise = Promise.resolve(inFlight).then(() => invoke({ action: 'stop', session_id: sessionId }));
      return stopPromise;
    },
  };
}
