// The granularity layer of the K-way route splitter.
//
// WHY THIS EXISTS
// The old splitter had exactly one currency: a home's position in a single global
// street sweep. Cutting that 1-D ribbon into K contiguous ranges is what produced
// interleaved ribbons, split subdivisions and repeated entrances — a sweep is a
// good DRIVING ORDER and a bad TERRITORY BOUNDARY, because consecutive sweep
// indexes can be far apart on the road network wherever the sweep turns.
//
// A territory partitioner needs the opposite currency: indivisible pieces of
// geography whose size matches the requested workload. That is what an ATOM is.
//
//   homes  ->  street blocks  ->  routing units (pocket / access group)
//
// The hierarchy itself is NOT redefined here. Blocks come from
// `buildStreetBlocks` (the definition the road matrix already groups by) and
// units come from `buildRoutingUnits` (whose pockets are the Canvas-validated
// topology detector), so "street block" and "protected pocket" keep meaning one
// thing across the whole system.
//
// SCALE IS THE WHOLE POINT
// Atom size follows K rather than a fixed rule, which is how the same code
// answers "2 routes" and "100 routes" from one 1,000-home territory:
//
//   K=2   target 500 homes/route -> whole regions and pockets stay intact
//   K=5   target 200            -> neighbourhoods / large pockets stay intact
//   K=20  target  50            -> street systems, some pockets subdivided
//   K=100 target  10            -> street blocks, and doors only where forced
//
// There is deliberately no rule like "never split a pocket". A pocket survives
// whenever the requested route size can hold it, and is recursively subdivided
// when it cannot — because at K=100 a 40-home cul-de-sac simply cannot be one
// route's worth of work, and refusing to divide it would make K unreachable.

import { buildStreetBlocks } from './roadAwareStreetSweep.js';
import { buildRoutingUnits } from './routingUnits.js';
import { coordinateKey, compareKeys, selectRepresentative } from './roadAwareGrouping.js';
import { isValidPoint } from './routeContinuityOptimizer.js';

export const SPLIT_ATOM_VERSION = 'split_atoms_v1';

/**
 * The largest share of one route's target workload a single atom may hold.
 *
 * An atom bigger than this cannot be packed into balanced routes and, worse,
 * leaves refinement nothing to move: with one atom per route every boundary is
 * frozen. Half a route guarantees at least two movable pieces per route while
 * still keeping natural units whole whenever the requested size allows it.
 */
export const MAX_ATOM_SHARE_OF_ROUTE = 0.5;

export const ATOM_LEVEL_UNIT = 'unit';
export const ATOM_LEVEL_BLOCK = 'block';
export const ATOM_LEVEL_DOOR_GROUP = 'door_group';

const doorIdentityOf = (door) => String(door?.address_hash || door?.id || '');

/** Deterministic door order inside a block: house number, then coordinate. */
function compareDoors(first, second) {
    const firstNumber = Number(first?.house_number);
    const secondNumber = Number(second?.house_number);
    if (Number.isFinite(firstNumber) && Number.isFinite(secondNumber) && firstNumber !== secondNumber) {
        return firstNumber - secondNumber;
    }
    return compareKeys(coordinateKey(first), coordinateKey(second))
        || compareKeys(doorIdentityOf(first), doorIdentityOf(second));
}

/** Split doors into `pieces` near-equal contiguous chunks of the door order. */
function chunkDoors(doors, pieces) {
    const ordered = [...doors].sort(compareDoors);
    const count = Math.max(1, Math.min(pieces, ordered.length));
    const base = Math.floor(ordered.length / count);
    const larger = ordered.length % count;
    const chunks = [];
    let offset = 0;
    for (let index = 0; index < count; index += 1) {
        const size = base + (index < larger ? 1 : 0);
        chunks.push(ordered.slice(offset, offset + size));
        offset += size;
    }
    return chunks;
}

function makeAtom({ key, level, doors, unitKey, blockKeys, isProtected, pocketId }) {
    return {
        key,
        level,
        doors,
        doorCount: doors.length,
        representative: selectRepresentative(doors),
        unitKey,
        blockKeys,
        protected: Boolean(isProtected),
        pocketId: pocketId || ''
    };
}

/**
 * Build the atoms this split will partition.
 *
 * @param {Array} doors every home in the source route
 * @param {number} routeCount requested K
 * @param {object} options `{ roadNetwork, territoryPolygon, routingContext,
 *   maxAtomShare }` — forwarded to `buildRoutingUnits` so pockets come from real
 *   road topology when a road network is available.
 * @returns {object} `{ ok: true, atoms, telemetry }` or `{ ok: false, code }`.
 *   Atoms are canonically ordered and partition the doors EXACTLY once; that
 *   invariant is asserted here rather than trusted, because every downstream
 *   guarantee ("N homes in, N homes out") rests on it.
 */
export function buildSplitAtoms(doors, routeCount, options = {}) {
    const valid = (Array.isArray(doors) ? doors : []).filter((door) => isValidPoint(door) && doorIdentityOf(door));
    if (valid.length !== (doors?.length || 0)) {
        return { ok: false, code: 'ATOM_INPUT_INVALID_DOORS' };
    }
    if (new Set(valid.map(doorIdentityOf)).size !== valid.length) {
        return { ok: false, code: 'ATOM_INPUT_DUPLICATE_DOORS' };
    }
    const requestedRoutes = Math.floor(Number(routeCount));
    if (!Number.isFinite(requestedRoutes) || requestedRoutes < 2) {
        return { ok: false, code: 'ATOM_INPUT_INVALID_ROUTE_COUNT' };
    }
    if (requestedRoutes > valid.length) {
        return { ok: false, code: 'ATOM_ROUTE_COUNT_EXCEEDS_DOORS' };
    }

    const model = buildRoutingUnits(valid, options);
    const blockByKey = new Map(model.blocks.map((block) => [block.key, block]));
    const targetDoorsPerRoute = valid.length / requestedRoutes;
    const share = Number(options.maxAtomShare) > 0 ? Number(options.maxAtomShare) : MAX_ATOM_SHARE_OF_ROUTE;
    const maxAtomDoors = Math.max(1, Math.floor(targetDoorsPerRoute * share));

    const atoms = [];
    let unitsSubdivided = 0;
    let blocksSubdivided = 0;

    model.units.forEach((unit) => {
        const unitBlocks = unit.blockKeys.map((key) => blockByKey.get(key)).filter(Boolean);
        const unitDoors = unitBlocks.flatMap((block) => block.doors);

        // Whole natural unit — a pocket or access group travels together.
        if (unitDoors.length <= maxAtomDoors) {
            atoms.push(makeAtom({
                key: `atom:unit:${unit.key}`,
                level: ATOM_LEVEL_UNIT,
                doors: unitDoors,
                unitKey: unit.key,
                blockKeys: [...unit.blockKeys],
                isProtected: unit.protected,
                pocketId: unit.pocketId
            }));
            return;
        }

        // Too large for the requested route size: descend one level.
        unitsSubdivided += 1;
        unitBlocks.forEach((block) => {
            if (block.doors.length <= maxAtomDoors) {
                atoms.push(makeAtom({
                    key: `atom:block:${block.key}`,
                    level: ATOM_LEVEL_BLOCK,
                    doors: block.doors,
                    unitKey: unit.key,
                    blockKeys: [block.key],
                    isProtected: unit.protected,
                    pocketId: unit.pocketId
                }));
                return;
            }
            // Last resort: a single street block that alone exceeds the route
            // size is cut into door groups along its own house order.
            blocksSubdivided += 1;
            chunkDoors(block.doors, Math.ceil(block.doors.length / maxAtomDoors)).forEach((chunk, index) => {
                atoms.push(makeAtom({
                    key: `atom:doors:${block.key}#${index}`,
                    level: ATOM_LEVEL_DOOR_GROUP,
                    doors: chunk,
                    unitKey: unit.key,
                    blockKeys: [block.key],
                    isProtected: unit.protected,
                    pocketId: unit.pocketId
                }));
            });
        });
    });

    // K must be reachable. If natural units left fewer atoms than routes, the
    // largest atoms are halved until there are enough pieces to seed K routes.
    let guard = valid.length * 2;
    while (atoms.length < requestedRoutes && guard > 0) {
        guard -= 1;
        const splitIndex = atoms.reduce((best, atom, index) => {
            if (atom.doorCount < 2) return best;
            if (best < 0) return index;
            return atom.doorCount > atoms[best].doorCount
                || (atom.doorCount === atoms[best].doorCount && compareKeys(atom.key, atoms[best].key) < 0)
                ? index
                : best;
        }, -1);
        if (splitIndex < 0) break;
        const source = atoms[splitIndex];
        const halves = chunkDoors(source.doors, 2);
        atoms.splice(splitIndex, 1, ...halves.map((chunk, index) => makeAtom({
            key: `${source.key}/${index}`,
            level: ATOM_LEVEL_DOOR_GROUP,
            doors: chunk,
            unitKey: source.unitKey,
            blockKeys: source.blockKeys,
            isProtected: source.protected,
            pocketId: source.pocketId
        })));
        if (source.level !== ATOM_LEVEL_DOOR_GROUP) blocksSubdivided += 1;
    }
    if (atoms.length < requestedRoutes) {
        return { ok: false, code: 'TOO_FEW_ATOMS_FOR_ROUTE_COUNT', atomCount: atoms.length };
    }

    const ordered = [...atoms].sort((first, second) => compareKeys(first.key, second.key));
    const coveredDoors = ordered.flatMap((atom) => atom.doors).map(doorIdentityOf);
    if (coveredDoors.length !== valid.length || new Set(coveredDoors).size !== valid.length) {
        // Not recoverable and never papered over: an atom set that does not
        // partition the doors would silently lose or duplicate homes.
        return { ok: false, code: 'ATOM_PARTITION_NOT_EXACT_ONCE' };
    }

    return {
        ok: true,
        atoms: ordered,
        telemetry: {
            atom_version: SPLIT_ATOM_VERSION,
            atom_count: ordered.length,
            door_count: valid.length,
            requested_route_count: requestedRoutes,
            target_doors_per_route: Math.round(targetDoorsPerRoute * 100) / 100,
            max_atom_doors: maxAtomDoors,
            atom_levels: {
                unit: ordered.filter((atom) => atom.level === ATOM_LEVEL_UNIT).length,
                block: ordered.filter((atom) => atom.level === ATOM_LEVEL_BLOCK).length,
                door_group: ordered.filter((atom) => atom.level === ATOM_LEVEL_DOOR_GROUP).length
            },
            protected_atom_count: ordered.filter((atom) => atom.protected).length,
            units_subdivided: unitsSubdivided,
            blocks_subdivided: blocksSubdivided,
            street_block_count: model.blockCount,
            routing_unit_count: model.unitCount,
            pocket_count: model.pockets.length,
            pocket_provenance: model.pocketProvenance
        }
    };
}