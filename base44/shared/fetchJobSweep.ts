// Shared helpers for FetchJob sweeps (stale-job watchdog and chunk resume).

export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function asArray(result) {
    return Array.isArray(result) ? result : (result?.items || []);
}

export function timestampMs(value) {
    const parsed = value ? new Date(value).getTime() : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
}