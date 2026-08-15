// Deterministic input hygiene for the real Precision benchmark corpus.
//
// WHY THIS IS A VERSIONED MODULE AND NOT A FILTER INSIDE A SCAN SCRIPT
// The corpus is the racetrack. If the doors that reach a fixture depend on ad hoc
// filtering typed during one scan, then nobody — including us — can reproduce the
// fixture, and a benchmark nobody can reproduce cannot settle an argument about a
// solver. So the cleaning rule is one pure function with a version string, every
// rejection is counted by reason, and the rule is covered by tests.
//
// WHY IT MATTERS MORE THAN IT LOOKS
// The production store contains import corruption at scale: one placeholder street
// value repeats thousands of times, and blocks of records land on a single
// coordinate. A territory built out of those records would hand the solver
// hundreds of doors at zero road distance from each other, and ANY decomposition
// would score brilliantly on it. Dirty input does not just add noise, it inverts
// the benchmark.
//
// WHAT A DOOR IS (the definition the corpus is built on)
// One Precision door = one distinct postal address identity with usable
// coordinates: normalized street + house number + unit + postcode. Consequences,
// both deliberate:
//   - Two records of the SAME identity are one door, however many times the
//     provider delivered them.
//   - Two DIFFERENT identities remain two doors even when they share a coordinate.
//     Geocoders routinely snap duplexes, condo units and new-construction lots to
//     one rooftop or one street centroid, and those are real, separately knocked
//     doors. Collapsing them would quietly shrink real workload.
// The one exception is corruption, not geography: when a single coordinate carries
// more distinct identities than any real structure cluster (STACKED_COORDINATE_LIMIT),
// the coordinate is not a location, it is an import artifact, and the whole stack is
// rejected rather than trusted.
//
// NOT PRODUCTION CODE. Nothing under scripts/ is imported by the app or base44/.

export const CLEANING_RULE_VERSION = 'corpus_clean_v1';

/**
 * Distinct addresses permitted on one identical 6-decimal coordinate.
 *
 * A rooftop can legitimately host a handful of units, and a street-centroid
 * geocode can collect a few lots. Beyond this the shared point is an import
 * artifact — the observed corruption drops thousands of rows onto single points —
 * and every identity in the stack is untrustworthy, not just the extras.
 */
export const STACKED_COORDINATE_LIMIT = 8;

const PLACEHOLDER_STREET = /^(unknown|unknown\s|null|none|n\/?a|test|tbd|no\s*street|address\s*not)/i;

export const REJECTION_REASONS = [
    'invalid_coordinates',
    'placeholder_street',
    'invalid_house_number',
    'malformed_row',
    'duplicate_address_identity',
    'stacked_coordinate_overflow'
];

/** Normalized street token used for identity and for street/block construction. */
export function normalizeStreet(value) {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[.,]/g, '')
        .replace(/\s+/g, ' ');
}

function normalizeUnit(value) {
    return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Stable identity of one door. Same identity twice = one door. */
export function doorIdentity(row) {
    const street = normalizeStreet(row.street_name);
    const zip = String(row.zip_code ?? row.zip ?? '').trim().slice(0, 5);
    const unit = normalizeUnit(row.unit ?? row.unit_label);
    return `${street}|${row.house_number}|${unit}|${zip}`;
}

/** Coordinate key at 6 decimals — the resolution the provider actually delivers. */
export function coordinateKey(row) {
    return `${row.lat.toFixed(6)},${row.lng.toFixed(6)}`;
}

function coordinatesUsable(row) {
    const { lat, lng } = row;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
    // Null island: the geocoder failed and the row kept a zero default.
    if (Math.abs(lat) < 0.01 && Math.abs(lng) < 0.01) return false;
    return true;
}

/**
 * Apply the corpus cleaning rule to raw property rows.
 *
 * Rejection reasons are evaluated in a fixed order so a row that fails several
 * checks is always attributed to the same one, and two runs over the same rows in
 * any order produce the same door set.
 *
 * @param {Array<object>} rows raw property rows
 * @returns {{ version: string, raw_row_count: number, doors: Array<object>,
 *   removed: Record<string, number>, distinct_address_count: number,
 *   distinct_coordinate_count: number, max_doors_on_one_coordinate: number }}
 */
export function cleanDoorRows(rows) {
    const removed = Object.fromEntries(REJECTION_REASONS.map((reason) => [reason, 0]));
    const byIdentity = new Map();

    for (const row of rows) {
        if (!coordinatesUsable(row)) { removed.invalid_coordinates += 1; continue; }

        const street = normalizeStreet(row.street_name);
        if (!street || PLACEHOLDER_STREET.test(street)) { removed.placeholder_street += 1; continue; }

        const house = Number(row.house_number);
        if (!Number.isInteger(house) || house <= 0) { removed.invalid_house_number += 1; continue; }

        if (!row.address_hash) { removed.malformed_row += 1; continue; }

        const identity = doorIdentity({ ...row, street_name: street, house_number: house });
        if (byIdentity.has(identity)) { removed.duplicate_address_identity += 1; continue; }
        byIdentity.set(identity, { row, street, house, identity });
    }

    // Stacked-coordinate corruption is only visible across the whole set, so it is
    // judged after identity dedupe: a point carrying more distinct addresses than a
    // structure cluster can explain is an artifact, and the entire stack goes.
    const byCoordinate = new Map();
    for (const entry of byIdentity.values()) {
        const key = coordinateKey(entry.row);
        if (!byCoordinate.has(key)) byCoordinate.set(key, []);
        byCoordinate.get(key).push(entry);
    }

    const doors = [];
    let maxStack = 0;
    for (const stack of byCoordinate.values()) {
        maxStack = Math.max(maxStack, stack.length);
        if (stack.length > STACKED_COORDINATE_LIMIT) { removed.stacked_coordinate_overflow += stack.length; continue; }
        for (const entry of stack) doors.push(entry);
    }

    // Deterministic order so the fixture, and its checksum, do not depend on the
    // order the database happened to page rows out in.
    doors.sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));

    return {
        version: CLEANING_RULE_VERSION,
        raw_row_count: rows.length,
        doors: doors.map((entry) => entry.row),
        removed,
        distinct_address_count: doors.length,
        distinct_coordinate_count: new Set(doors.map((entry) => coordinateKey(entry.row))).size,
        max_doors_on_one_coordinate: maxStack
    };
}