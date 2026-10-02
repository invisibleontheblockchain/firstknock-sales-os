export class DrivingError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

export function drivingDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
        || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
        throw new DrivingError(400, 'Choose a valid trip date.');
    }
    return value;
}

function decimalUnits(value, places, max, label) {
    const text = String(value ?? '').trim();
    if (!new RegExp(`^\\d+(?:\\.\\d{1,${places}})?$`).test(text)) {
        throw new DrivingError(400, `${label} must be a non-negative number with at most ${places} decimal places.`);
    }
    const [whole, fraction = ''] = text.split('.');
    const units = Number(whole) * 10 ** places + Number(fraction.padEnd(places, '0'));
    if (!Number.isSafeInteger(units) || units > max * 10 ** places) {
        throw new DrivingError(400, `${label} is too large.`);
    }
    return units;
}

export function tripMiles(start, end) {
    const first = decimalUnits(start, 1, 1000000, 'Starting odometer');
    const last = decimalUnits(end, 1, 1000000, 'Ending odometer');
    if (last <= first) throw new DrivingError(400, 'Ending odometer must be greater than starting odometer.');
    return { odometer_start: first / 10, odometer_end: last / 10, miles: (last - first) / 10 };
}

export function tripPayment(miles, rate) {
    const tenths = decimalUnits(miles, 1, 1000000, 'Mileage');
    const rateUnits = decimalUnits(rate, 4, 10, 'Rate per mile');
    return { rate_per_mile: rateUnits / 10000, reimbursement_cents: Math.round(tenths * rateUnits / 1000) };
}

export function drivingTotals(trips) {
    const result = { trips: 0, miles: 0, submitted_miles: 0, approved_miles: 0, due_cents: 0, paid_cents: 0 };
    for (const trip of trips) {
        if (!['submitted', 'approved', 'paid'].includes(trip.status)) continue;
        result.trips += 1;
        result.miles += Math.round(trip.miles * 10);
        if (trip.status === 'submitted') result.submitted_miles += Math.round(trip.miles * 10);
        else {
            result.approved_miles += Math.round(trip.miles * 10);
            result[trip.status === 'paid' ? 'paid_cents' : 'due_cents'] += trip.reimbursement_cents || 0;
        }
    }
    for (const key of ['miles', 'submitted_miles', 'approved_miles']) result[key] /= 10;
    return result;
}
