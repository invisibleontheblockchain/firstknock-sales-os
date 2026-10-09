export { durationLabel, shiftMilliseconds } from '../../base44/shared/timeClock.js';
export { clockPresetDates, clockDateRangeInZone, zonedClockDate, summarizeTimeClock, DEFAULT_CLOCK_TIMEZONE } from '../../base44/shared/timeClock.js';
import { shiftMilliseconds, summarizeTimeClock } from '../../base44/shared/timeClock.js';

export function localClockDate(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function clockDateRange(start, end) {
    const parse = value => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
        const [year, month, day] = value.split('-').map(Number);
        const date = new Date(year, month - 1, day);
        return localClockDate(date) === value ? date : null;
    };
    const first = parse(start);
    const last = parse(end);
    if (!first || !last || first > last) return null;
    // Advance the calendar day instead of adding 24 hours across daylight saving changes.
    last.setDate(last.getDate() + 1);
    if (last.getTime() - first.getTime() > 367 * 86400000) return null;
    return { start: first.getTime(), end: last.getTime(), start_at: first.toISOString(), end_at: last.toISOString() };
}

const csvCell = value => {
    let text = String(value ?? '');
    if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
};

export function timeClockCsv(shifts, range, now) {
    const rows = [['Name', 'Email', 'Clock in (UTC)', 'Clock out (UTC)', 'Status', 'Hours in selected range', 'Closed by user ID', 'Shift ID', 'Range start (UTC)', 'Range end exclusive (UTC)']];
    for (const shift of shifts) {
        const start = Math.max(Date.parse(shift.clock_in_at), range.start);
        const end = Math.min(shift.clock_out_at ? Date.parse(shift.clock_out_at) : now, range.end);
        rows.push([shift.rep_name, shift.rep_email, shift.clock_in_at, shift.clock_out_at || '', shift.status,
            (Math.max(0, end - start) / 3600000).toFixed(4), shift.closed_by || '', shift.id, range.start_at, range.end_at]);
    }
    return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}

export function downloadTimeClockCsv(shifts, range, now, start, end) {
    const url = URL.createObjectURL(new Blob([timeClockCsv(shifts, range, now)], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `time-clock_${start}_${end}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function timesheetCsv(shifts, range, now, timezone, format = 'totals', people = []) {
    let rows;
    if (format === 'totals') {
        rows = [['Name', 'User ID', 'Completed hours', 'Completed shifts', 'Open shifts', 'Pending correction requests', 'Reporting timezone', 'Range start (UTC)', 'Range end exclusive (UTC)']];
        for (const person of summarizeTimeClock(shifts, range, now, people)) rows.push([person.name, person.id,
            (person.completed_ms / 3600000).toFixed(2), person.completed_shifts, person.open_shifts, person.requests, timezone, range.start_at, range.end_at]);
    } else {
        rows = [['Name', 'User ID', 'Clock in (UTC)', 'Clock out (UTC)', 'Shift hours', 'Completed hours in selected range', 'Reporting timezone', 'Adjusted', 'Shift ID', 'Range start (UTC)', 'Range end exclusive (UTC)']];
        for (const shift of shifts.filter(shift => shift.status === 'closed')) rows.push([shift.rep_name || shift.rep_email, shift.rep_user_id,
            shift.clock_in_at, shift.clock_out_at, (shiftMilliseconds(shift, now) / 3600000).toFixed(2),
            (shiftMilliseconds(shift, now, range) / 3600000).toFixed(2), timezone, shift.adjusted ? 'Yes' : 'No', shift.id, range.start_at, range.end_at]);
    }
    return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}

export function downloadTimesheetCsv(shifts, range, now, timezone, format, people, start, end) {
    const url = URL.createObjectURL(new Blob([timesheetCsv(shifts, range, now, timezone, format, people)], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `timesheets-${format}_${start}_${end}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function clockInputValue(value, timezone) {
    if (!value) return '';
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

export function clockInputInstant(value, timezone, original = '') {
    // Preserve an unchanged ambiguous timestamp (the repeated hour at DST's end).
    if (original && clockInputValue(original, timezone) === value) return original;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) throw new Error('Enter a valid date and time.');
    const normalized = value.length === 16 ? `${value}:00` : value;
    const target = Date.parse(`${normalized}Z`);
    if (!Number.isFinite(target)) throw new Error('Enter a valid date and time.');
    let candidate = target;
    for (let attempt = 0; attempt < 5; attempt++) {
        const wall = Date.parse(`${clockInputValue(candidate, timezone)}Z`);
        if (wall === target) return new Date(candidate).toISOString();
        candidate += target - wall;
    }
    throw new Error('That time does not exist in the reporting timezone.');
}
