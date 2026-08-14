/**
 * Neighborhood pocket grouping for street sweep blocks.
 *
 * A route only stops bouncing if it finishes a pocket before leaving it. The
 * road-aware context already supplies an accessGroupKey (streets sharing one
 * real entrance), but that key is only available when a road network was
 * fetched. Without it every street becomes an independent top-level block, so
 * block ordering is free to leave a subdivision and re-enter it later — the
 * doubling-back reps see on the map.
 *
 * Providers report a subdivision/neighborhood name on the property record, so
 * that label is the cheapest reliable pocket signal we already own. It is used
 * only as a fallback: a road-derived access key always wins.
 *
 * Guard: a label is trusted only when its blocks are geographically compact.
 * Subdivision names repeat across a metro (and some providers return a broad
 * area name), and welding distant blocks into one atomic pocket would create
 * exactly the long jumps this is meant to remove.
 */

const MAX_POCKET_SPAN_MILES = 1.5;

function normalizeLabel(value) {
    if (value === undefined || value === null) return '';
    return String(value)
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/[^A-Za-z0-9 ]/g, '')
        .toUpperCase();
}

function blockDoors(block) {
    return block?.variants?.[0] || [];
}

/** Most common subdivision label across a block's doors. */
function blockNeighborhoodLabel(block) {
    const counts = new Map();
    blockDoors(block).forEach((door) => {
        const label = normalizeLabel(door?.subdivision_name);
        if (label) counts.set(label, (counts.get(label) || 0) + 1);
    });
    if (counts.size === 0) return '';
    return [...counts.entries()].sort((first, second) => (
        second[1] - first[1] || (first[0] < second[0] ? -1 : 1)
    ))[0][0];
}

function spanMiles(blocks) {
    let widest = 0;
    for (let first = 0; first < blocks.length - 1; first++) {
        for (let second = first + 1; second < blocks.length; second++) {
            const x = (blocks[second].lng - blocks[first].lng)
                * Math.cos((blocks[first].lat + blocks[second].lat) / 2 * Math.PI / 180);
            const y = blocks[second].lat - blocks[first].lat;
            widest = Math.max(widest, Math.sqrt(x * x + y * y) * 69);
        }
    }
    return widest;
}

/**
 * @param {Array} streetBlocks Blocks from buildStreetSweepBlocks.
 * @returns {Map<string, string>} block key -> pocket label, for compact
 *   multi-street neighborhoods only. Blocks absent from the map keep their
 *   existing (access key or per-street) grouping.
 */
export function resolveNeighborhoodPockets(streetBlocks) {
    const byLabel = new Map();
    streetBlocks.forEach((block) => {
        // A road-derived access key is ground truth; never override it.
        if (block.accessKey) return;
        const label = blockNeighborhoodLabel(block);
        if (!label) return;
        if (!byLabel.has(label)) byLabel.set(label, []);
        byLabel.get(label).push(block);
    });

    const pockets = new Map();
    byLabel.forEach((blocks, label) => {
        if (blocks.length < 2) return;
        if (spanMiles(blocks) > MAX_POCKET_SPAN_MILES) return;
        blocks.forEach(block => pockets.set(block.key, label));
    });
    return pockets;
}