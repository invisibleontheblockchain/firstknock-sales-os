// Track only unfinished raster tiles. Successful imagery remains in Leaflet's
// existing layer while individual failures recover through the IMG load path.
export function createTileLoadingRecovery({
  onStatus = () => {},
  isOnline = () => navigator.onLine !== false,
  eventTarget = window,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  random = Math.random,
  stallMs = 12_000,
  maxRetries = 2,
  maxConcurrentRetries = 4,
} = {}) {
  const records = new Map();
  const queue = [];
  let active = false;
  let online = isOnline();
  let retrying = 0;
  let pumping = false;
  let previousStatus = '';

  const publishStatus = () => {
    if (!active) return;
    const failedCount = [...records.values()].filter(record => record.phase === 'exhausted' || !online).length;
    const key = `${online}:${failedCount}`;
    if (key !== previousStatus) {
      previousStatus = key;
      onStatus({ failedCount, online });
    }
  };
  const cancelTimer = record => {
    if (record.timer !== null) clearTimer(record.timer);
    record.timer = null;
  };
  const releaseSlot = record => {
    if (!record.retrying) return;
    record.retrying = false;
    retrying--;
  };
  const forget = record => {
    cancelTimer(record);
    releaseSlot(record);
    records.delete(record.tile);
    record.queued = false;
    publishStatus();
  };
  const attached = record => active && records.get(record.tile) === record && record.tile.isConnected !== false;
  const decoded = record => record.tile.complete && record.tile.naturalWidth > 0;

  function armStallTimer(record) {
    cancelTimer(record);
    record.timer = setTimer(() => {
      record.timer = null;
      if (!attached(record)) { forget(record); pump(); return; }
      // A busy map can delay Leaflet's load handler after the browser has
      // already decoded the image. Keep those pixels instead of restarting it.
      if (decoded(record)) { forget(record); pump(); return; }
      scheduleRetry(record);
    }, stallMs);
  }

  function pump() {
    if (pumping || !active || !online) return;
    pumping = true;
    try {
      while (queue.length && retrying < maxConcurrentRetries) {
        const record = queue.shift();
        if (!record.queued || records.get(record.tile) !== record) continue;
        record.queued = false;
        if (!attached(record)) { forget(record); continue; }
        if (decoded(record)) { forget(record); continue; }
        if (!isOnline()) { onOffline(); break; }
        record.retries++;
        record.retrying = true;
        retrying++;
        record.phase = 'loading';
        armStallTimer(record);
        // Keep Leaflet's existing image, coordinates and load/error handlers.
        // Resetting src also cancels a stalled request before retrying the
        // original URL; no cache-busting query can break a signed provider URL.
        record.tile.removeAttribute('src');
        record.tile.src = record.url;
      }
    } finally {
      pumping = false;
    }
  }

  function scheduleRetry(record) {
    cancelTimer(record);
    releaseSlot(record);
    if (!attached(record)) { forget(record); pump(); return; }
    if (!isOnline()) { onOffline(); return; }
    if (!online) { record.phase = 'paused'; publishStatus(); return; }
    if (record.retries >= maxRetries) {
      record.phase = 'exhausted';
      publishStatus();
      pump();
      return;
    }
    record.phase = 'waiting';
    const delay = 800 * 2 ** record.retries + Math.floor(random() * 400);
    record.timer = setTimer(() => {
      record.timer = null;
      if (!attached(record)) { forget(record); return; }
      record.phase = 'queued';
      record.queued = true;
      queue.push(record);
      pump();
    }, delay);
    publishStatus();
    pump();
  }

  function onOffline() {
    online = false;
    queue.length = 0;
    records.forEach(record => {
      cancelTimer(record);
      releaseSlot(record);
      record.queued = false;
      record.phase = 'paused';
    });
    publishStatus();
  }

  function onOnline() {
    if (!active || online || !isOnline()) return;
    online = true;
    records.forEach(record => {
      record.retries = 0;
      scheduleRetry(record);
    });
    publishStatus();
  }

  const handlers = {
    tileloadstart({ tile }) {
      if (!active || !tile || records.has(tile)) return;
      const url = tile.getAttribute('src') || tile.src;
      if (!url) return;
      const record = { tile, url, retries: 0, retrying: false, queued: false, timer: null, phase: 'loading' };
      records.set(tile, record);
      // Leaflet fires tileloadstart just before appending its image to the map.
      // Attachment is checked when a retry runs, not during this event.
      if (online && isOnline()) armStallTimer(record);
      else onOffline();
    },
    tileerror({ tile }) {
      const record = records.get(tile);
      if (record?.phase === 'loading') scheduleRetry(record);
    },
    tileload({ tile }) {
      const record = records.get(tile);
      if (record) { forget(record); pump(); }
    },
    tileunload({ tile }) {
      const record = records.get(tile);
      if (record) { forget(record); pump(); }
    },
    tileabort({ tile }) {
      const record = records.get(tile);
      if (record) { forget(record); pump(); }
    },
  };

  return {
    handlers,
    start() {
      active = true;
      online = isOnline();
      previousStatus = '';
      eventTarget.addEventListener('online', onOnline);
      eventTarget.addEventListener('offline', onOffline);
      publishStatus();
    },
    retryFailed() {
      if (!active || !online || !isOnline()) return;
      records.forEach(record => {
        if (record.phase !== 'exhausted') return;
        record.retries = 0;
        scheduleRetry(record);
      });
      publishStatus();
    },
    dispose() {
      active = false;
      eventTarget.removeEventListener('online', onOnline);
      eventTarget.removeEventListener('offline', onOffline);
      records.forEach(cancelTimer);
      records.clear();
      queue.length = 0;
      retrying = 0;
    },
  };
}
