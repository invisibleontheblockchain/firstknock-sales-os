export class TimeClockError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

export function timeClockRange(start, end) {
    const valid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
    if (!valid(start) || !valid(end) || Date.parse(end) <= Date.parse(start)
        || Date.parse(end) - Date.parse(start) > 367 * 86400000) {
        throw new TimeClockError(400, 'Choose a valid date range of up to one year.');
    }
    return { start: Date.parse(start), end: Date.parse(end) };
}

// Count only the part of a shift inside the selected range, including overnight shifts.
export function shiftMilliseconds(shift, now = Date.now(), range = null) {
    const start = Date.parse(shift.clock_in_at);
    const end = shift.clock_out_at ? Date.parse(shift.clock_out_at) : now;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
    return Math.max(0, Math.min(end, range?.end ?? end) - Math.max(start, range?.start ?? start));
}

export function shiftOverlaps(shift, range, now = Date.now()) {
    return Date.parse(shift.clock_in_at) < range.end
        && (shift.clock_out_at ? Date.parse(shift.clock_out_at) : now) >= range.start;
}

export function durationLabel(milliseconds) {
    const minutes = Math.floor(Math.max(0, milliseconds) / 60000);
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}
