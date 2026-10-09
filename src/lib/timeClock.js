export { durationLabel, shiftMilliseconds } from '../../base44/shared/timeClock.js';

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
