// Geography classification for the real Precision benchmark corpus.
//
// WHY THIS IS A MODULE AND NOT INLINE SCRIPT CODE
// The corpus is only trustworthy if territories were chosen by their topology
// BEFORE any decomposition candidate ran against them. That ordering is a claim
// about process, and a claim about process has to be auditable — so the rules that
// assign a territory to a geography class live here, as pure functions over the
// property rows and the OSM features, with no route, no mileage, and no candidate
// result anywhere in scope. Nothing in this file can see how a solver performed,
// so it cannot be tuned toward a flattering answer.
//
// NOT PRODUCTION CODE. Nothing under scripts/ is imported by the app or by
// base44/. The geography labels this produces are corpus metadata for humans
// reading the report; the solver never receives them, because a solver that knows
// it is being handed a "cul-de-sac heavy" fixture is no longer the solver we ship.

const EARTH_MILES = 3958.7613;

const toRad = (deg) => (deg * Math.PI) / 180;

/** Great-circle miles. Used only to describe a territory, never to price a route. */
export function haversineMiles(a, b) {
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Street-type suffixes that only exist because a street does not continue.
 * A court/cove/circle/place/dead end is a road-topology fact recorded in the
 * address itself, which is why suffix mix is usable evidence without a graph.
 */
const TERMINAL_SUFFIXES = new Set(['ct', 'court', 'cv', 'cove', 'cir', 'circle', 'pl', 'place', 'ter', 'terrace', 'loop', 'way', 'trl', 'trail']);
const THROUGH_SUFFIXES = new Set(['st', 'street', 'ave', 'avenue', 'rd', 'road', 'blvd', 'boulevard', 'hwy', 'highway', 'pkwy', 'parkway', 'dr', 'drive', 'ln', 'lane']);

function suffixOf(streetName) {
    const parts = String(streetName || '').trim().toLowerCase().replace(/[.,]/g, '').split(/\s+/);
    return parts.length > 1 ? parts[parts.length - 1] : '';
}

/** Bounding box of a door set, plus the span in miles along each axis. */
export function territoryBounds(doors) {
    const lats = doors.map((d) => d.lat);
    const lngs = doors.map((d) => d.lng);
    const box = {
        minLat: Math.min(...lats),
        maxLat: Math.max(...lats),
        minLng: Math.min(...lngs),
        maxLng: Math.max(...lngs)
    };
    const centre = { lat: (box.minLat + box.maxLat) / 2, lng: (box.minLng + box.maxLng) / 2 };
    return {
        ...box,
        centre,
        heightMiles: haversineMiles({ lat: box.minLat, lng: centre.lng }, { lat: box.maxLat, lng: centre.lng }),
        widthMiles: haversineMiles({ lat: centre.lat, lng: box.minLng }, { lat: centre.lat, lng: box.maxLng })
    };
}

/**
 * Describe a door set using only the doors themselves.
 *
 * Every number here is a property of the real addresses and their placement:
 * how tightly packed they are, how much of the address inventory sits on streets
 * that terminate, and how many distinct streets carry how many doors. These are
 * the traits that decide whether a decomposition cut is cheap or expensive.
 */
export function describeDoorGeography(doors) {
    const bounds = territoryBounds(doors);
    const areaSqMi = Math.max(bounds.heightMiles * bounds.widthMiles, 0.0001);

    const byStreet = new Map();
    let terminalDoors = 0;
    let throughDoors = 0;
    for (const door of doors) {
        const street = String(door.street_name || '').trim().toLowerCase();
        byStreet.set(street, (byStreet.get(street) || 0) + 1);
        const suffix = suffixOf(door.street_name);
        if (TERMINAL_SUFFIXES.has(suffix)) terminalDoors += 1;
        else if (THROUGH_SUFFIXES.has(suffix)) throughDoors += 1;
    }
    const streetDoorCounts = [...byStreet.values()].sort((a, b) => b - a);

    // Nearest-neighbour spacing is the honest density signal: a bbox can be
    // inflated by one distant door, but the median gap between a door and its
    // closest neighbour describes how the doors actually sit on the ground.
    const sample = doors.length > 400 ? doors.filter((_, i) => i % Math.ceil(doors.length / 400) === 0) : doors;
    const nearest = sample.map((door) => {
        let best = Infinity;
        for (const other of doors) {
            if (other === door) continue;
            const miles = haversineMiles(door, other);
            if (miles < best) best = miles;
        }
        return best;
    }).filter(Number.isFinite).sort((a, b) => a - b);

    return {
        door_count: doors.length,
        bbox_height_miles: round(bounds.heightMiles),
        bbox_width_miles: round(bounds.widthMiles),
        area_sq_mi: round(areaSqMi),
        doors_per_sq_mi: Math.round(doors.length / areaSqMi),
        median_nearest_neighbour_miles: round(nearest[Math.floor(nearest.length / 2)]),
        p90_nearest_neighbour_miles: round(nearest[Math.floor(nearest.length * 0.9)]),
        distinct_streets: byStreet.size,
        median_doors_per_street: streetDoorCounts[Math.floor(streetDoorCounts.length / 2)] || 0,
        terminal_street_door_pct: pct(terminalDoors, doors.length),
        through_street_door_pct: pct(throughDoors, doors.length),
        centre: { lat: round6(bounds.centre.lat), lng: round6(bounds.centre.lng) }
    };
}

/**
 * Describe the barriers a territory contains, from OSM features fetched for its
 * bounding box. A barrier is what makes two doors aerially near and road-far, so
 * this is the part of the classification a door list cannot supply.
 *
 * @param {object} features `{ waterwayMeters, waterBodyCount, motorwayMeters, railwayMeters, bridgeCount }`
 */
export function describeBarriers(features, geography) {
    const perSqMi = (value) => round(Number(value || 0) / Math.max(geography.area_sq_mi, 0.0001));
    return {
        waterway_meters_per_sq_mi: perSqMi(features.waterwayMeters),
        water_body_count: Number(features.waterBodyCount || 0),
        motorway_meters_per_sq_mi: perSqMi(features.motorwayMeters),
        railway_meters_per_sq_mi: perSqMi(features.railwayMeters),
        bridge_count: Number(features.bridgeCount || 0)
    };
}

/**
 * Assign a geography class from the measured traits.
 *
 * Ordered most-specific first: a barrier territory is defined by its barrier even
 * when it is also dense, because the barrier is what the decomposition has to
 * respect. `mixed_geography` is the honest label for a territory whose traits do
 * not concentrate — not a dumping ground, an actual class in the corpus.
 *
 * Returns `{ geography, rationale }`; the rationale is the evidence sentence that
 * goes in the fixture, so a reviewer can check the label against the numbers.
 */
export function classifyGeography(geography, barriers) {
    const g = geography;
    const b = barriers;
    const reasons = [];

    const dense = g.doors_per_sq_mi >= 900;
    const sparse = g.doors_per_sq_mi < 250;
    const verySparse = g.doors_per_sq_mi < 90;
    const terminalHeavy = g.terminal_street_door_pct >= 34;
    const waterHeavy = b.waterway_meters_per_sq_mi >= 700 || b.water_body_count >= 4;
    const motorwayHeavy = b.motorway_meters_per_sq_mi >= 500;
    const fewStreetsManyDoors = g.distinct_streets > 0 && g.door_count / g.distinct_streets >= 22;

    if (waterHeavy && !verySparse) {
        reasons.push(`${b.waterway_meters_per_sq_mi} m/sq mi of waterway and ${b.water_body_count} water bodies force road detours between aerially near doors`);
        return { geography: 'river_lake_barrier', rationale: reasons.join('; ') };
    }
    if (motorwayHeavy) {
        reasons.push(`${b.motorway_meters_per_sq_mi} m/sq mi of motorway/trunk splits the territory into crossing-limited sides`);
        return { geography: 'highway_separated', rationale: reasons.join('; ') };
    }
    if (fewStreetsManyDoors && terminalHeavy) {
        reasons.push(`${g.door_count} doors on only ${g.distinct_streets} streets (${g.terminal_street_door_pct}% on terminating streets) — one collector feeding interior branches`);
        return { geography: 'single_entry_subdivision', rationale: reasons.join('; ') };
    }
    if (terminalHeavy) {
        reasons.push(`${g.terminal_street_door_pct}% of doors sit on court/cove/circle/place streets that do not continue`);
        return { geography: 'cul_de_sac_heavy', rationale: reasons.join('; ') };
    }
    if (dense && g.through_street_door_pct >= 45) {
        reasons.push(`${g.doors_per_sq_mi} doors/sq mi with ${g.through_street_door_pct}% on through streets and ${g.median_nearest_neighbour_miles} mi median door spacing`);
        return { geography: 'dense_suburban_grid', rationale: reasons.join('; ') };
    }
    if (verySparse) {
        reasons.push(`${g.doors_per_sq_mi} doors/sq mi with ${g.p90_nearest_neighbour_miles} mi p90 door spacing — long single-lane runs between doors`);
        return { geography: 'rural', rationale: reasons.join('; ') };
    }
    if (sparse) {
        reasons.push(`${g.doors_per_sq_mi} doors/sq mi over ${g.area_sq_mi} sq mi — detached pockets separated by undeveloped road`);
        return { geography: 'sparse_exurban', rationale: reasons.join('; ') };
    }
    reasons.push(`no single trait dominates: ${g.doors_per_sq_mi} doors/sq mi, ${g.terminal_street_door_pct}% terminating-street doors, ${b.waterway_meters_per_sq_mi} m/sq mi waterway`);
    return { geography: 'mixed_geography', rationale: reasons.join('; ') };
}

export const CORPUS_GEOGRAPHIES = [
    'dense_suburban_grid',
    'cul_de_sac_heavy',
    'single_entry_subdivision',
    'river_lake_barrier',
    'highway_separated',
    'sparse_exurban',
    'rural',
    'mixed_geography'
];

function round(value) {
    return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

function round6(value) {
    return Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : null;
}

function pct(part, whole) {
    return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}