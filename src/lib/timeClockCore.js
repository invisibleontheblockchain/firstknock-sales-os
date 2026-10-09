// Browser-safe counterpart of base44/shared/timeClock.js. Base44 previews serve only frontend files.
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
        && (shift.clock_out_at ? Date.parse(shift.clock_out_at) > range.start : now >= range.start);
}

export function durationLabel(milliseconds) {
    const minutes = Math.floor(Math.max(0, milliseconds) / 60000);
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export const DEFAULT_CLOCK_TIMEZONE = 'America/Phoenix';

export function validateClockTimezone(timezone) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); }
    catch { throw new TimeClockError(400, 'Choose a valid reporting timezone.'); }
    if (typeof timezone !== 'string' || !timezone) throw new TimeClockError(400, 'Choose a valid reporting timezone.');
    return timezone;
}

const zoneParts = (value, timezone) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
}).formatToParts(new Date(value)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));

export function zonedClockDate(value = Date.now(), timezone = DEFAULT_CLOCK_TIMEZONE) {
    const parts = zoneParts(value, timezone);
    return `${parts.year}-${parts.month}-${parts.day}`;
}

const calendarDate = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new TimeClockError(400, 'Choose valid dates.');
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new TimeClockError(400, 'Choose valid dates.');
    return date;
};
const advanceDate = (value, days) => {
    const date = calendarDate(value);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
};

export function clockPresetDates(preset, now = Date.now(), timezone = DEFAULT_CLOCK_TIMEZONE) {
    const today = zonedClockDate(now, timezone);
    if (preset === 'today') return { start: today, end: today };
    if (preset === 'yesterday') return { start: advanceDate(today, -1), end: advanceDate(today, -1) };
    const monday = advanceDate(today, -((calendarDate(today).getUTCDay() + 6) % 7));
    if (preset === 'last-week') return { start: advanceDate(monday, -7), end: advanceDate(monday, -1) };
    return { start: monday, end: today };
}

export function clockDateRangeInZone(start, end, timezone = DEFAULT_CLOCK_TIMEZONE) {
    validateClockTimezone(timezone);
    const midnight = value => {
        const target = calendarDate(value).getTime();
        let candidate = target;
        for (let attempt = 0; attempt < 5; attempt++) {
            const p = zoneParts(candidate, timezone);
            const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
            const correction = target - wall;
            if (!correction) return candidate;
            candidate += correction;
        }
        // Some zones skip midnight during a DST transition; use the first instant of that date.
        const candidates = [candidate, candidate + 3600000, candidate - 3600000]
            .filter(time => zonedClockDate(time, timezone) === value).sort((a, b) => a - b);
        if (!candidates.length) throw new TimeClockError(400, 'This date does not exist in the reporting timezone.');
        return candidates[0];
    };
    const first = midnight(start);
    calendarDate(end);
    if (start > end) throw new TimeClockError(400, 'Choose a valid date range.');
    const last = midnight(advanceDate(end, 1));
    return { ...timeClockRange(new Date(first).toISOString(), new Date(last).toISOString()), start_at: new Date(first).toISOString(), end_at: new Date(last).toISOString() };
}

export function summarizeTimeClock(shifts, range, now = Date.now(), people = []) {
    const groups = new Map(people.map(person => [person.id, { id: person.id, name: person.name, completed_ms: 0, completed_shifts: 0, open_shifts: 0, requests: 0, shifts: [] }]));
    for (const shift of shifts) {
        if (!shiftOverlaps(shift, range, now)) continue;
        if (!groups.has(shift.rep_user_id)) groups.set(shift.rep_user_id, { id: shift.rep_user_id, name: shift.rep_name || shift.rep_email || 'Team member', completed_ms: 0, completed_shifts: 0, open_shifts: 0, requests: 0, shifts: [] });
        const group = groups.get(shift.rep_user_id);
        group.shifts.push(shift);
        if (shift.status === 'closed') {
            group.completed_ms += shiftMilliseconds(shift, now, range);
            group.completed_shifts++;
        } else if (shift.status === 'active') group.open_shifts++;
        group.requests += (shift.correction_requests || []).filter(request => request.status === 'pending').length;
    }
    return [...groups.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

