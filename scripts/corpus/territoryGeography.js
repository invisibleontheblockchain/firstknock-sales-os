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
 * The aerial separation band a barrier measurement is taken across, and the
 * absolute road excess that counts as a limited crossing.
 *
 * WHY A BAND AND NOT NEAREST NEIGHBOURS (this was measured wrong once)
 * The first version of this measurement compared each door to its NEAREST
 * neighbour and scored the road/aerial RATIO. On real doors those neighbours sit
 * 35-140 ft apart, so driving around one ordinary block — half a mile of
 * perfectly normal road — scored as a 72x detour. Every territory in the
 * shortlist came back "severed", including a 2,252-door/sq-mi grid with one pond
 * in the bbox. A ratio over a distance smaller than a house frontage measures
 * block geometry, not severance.
 *
 * So severance is measured where a decomposition actually has to decide: pairs a
 * quarter-mile apart, the scale of a window cut. And it is scored in ABSOLUTE
 * excess road miles, because what costs a route is the extra driving, not the
 * multiple. Two doors 0.25 mi apart that cost 1.1 mi of road are behind
 * something; the same ratio on touching doors is a street.
 */
export const DETOUR_BAND_MIN_MILES = 0.1;
export const DETOUR_BAND_MAX_MILES = 0.5;
export const DETOUR_BAND_TARGET_MILES = 0.25;
export const LIMITED_CROSSING_EXCESS_MILES = 0.75;
export const MIN_MEASURED_BAND_PAIRS = 20;

/**
 * Measure how far the road network stretches quarter-mile aerial gaps.
 *
 * A barrier is what makes two doors aerially near and road-far, and only the road
 * network can report that — metres of mapped stream cannot, because nearly every
 * developed bbox contains streams and ponds. So the classification asks OSRM
 * directly, over a deterministic sample of pairs inside the separation band.
 *
 * `sampleRoadPairs(pairs)` must return road miles per pair in order. It receives
 * real coordinates and returns real network distance; no candidate ordering is
 * involved, so this stays input-side evidence that cannot be tuned by a result.
 *
 * @returns {Promise<object>} `{ ok, pairs, excess_median_miles, excess_p95_miles,
 *   limited_crossing_pct, detour_median, detour_p95 }`
 */
export async function measureDetourProfile(doors, sampleRoadPairs, {
    pairCount = 120,
    minAerialMiles = DETOUR_BAND_MIN_MILES,
    maxAerialMiles = DETOUR_BAND_MAX_MILES,
    targetAerialMiles = DETOUR_BAND_TARGET_MILES
} = {}) {
    // Deterministic band sample: a stable stride of anchors, each paired with the
    // door closest to the target separation. A rerun measures the identical pairs.
    const stride = Math.max(1, Math.floor(doors.length / pairCount));
    const pairs = [];
    for (let i = 0; i < doors.length && pairs.length < pairCount; i += stride) {
        const from = doors[i];
        let best = null;
        let bestGap = Infinity;
        for (const other of doors) {
            if (other === from) continue;
            const miles = haversineMiles(from, other);
            if (miles < minAerialMiles || miles > maxAerialMiles) continue;
            const gap = Math.abs(miles - targetAerialMiles);
            if (gap < bestGap) { bestGap = gap; best = { to: other, aerialMiles: miles }; }
        }
        if (best) pairs.push({ from, to: best.to, aerialMiles: best.aerialMiles });
    }
    if (!pairs.length) return { ok: false, error: 'NO_BAND_PAIRS' };

    const roadMiles = await sampleRoadPairs(pairs);
    const measured = pairs
        .map((pair, index) => (Number.isFinite(roadMiles[index]) && roadMiles[index] >= pair.aerialMiles
            ? { excess: roadMiles[index] - pair.aerialMiles, ratio: roadMiles[index] / pair.aerialMiles }
            : null))
        .filter(Boolean);
    // A percentile over a handful of pairs is not a measurement. Below this the
    // profile reports failure and the territory keeps its density class, rather
    // than earning a barrier label from three lucky pairs.
    if (measured.length < MIN_MEASURED_BAND_PAIRS) return { ok: false, error: 'INSUFFICIENT_ROAD_PAIRS' };

    const excess = measured.map((m) => m.excess).sort((a, b) => a - b);
    const ratios = measured.map((m) => m.ratio).sort((a, b) => a - b);
    return {
        ok: true,
        pairs: measured.length,
        band_min_miles: minAerialMiles,
        band_max_miles: maxAerialMiles,
        excess_median_miles: round(excess[Math.floor(excess.length / 2)]),
        excess_p95_miles: round(excess[Math.floor(excess.length * 0.95)]),
        // A quarter-mile neighbour that costs an extra 0.75 mi of road is reached
        // through a constrained crossing, not along the street in front of it.
        limited_crossing_pct: pct(measured.filter((m) => m.excess >= LIMITED_CROSSING_EXCESS_MILES).length, measured.length),
        detour_median: round(ratios[Math.floor(ratios.length / 2)]),
        detour_p95: round(ratios[Math.floor(ratios.length * 0.95)])
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
export function classifyGeography(geography, barriers, detour = null) {
    const g = geography;
    const b = barriers;
    const reasons = [];

    const dense = g.doors_per_sq_mi >= 900;
    const sparse = g.doors_per_sq_mi < 250;
    const verySparse = g.doors_per_sq_mi < 90;
    const terminalHeavy = g.terminal_street_door_pct >= 34;
    const fewStreetsManyDoors = g.distinct_streets > 0 && g.door_count / g.distinct_streets >= 22;

    // Barrier classes require MEASURED severance in absolute road miles, not merely
    // mapped water or road, and not a ratio taken across touching doors. The detour
    // profile says a constrained crossing is present; the OSM counts then say which
    // kind it is. Water wins ties because a river is crossed at bridges only, while
    // a motorway usually offers more crossings per mile of barrier.
    const severed = detour?.ok === true
        && detour.excess_p95_miles >= LIMITED_CROSSING_EXCESS_MILES
        && detour.limited_crossing_pct >= 15;
    if (severed) {
        const evidence = `quarter-mile neighbours cost +${detour.excess_p95_miles} mi of road at p95 with ${detour.limited_crossing_pct}% past +${LIMITED_CROSSING_EXCESS_MILES} mi`;
        const waterEvidence = b.waterway_meters_per_sq_mi >= 1500 || b.water_body_count >= 8;
        const motorwayEvidence = b.motorway_meters_per_sq_mi >= 1000 || b.railway_meters_per_sq_mi >= 1000;
        if (waterEvidence && !motorwayEvidence) {
            reasons.push(`${evidence}, against ${b.water_body_count} water bodies and ${b.waterway_meters_per_sq_mi} m/sq mi waterway`);
            return { geography: 'river_lake_barrier', rationale: reasons.join('; ') };
        }
        if (motorwayEvidence && !waterEvidence) {
            reasons.push(`${evidence}, against ${b.motorway_meters_per_sq_mi} m/sq mi motorway/trunk and ${b.railway_meters_per_sq_mi} m/sq mi railway`);
            return { geography: 'highway_separated', rationale: reasons.join('; ') };
        }
        if (waterEvidence && motorwayEvidence) {
            reasons.push(`${evidence}, with both water (${b.water_body_count} bodies, ${b.waterway_meters_per_sq_mi} m/sq mi) and corridor (${b.motorway_meters_per_sq_mi} m/sq mi motorway, ${b.railway_meters_per_sq_mi} m/sq mi railway) barriers`);
            return { geography: 'mixed_geography', rationale: reasons.join('; ') };
        }
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
    reasons.push(`no single trait dominates: ${g.doors_per_sq_mi} doors/sq mi, ${g.terminal_street_door_pct}% terminating-street doors, detour p95 ${detour?.detour_p95 ?? 'unmeasured'}x`);
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