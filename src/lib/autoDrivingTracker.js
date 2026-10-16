import { AUTO_DRIVING_MAX_DELAY_MS, AUTO_DRIVING_MAX_POINTS } from './autoDrivingConstants.js';

export const AUTO_DRIVING_SAMPLE_MS = 10000;
export const AUTO_DRIVING_FLUSH_MS = 300000;
export const AUTO_DRIVING_MAX_QUEUED_BATCHES = 240;
export const autoDrivingStorageKey = (userId, managerId) => `fk:auto-driving:queue:v1:${userId}:${managerId}`;
export const autoDrivingConsentKey = userId => `fk:auto-driving:consent:v1:${userId}`;
export const readAutoDrivingConsent = (storage, userId) => !!userId && storage.getItem(autoDrivingConsentKey(userId)) === 'yes';
export const writeAutoDrivingConsent = (storage, userId, enabled) => {
    if (!userId) throw new Error('An exact account is required for mileage consent.');
    storage.setItem(autoDrivingConsentKey(userId), enabled ? 'yes' : 'no');
};

// Web Locks coordinate separate tabs, including their asynchronous final flush.
// A storage lease is insufficient: get/check/set is not atomic across tabs.
export function startExclusiveAutoDrivingTracker({ locks, lockName, start, onState = () => {} }) {
    let session = null, stopped = false, stopResult = Promise.resolve(), release;
    const hold = new Promise(resolve => { release = resolve; });
    const abort = new AbortController();
    let completion = Promise.resolve();
    if (!locks?.request) onState({ error: 'Automatic mileage is unavailable in this browser. Use an updated browser with location access.' });
    else {
        onState({ error: 'Waiting for this device’s other mileage session to finish.' });
        completion = locks.request(lockName, { mode: 'exclusive', signal: abort.signal }, async () => {
            if (stopped) return;
            onState({ error: '' }); session = start();
            await hold;
            await stopResult;
        }).catch(error => {
            if (!stopped && error?.name !== 'AbortError') onState({ error: 'Automatic mileage could not start in this browser. Refresh and allow location access.' });
        });
    }
    return { flush: () => session?.flush() || Promise.resolve(), stop(options) {
        if (!stopped) {
            stopped = true;
            if (session) stopResult = Promise.resolve(session.stop(options));
            else abort.abort();
            release();
        }
        return completion;
    } };
}

// Five minutes per immutable batch, not one write per GPS fix. The local queue is
// scoped to the exact account/company and never mixes authenticated identities.
export function startAutoDrivingTracker({ geolocation, storage, storageKey, invoke, shiftId, sessionId,
    onState = () => {}, now = Date.now, uuid = () => crypto.randomUUID(), setTimer = setInterval, clearTimer = clearInterval }) {
    let stopped = false, collecting = true, watchId, timer, inFlight = null, lastSampleAt = -Infinity, lastFlushAt = now();
    let storageError = '';
    let queue = [], buffer = { shift_id: shiftId, session_id: sessionId, batch_id: uuid(), points: [] };
    const report = update => onState({ queued_batches: queue.length + (buffer.points.length ? 1 : 0), ...update,
        ...(storageError ? { error: storageError } : {}) });
    try {
        const saved = JSON.parse(storage.getItem(storageKey) || '{}');
        queue = Array.isArray(saved.batches) ? saved.batches : [];
        if (saved.buffer?.points?.length) queue.push(saved.buffer);
        queue = queue.filter(batch => typeof batch.shift_id === 'string' && typeof batch.session_id === 'string'
            && typeof batch.batch_id === 'string' && Array.isArray(batch.points) && batch.points.length > 0
            && batch.points.length <= AUTO_DRIVING_MAX_POINTS
            && Date.parse(batch.points[0].observed_at) >= now() - AUTO_DRIVING_MAX_DELAY_MS)
            .slice(-AUTO_DRIVING_MAX_QUEUED_BATCHES);
    } catch { report({ error: 'The offline mileage queue could not be read. New GPS coverage starts now.' }); }
    const persist = () => {
        try { storage.setItem(storageKey, JSON.stringify({ batches: queue, buffer })); return true; }
        catch { storageError = 'Device storage is unavailable. Keep the app online to save mileage.'; report({ error: storageError }); return false; }
    };
    const seal = () => {
        if (!buffer.points.length) return;
        queue.push(buffer);
        buffer = { shift_id: shiftId, session_id: sessionId, batch_id: uuid(), points: [] };
        if (queue.length > AUTO_DRIVING_MAX_QUEUED_BATCHES) {
            queue = queue.slice(-AUTO_DRIVING_MAX_QUEUED_BATCHES);
            report({ error: 'The offline queue reached its limit. Earlier unsynced coverage is missing.' });
        }
        persist();
    };
    const flush = () => {
        seal(); lastFlushAt = now();
        if (inFlight) return inFlight;
        inFlight = (async () => {
            while (queue.length && !stopped) {
                const batch = queue[0];
                if (Date.parse(batch.points.at(-1).observed_at) < now() - AUTO_DRIVING_MAX_DELAY_MS) { queue.shift(); persist(); continue; }
                try {
                    const result = await invoke({ action: 'append', ...batch });
                    queue.shift(); persist(); report({ error: result?.dropped_points > 0
                        ? 'Samples outside the recorded work shift were excluded. GPS coverage is partial.' : '', lastSynced: now() });
                } catch (error) {
                    const status = error?.response?.status || error?.status;
                    if ([400, 403, 409].includes(status)) {
                        // A closed/edited/reassigned shift must not be retried into another team.
                        queue.shift(); persist(); report({ error: 'Some GPS coverage could not be verified for its original shift.' });
                        continue;
                    }
                    report({ error: 'GPS samples are saved on this device and will sync when connected.' });
                    break;
                }
            }
        })().finally(() => { inFlight = null; });
        return inFlight;
    };
    const position = value => {
        if (stopped || !collecting) return;
        const at = value?.timestamp, coords = value?.coords, time = now();
        if (!Number.isFinite(at) || at > time + 1000 || time - at > 15000
            || !Number.isFinite(coords?.latitude) || Math.abs(coords.latitude) > 90
            || !Number.isFinite(coords?.longitude) || Math.abs(coords.longitude) > 180
            || !Number.isFinite(coords?.accuracy) || coords.accuracy < 0 || coords.accuracy > 10000) {
            report({ error: 'Waiting for a fresh GPS fix. Missing coverage is not estimated.' }); return;
        }
        if (at - lastSampleAt < AUTO_DRIVING_SAMPLE_MS) return;
        lastSampleAt = at;
        if (buffer.points.length && at - Date.parse(buffer.points[0].observed_at) > AUTO_DRIVING_FLUSH_MS) seal();
        buffer.points.push({ observed_at: new Date(at).toISOString(), lat: coords.latitude, lng: coords.longitude,
            accuracy: coords.accuracy, speed: Number.isFinite(coords.speed) && coords.speed >= 0 ? coords.speed : null });
        persist(); report({ error: coords.accuracy > 35 ? 'GPS accuracy is low. Waiting for a more precise location.' : '', lastObserved: at });
        if (buffer.points.length >= AUTO_DRIVING_MAX_POINTS || time - lastFlushAt >= AUTO_DRIVING_FLUSH_MS) flush();
    };
    const gpsError = error => { if (!stopped) report({ error: error?.code === 1
        ? 'Location permission is blocked. Allow location access to record mileage.'
        : 'Waiting for GPS. Keep the app visible with location enabled.' }); };
    const options = { enableHighAccuracy: true, maximumAge: 0, timeout: 12000 };
    if (!geolocation) gpsError({ code: 1 });
    else {
        try {
            watchId = geolocation.watchPosition(position, gpsError, options);
            timer = setTimer(() => {
                if (stopped) return;
                geolocation.getCurrentPosition(position, gpsError, options);
                if (now() - lastFlushAt >= AUTO_DRIVING_FLUSH_MS) flush();
            }, AUTO_DRIVING_SAMPLE_MS);
        } catch (error) { gpsError(error); }
    }
    persist(); flush();
    return { flush, stop({ flushPending = false } = {}) {
        if (stopped) return Promise.resolve();
        collecting = false;
        if (watchId !== undefined) geolocation?.clearWatch(watchId);
        if (timer !== undefined) clearTimer(timer);
        seal();
        // Optional final flush is only used while the same identity is known.
        if (flushPending) return flush().then(() => queue.length ? flush() : undefined).finally(() => { stopped = true; });
        stopped = true;
        return Promise.resolve(inFlight);
    } };
}
