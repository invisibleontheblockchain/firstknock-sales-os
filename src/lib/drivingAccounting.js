export { tripMiles, tripPayment, drivingTotals } from '../../base44/shared/drivingAccounting.js';

export function localDrivingDate(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function csvCell(value) {
    let text = String(value ?? '');
    // Spreadsheet applications interpret even quoted leading formula characters.
    if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
}

export function drivingCsv(trips, start, end) {
    const headers = ['Rep', 'Email', 'Trip date', 'From', 'To', 'Business purpose', 'Vehicle', 'Start odometer (mi)', 'End odometer (mi)', 'Miles (odometer)', 'Status', 'Rate (USD/mile)', 'Reimbursement (USD)', 'Notes', 'Trip ID', 'Recorded by user ID', 'Recorded at', 'Approved by user ID', 'Approved at', 'Paid by user ID', 'Paid at', 'Payment reference', 'Review reason', 'Reviewed by user ID', 'Reviewed at', 'Report start', 'Report end'];
    const rows = trips.map(t => [t.rep_name, t.rep_email, t.trip_date, t.origin, t.destination, t.purpose, t.vehicle,
        Number(t.odometer_start).toFixed(1), Number(t.odometer_end).toFixed(1), Number(t.miles).toFixed(1), t.status,
        t.rate_per_mile ?? '', t.reimbursement_cents == null ? '' : (t.reimbursement_cents / 100).toFixed(2),
        t.notes, t.id, t.recorded_by, t.created_date, t.approved_by, t.approved_at, t.paid_by, t.paid_at,
        t.payment_reference, t.review_note, t.reviewed_by, t.reviewed_at, start, end]);
    return '\uFEFF' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
}

export function downloadDrivingCsv(trips, start, end, name = 'team') {
    const url = URL.createObjectURL(new Blob([drivingCsv(trips, start, end)], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `driving_${name.replace(/[^a-z0-9_-]/gi, '_')}_${start}_${end}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
