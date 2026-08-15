// Road distance for specific door pairs, used only as territory-selection evidence.
//
// The detour profile needs the network distance of ~120 hand-picked pairs, not an
// N x N matrix, so pairs are batched into small tables and only the diagonal cells
// that correspond to real pairs are read. This keeps the selection pass cheap
// enough to run before any candidate does, which is the ordering the corpus
// depends on.
//
// NOT PRODUCTION CODE — research tooling under scripts/.

const OSRM_BASE = 'https://router.project-osrm.org';
const PAIRS_PER_REQUEST = 12;
const METERS_PER_MILE = 1609.344;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {Array<{from: {lat,lng}, to: {lat,lng}}>} pairs
 * @returns {Promise<Array<number|null>>} road miles per pair, in order; null when unresolved
 */
export async function sampleRoadPairs(pairs, { profile = 'driving', pauseMs = 250 } = {}) {
    const miles = new Array(pairs.length).fill(null);

    for (let start = 0; start < pairs.length; start += PAIRS_PER_REQUEST) {
        const batch = pairs.slice(start, start + PAIRS_PER_REQUEST);
        const coordinates = [];
        for (const pair of batch) {
            coordinates.push(`${pair.from.lng},${pair.from.lat}`, `${pair.to.lng},${pair.to.lat}`);
        }
        // sources are the even indexes (each pair's origin), destinations the odd ones,
        // so cell [i][i] is exactly pair i and no unrelated distances are requested.
        const sources = batch.map((_, index) => index * 2).join(';');
        const destinations = batch.map((_, index) => index * 2 + 1).join(';');
        const url = `${OSRM_BASE}/table/v1/${profile}/${coordinates.join(';')}?annotations=distance&sources=${sources}&destinations=${destinations}`;

        try {
            const response = await fetch(url, { headers: { 'User-Agent': 'FirstKnock-benchmark-corpus/1.0' } });
            if (!response.ok) throw new Error(`osrm ${response.status}`);
            const payload = await response.json();
            const table = payload?.distances;
            if (Array.isArray(table)) {
                for (let index = 0; index < batch.length; index += 1) {
                    const meters = table[index]?.[index];
                    if (Number.isFinite(meters)) miles[start + index] = meters / METERS_PER_MILE;
                }
            }
        } catch {
            // An unresolved batch leaves nulls; the caller treats too few resolved
            // pairs as an unmeasured territory rather than as a barrier-free one.
        }
        await sleep(pauseMs);
    }

    return miles;
}