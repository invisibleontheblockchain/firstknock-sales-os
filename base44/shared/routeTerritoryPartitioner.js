// The K-way road-territory partitioner: the replacement membership engine.
//
// WHAT REPLACED WHAT
// Old model: optimize all N homes into one global street sweep, then cut that
// sweep into K contiguous index ranges. Membership was therefore a side effect of
// a DRIVING ORDER, which is why it produced ribbons, interleaving, split
// subdivisions and several reps entering the same pocket. No road distance took
// part in the decision at any point.
//
// New model, and the division of labour that makes it safe:
//
//   SPLITTER (here)            decides WHICH homes each route owns
//   frozen Precision optimizer decides WHAT ORDER each route drives
//
// The frozen optimizer is never modified, never partially invoked, and never
// second-guessed: it is called once per produced route, through an injected
// function, and its output is then measured independently.
//
// HOW MEMBERSHIP IS DECIDED
//   1. atoms        indivisible pieces sized to the requested workload
//                   (`splitAtoms.js` — units at low K, blocks/doors at high K)
//   2. road costs   one rectangular atom-to-atom table of real driving miles
//   3. seeds        K seeds spread by ROAD distance, not by map distance
//   4. growth       capacitated road growth: an atom joins the route it is
//                   nearest to BY ROAD that still has room
//   5. refinement   boundary moves, swaps and whole-pocket moves between
//                   neighbouring routes, accepted only when the road-priced
//                   objective drops — the splitter's answer to the seam/hotspot
//                   refinement that worked in the Precision optimizer
//   6. portfolio    several legitimate partitions compete
//   7. selection    each finalist is optimized by the frozen solver and
//                   INDEPENDENTLY measured; lowest combined real mileage wins
//
// THE TWO OBJECTIVES, AND WHY THERE ARE TWO
// Selection is decided by independently measured combined road miles — the
// product truth. Refinement cannot afford that (K frozen-solver runs and K
// measurements per candidate move), so it uses a surrogate: a road-priced tour
// over each route's atom representatives. The surrogate is built from the SAME
// OSRM miles as everything else, never from straight-line distance, and it is
// only ever used to CHOOSE moves — never to report a mileage or to pick the
// winner. Every atom is indivisible, so the cost inside an atom is identical in
// every partition and correctly excluded from the surrogate.
//
// Geometry appears in exactly one place: the deterministic first seed. Every
// decision that can trap a route — which route an atom belongs to — is priced on
// the road network, and an unresolvable road cost fails the split rather than
// falling back to a guess.

import { buildSplitAtoms } from './splitAtoms.js';
import { computeSplitQualityMetrics } from './splitQualityMetrics.js';
import { coordinateKey, compareKeys } from './roadAwareGrouping.js';
import { fetchRoadCostRows, MAX_ROUTE_MATRIX_POINTS } from './roadMatrix.js';
import {
    BALANCE_POLICIES,
    DEFAULT_BALANCE_POLICY_ID,
    resolveBalanceBounds,
    evaluateBalance
} from './splitBalanceContract.js';
import { buildLegacySweepMembership } from './legacySweepCandidate.js';

export const SPLIT_PARTITIONER_VERSION = 'road_territory_partitioner_v1';

/**
 * Balance tolerance: how far a route's home count may sit from N/K.
 *
 * Deliberately not zero. The old splitter enforced exact floor/ceil equality,
 * and that equality is precisely what forced cuts through subdivisions — for
 * 1,000 homes at K=5, 198/203/195/201/203 is a better product than five exact
 * 200s bought by sending three reps into one neighbourhood. 6% of a route is
 * wide enough to respect a natural boundary and tight enough that no rep gets a
 * visibly unfair day. Benchmarkable: it is an option, and the split report
 * publishes the deviation actually achieved.
 */
export const DEFAULT_BALANCE_TOLERANCE = 0.06;

/** Atom-to-atom table ceiling. Beyond this the road table stops being affordable. */
export const MAX_SPLIT_ATOMS = 700;

/** Road-nearest neighbours kept per atom — the adjacency refinement works over. */
const NEIGHBOURS_PER_ATOM = 6;

const REFINEMENT_PASSES = 4;
const TWO_OPT_ATOM_LIMIT = 60;

const doorIdentityOf = (door) => String(door?.address_hash || door?.id || '');

/** Fetch the full atom-to-atom road table, chunked to the destination ceiling. */
async function fetchAtomRoadCosts(atoms, options) {
    const points = atoms.map((atom) => atom.representative);
    const fetchRows = options.fetchRows || fetchRoadCostRows;
    const rows = points.map(() => new Array(points.length).fill(null));
    let requestCount = 0;

    for (let start = 0; start < points.length; start += MAX_ROUTE_MATRIX_POINTS) {
        const end = Math.min(start + MAX_ROUTE_MATRIX_POINTS, points.length);
        const measured = await fetchRows(points, points.slice(start, end), {
            baseUrl: options.baseUrl,
            profile: options.profile || 'driving',
            timeoutMs: options.timeoutMs
        });
        requestCount += measured.requestCount || 0;
        measured.rows.forEach((row, rowIndex) => {
            row.forEach((miles, columnIndex) => {
                rows[rowIndex][start + columnIndex] = miles;
            });
        });
    }

    if (rows.some((row) => row.some((value) => !Number.isFinite(value)))) {
        throw new Error('Atom road cost table is incomplete.');
    }
    return { rows, requestCount };
}

/** Road cost between two atoms, symmetrized for grouping decisions. */
const makeSymmetricCost = (rows) => (first, second) => (rows[first][second] + rows[second][first]) / 2;

/** Each atom's road-nearest neighbours: the adjacency refinement moves along. */
function buildNeighbours(atomCount, cost) {
    return Array.from({ length: atomCount }, (_, index) => {
        const ranked = [];
        for (let other = 0; other < atomCount; other += 1) {
            if (other !== index) ranked.push({ other, miles: cost(index, other) });
        }
        ranked.sort((first, second) => (
            Math.abs(first.miles - second.miles) > 1e-9 ? first.miles - second.miles : first.other - second.other
        ));
        return ranked.slice(0, NEIGHBOURS_PER_ATOM).map((entry) => entry.other);
    });
}

/**
 * K seeds spread by ROAD distance (farthest-point sampling on driving miles).
 * The first seed is chosen geometrically — lowest coordinate key — purely so the
 * sequence is deterministic; every seed after it maximizes real road distance to
 * the seeds already chosen, so two sides of a river or a highway are seeded
 * separately without anyone describing a river to the code.
 */
function selectSeeds(atoms, cost, routeCount, firstIndex) {
    const seeds = [firstIndex];
    while (seeds.length < routeCount) {
        let bestIndex = -1;
        let bestGap = -1;
        for (let index = 0; index < atoms.length; index += 1) {
            if (seeds.includes(index)) continue;
            const nearest = seeds.reduce((min, seed) => Math.min(min, cost(index, seed)), Infinity);
            if (nearest > bestGap + 1e-9) {
                bestGap = nearest;
                bestIndex = index;
            }
        }
        if (bestIndex < 0) break;
        seeds.push(bestIndex);
    }
    return seeds;
}

/**
 * Capacitated road growth into exactly K regions.
 *
 * Every seed opens its own region, so K non-empty routes exist by construction.
 * Each remaining atom joins the region it is road-nearest to, biased against
 * regions that are already full: `loadPenalty` is how strongly balance competes
 * with road proximity, and it is what different portfolio candidates vary.
 *
 * Capacity is a preference, not a wall. When no region can take an atom within
 * tolerance it is placed in its road-nearest region anyway and the relaxation is
 * counted, because losing a home would be a far worse failure than an uneven day.
 */
function growRegions(atoms, cost, seeds, options) {
    const { capacity, loadPenalty, minLoad = 0 } = options;
    const routeCount = seeds.length;
    const regionOf = new Array(atoms.length).fill(-1);
    const members = seeds.map((seedIndex) => [seedIndex]);
    const load = seeds.map((seedIndex) => atoms[seedIndex].doorCount);
    seeds.forEach((seedIndex, region) => { regionOf[seedIndex] = region; });

    // bestCost[atom][region]: road cost from the atom to the NEAREST atom already
    // in that region, so growth follows road access rather than a region centroid.
    const bestCost = new Float64Array(atoms.length * routeCount).fill(Infinity);
    for (let atom = 0; atom < atoms.length; atom += 1) {
        if (regionOf[atom] >= 0) continue;
        for (let region = 0; region < routeCount; region += 1) {
            bestCost[atom * routeCount + region] = cost(atom, seeds[region]);
        }
    }

    let unassigned = atoms.length - routeCount;
    let relaxations = 0;
    while (unassigned > 0) {
        // The lower bound is enforced HERE, not only in refinement. Without it
        // growth could abandon a seed region at one or two homes, refinement had
        // no reason to fill it (a 1-home route is a very short tour, which the
        // surrogate likes), and the report still called the split balanced.
        //
        // It is enforced as a RESERVE, not as a fill-everyone-first phase. Homes
        // are handed out on road proximity as before, and under-filled regions get
        // exclusive claim only once the homes still unassigned are no more than
        // what those regions need to reach their floor. Restricting earlier than
        // that measurably distorts the split — an unconditional needy-first phase
        // grows one blob to its floor before any other region starts, and cost
        // Route 1I 19.5 miles at K=2.
        const needy = new Set();
        let totalDeficit = 0;
        let doorsUnassigned = 0;
        for (let region = 0; region < routeCount; region += 1) {
            if (load[region] < minLoad) {
                needy.add(region);
                totalDeficit += minLoad - load[region];
            }
        }
        for (let atom = 0; atom < atoms.length; atom += 1) {
            if (regionOf[atom] < 0) doorsUnassigned += atoms[atom].doorCount;
        }
        const reserveForNeedy = needy.size > 0 && doorsUnassigned <= totalDeficit;

        let chosenAtom = -1;
        let chosenRegion = -1;
        let chosenScore = Infinity;
        let fallbackAtom = -1;
        let fallbackRegion = -1;
        let fallbackScore = Infinity;

        for (let atom = 0; atom < atoms.length; atom += 1) {
            if (regionOf[atom] >= 0) continue;
            const doors = atoms[atom].doorCount;
            for (let region = 0; region < routeCount; region += 1) {
                const miles = bestCost[atom * routeCount + region];
                if (!Number.isFinite(miles)) continue;
                const score = miles * (1 + loadPenalty * (load[region] / capacity));
                const fits = load[region] + doors <= capacity
                    && (!reserveForNeedy || needy.has(region));
                if (fits && score < chosenScore - 1e-12) {
                    chosenScore = score;
                    chosenAtom = atom;
                    chosenRegion = region;
                }
                if (score < fallbackScore - 1e-12) {
                    fallbackScore = score;
                    fallbackAtom = atom;
                    fallbackRegion = region;
                }
            }
        }

        if (chosenAtom < 0) {
            if (fallbackAtom < 0) return { ok: false, code: 'GROWTH_COULD_NOT_PLACE_ATOM' };
            chosenAtom = fallbackAtom;
            chosenRegion = fallbackRegion;
            relaxations += 1;
        }

        regionOf[chosenAtom] = chosenRegion;
        members[chosenRegion].push(chosenAtom);
        load[chosenRegion] += atoms[chosenAtom].doorCount;
        unassigned -= 1;

        for (let atom = 0; atom < atoms.length; atom += 1) {
            if (regionOf[atom] >= 0) continue;
            const slot = atom * routeCount + chosenRegion;
            const miles = cost(atom, chosenAtom);
            if (miles < bestCost[slot]) bestCost[slot] = miles;
        }
    }

    return { ok: true, regionOf, members: members.map((list) => [...list].sort((a, b) => a - b)), load, relaxations };
}

/**
 * Repair workload bounds before mileage refinement.
 *
 * Growth follows road proximity and can consume the last conveniently-sized atom
 * before every region reaches its floor. This phase permits only balance-improving
 * moves, choosing the road-nearest legal donor atom. Mileage refinement runs only
 * after every route is in band, so it can never buy mileage with an unfair day.
 */
function repairBalance(atoms, cost, partition, { minLoad, capacity }) {
    const regionOf = [...partition.regionOf];
    const members = partition.members.map((list) => [...list]);
    const load = [...partition.load];
    let moves = 0;
    let guard = atoms.length * 4;
    const violation = (value) => Math.max(0, minLoad - value) + Math.max(0, value - capacity);
    const totalViolation = () => load.reduce((sum, value) => sum + violation(value), 0);

    while (guard > 0 && totalViolation() > 0) {
        guard -= 1;
        let best = null;

        // Prefer one-atom transfers that reduce total homes outside the band.
        for (let donor = 0; donor < members.length; donor += 1) {
            if (members[donor].length <= 1) continue;
            for (let recipient = 0; recipient < members.length; recipient += 1) {
                if (recipient === donor) continue;
                for (const atom of members[donor]) {
                    const doors = atoms[atom].doorCount;
                    const before = violation(load[donor]) + violation(load[recipient]);
                    const after = violation(load[donor] - doors) + violation(load[recipient] + doors);
                    const improvement = before - after;
                    if (improvement <= 0) continue;
                    const roadGap = members[recipient].reduce((nearest, other) => Math.min(nearest, cost(atom, other)), Infinity);
                    if (!best || improvement > best.improvement
                        || (improvement === best.improvement && roadGap < best.roadGap)) {
                        best = { type: 'move', atom, donor, recipient, doors, improvement, roadGap };
                    }
                }
            }
        }

        // Coarse atoms can require exchanging a larger donor atom for a smaller
        // recipient atom. The exchange is still accepted only when it reduces the
        // declared workload violation.
        if (!best) {
            for (let firstRegion = 0; firstRegion < members.length; firstRegion += 1) {
                for (let secondRegion = firstRegion + 1; secondRegion < members.length; secondRegion += 1) {
                    for (const firstAtom of members[firstRegion]) {
                        for (const secondAtom of members[secondRegion]) {
                            const firstDoors = atoms[firstAtom].doorCount;
                            const secondDoors = atoms[secondAtom].doorCount;
                            const before = violation(load[firstRegion]) + violation(load[secondRegion]);
                            const nextFirst = load[firstRegion] - firstDoors + secondDoors;
                            const nextSecond = load[secondRegion] - secondDoors + firstDoors;
                            const improvement = before - violation(nextFirst) - violation(nextSecond);
                            if (improvement <= 0) continue;
                            const roadGap = cost(firstAtom, secondAtom);
                            if (!best || improvement > best.improvement
                                || (improvement === best.improvement && roadGap < best.roadGap)) {
                                best = {
                                    type: 'swap', firstRegion, secondRegion, firstAtom, secondAtom,
                                    firstDoors, secondDoors, improvement, roadGap
                                };
                            }
                        }
                    }
                }
            }
        }
        if (!best) break;

        if (best.type === 'move') {
            members[best.donor] = members[best.donor].filter((index) => index !== best.atom);
            members[best.recipient].push(best.atom);
            load[best.donor] -= best.doors;
            load[best.recipient] += best.doors;
            regionOf[best.atom] = best.recipient;
        } else {
            members[best.firstRegion] = members[best.firstRegion].filter((index) => index !== best.firstAtom);
            members[best.secondRegion] = members[best.secondRegion].filter((index) => index !== best.secondAtom);
            members[best.firstRegion].push(best.secondAtom);
            members[best.secondRegion].push(best.firstAtom);
            load[best.firstRegion] += best.secondDoors - best.firstDoors;
            load[best.secondRegion] += best.firstDoors - best.secondDoors;
            regionOf[best.firstAtom] = best.secondRegion;
            regionOf[best.secondAtom] = best.firstRegion;
        }
        members.forEach((list) => list.sort((a, b) => a - b));
        moves += 1;
    }

    const valid = load.every((value) => value >= minLoad && value <= capacity);
    return { ok: valid, regionOf, members, load, relaxations: partition.relaxations, balanceRepairs: moves };
}

/**
 * The road-priced surrogate for one route: a nearest-neighbour tour over its
 * atoms with a bounded 2-opt pass, in real driving miles. Used ONLY to compare
 * candidate moves — never reported as the route's mileage, which always comes
 * from independent measurement of the frozen solver's output.
 */
function surrogateMiles(atomIndexes, rows) {
    if (atomIndexes.length < 2) return 0;
    const remaining = new Set(atomIndexes);
    const start = atomIndexes[0];
    const order = [start];
    remaining.delete(start);
    let current = start;
    while (remaining.size > 0) {
        let nextIndex = -1;
        let nextMiles = Infinity;
        remaining.forEach((candidate) => {
            const miles = rows[current][candidate];
            if (miles < nextMiles - 1e-12 || (Math.abs(miles - nextMiles) <= 1e-12 && candidate < nextIndex)) {
                nextMiles = miles;
                nextIndex = candidate;
            }
        });
        order.push(nextIndex);
        remaining.delete(nextIndex);
        current = nextIndex;
    }

    const legs = (sequence) => {
        let total = 0;
        for (let index = 0; index < sequence.length - 1; index += 1) total += rows[sequence[index]][sequence[index + 1]];
        return total;
    };
    let best = legs(order);
    if (order.length <= TWO_OPT_ATOM_LIMIT) {
        let improved = true;
        while (improved) {
            improved = false;
            for (let first = 1; first < order.length - 1 && !improved; first += 1) {
                for (let second = first + 1; second < order.length; second += 1) {
                    const candidate = [
                        ...order.slice(0, first),
                        ...order.slice(first, second + 1).reverse(),
                        ...order.slice(second + 1)
                    ];
                    const miles = legs(candidate);
                    if (miles < best - 1e-9) {
                        order.splice(0, order.length, ...candidate);
                        best = miles;
                        improved = true;
                        break;
                    }
                }
            }
        }
    }
    return best;
}

/**
 * Boundary refinement: the splitter equivalent of seam/hotspot repair.
 *
 * Only atoms on a real road boundary are candidates, and only the two affected
 * routes are re-priced per move. A move survives only when K is intact, balance
 * stays inside tolerance, exact-once is preserved by construction (an atom moves,
 * never copies) and the combined road-priced objective strictly decreases.
 */
function refineBoundaries(atoms, rows, neighbours, partition, options) {
    const { capacity, minLoad, passes = REFINEMENT_PASSES } = options;
    const regionOf = [...partition.regionOf];
    const members = partition.members.map((list) => new Set(list));
    const load = [...partition.load];
    const objective = members.map((set) => surrogateMiles([...set].sort((a, b) => a - b), rows));
    const unitAtoms = new Map();
    atoms.forEach((atom, index) => {
        if (!unitAtoms.has(atom.unitKey)) unitAtoms.set(atom.unitKey, []);
        unitAtoms.get(atom.unitKey).push(index);
    });

    const scoreOf = (set) => surrogateMiles([...set].sort((a, b) => a - b), rows);
    const stats = { moves: 0, swaps: 0, unit_moves: 0, evaluations: 0 };

    const tryRelocate = (movingAtoms, fromRegion, toRegion) => {
        if (fromRegion === toRegion) return false;
        const doors = movingAtoms.reduce((sum, index) => sum + atoms[index].doorCount, 0);
        if (members[fromRegion].size === movingAtoms.length) return false; // would empty a route
        if (load[toRegion] + doors > capacity) return false;
        if (load[fromRegion] - doors < minLoad) return false;

        const nextFrom = new Set(members[fromRegion]);
        const nextTo = new Set(members[toRegion]);
        movingAtoms.forEach((index) => {
            nextFrom.delete(index);
            nextTo.add(index);
        });
        stats.evaluations += 1;
        const delta = (scoreOf(nextFrom) + scoreOf(nextTo)) - (objective[fromRegion] + objective[toRegion]);
        if (delta >= -1e-6) return false;

        members[fromRegion] = nextFrom;
        members[toRegion] = nextTo;
        objective[fromRegion] = scoreOf(nextFrom);
        objective[toRegion] = scoreOf(nextTo);
        load[fromRegion] -= doors;
        load[toRegion] += doors;
        movingAtoms.forEach((index) => { regionOf[index] = toRegion; });
        return true;
    };

    const trySwap = (firstAtom, secondAtom) => {
        const firstRegion = regionOf[firstAtom];
        const secondRegion = regionOf[secondAtom];
        if (firstRegion === secondRegion) return false;
        const firstDoors = atoms[firstAtom].doorCount;
        const secondDoors = atoms[secondAtom].doorCount;
        const firstLoad = load[firstRegion] - firstDoors + secondDoors;
        const secondLoad = load[secondRegion] - secondDoors + firstDoors;
        if (firstLoad > capacity || secondLoad > capacity) return false;
        if (firstLoad < minLoad || secondLoad < minLoad) return false;

        const nextFirst = new Set(members[firstRegion]);
        const nextSecond = new Set(members[secondRegion]);
        nextFirst.delete(firstAtom);
        nextFirst.add(secondAtom);
        nextSecond.delete(secondAtom);
        nextSecond.add(firstAtom);
        stats.evaluations += 1;
        const delta = (scoreOf(nextFirst) + scoreOf(nextSecond)) - (objective[firstRegion] + objective[secondRegion]);
        if (delta >= -1e-6) return false;

        members[firstRegion] = nextFirst;
        members[secondRegion] = nextSecond;
        objective[firstRegion] = scoreOf(nextFirst);
        objective[secondRegion] = scoreOf(nextSecond);
        load[firstRegion] = firstLoad;
        load[secondRegion] = secondLoad;
        regionOf[firstAtom] = secondRegion;
        regionOf[secondAtom] = firstRegion;
        return true;
    };

    for (let pass = 0; pass < passes; pass += 1) {
        let improved = false;

        // Whole natural areas first: moving a complete pocket is the move that
        // removes a repeated entrance, and it is worth trying before shaving
        // individual blocks off a boundary.
        [...unitAtoms.entries()]
            .sort((first, second) => compareKeys(first[0], second[0]))
            .forEach(([, indexes]) => {
                const regions = new Set(indexes.map((index) => regionOf[index]));
                if (regions.size !== 1) return;
                const fromRegion = [...regions][0];
                const targets = new Set(indexes.flatMap((index) => neighbours[index].map((n) => regionOf[n])));
                targets.forEach((toRegion) => {
                    if (improved) return;
                    if (tryRelocate(indexes, fromRegion, toRegion)) {
                        stats.unit_moves += 1;
                        improved = true;
                    }
                });
            });

        for (let atom = 0; atom < atoms.length; atom += 1) {
            const fromRegion = regionOf[atom];
            const foreign = neighbours[atom].filter((other) => regionOf[other] !== fromRegion);
            for (const other of foreign) {
                if (tryRelocate([atom], fromRegion, regionOf[other])) {
                    stats.moves += 1;
                    improved = true;
                    break;
                }
                if (trySwap(atom, other)) {
                    stats.swaps += 1;
                    improved = true;
                    break;
                }
            }
        }
        if (!improved) break;
    }

    return {
        regionOf,
        members: members.map((set) => [...set].sort((a, b) => a - b)),
        load,
        surrogateMiles: objective.reduce((sum, miles) => sum + miles, 0),
        stats
    };
}

/**
 * Seed strategies. Each is a legitimate whole-territory partition strategy, and
 * each is later crossed with every balance policy to form the portfolio.
 *
 * `includeExtraSeeds` is used only when the portfolio has been measured to
 * collapse — at K<=5 on Route 1I the four base strategies produced just two
 * distinct memberships, so the search was half as wide as it appeared. Extra
 * anchors are generated in response to measured duplication, never speculatively,
 * because every additional distinct candidate costs a refinement pass.
 */
function candidateStrategies(atoms, cost, { includeExtraSeeds = false } = {}) {
    const canonicalFirst = atoms
        .map((atom, index) => ({ index, key: coordinateKey(atom.representative) }))
        .sort((first, second) => compareKeys(first.key, second.key))[0].index;
    // An alternative deterministic anchor: the atom whose total road cost to
    // everything else is highest, i.e. the most peripheral place in the
    // territory. Seeding from a periphery instead of a corner produces a
    // genuinely different partition, not a rotation of the same one.
    const byPeriphery = atoms
        .map((_, index) => ({
            index,
            total: atoms.reduce((sum, __, other) => sum + (other === index ? 0 : cost(index, other)), 0)
        }))
        .sort((first, second) => second.total - first.total || first.index - second.index);
    const peripheralFirst = byPeriphery[0].index;

    const base = [
        { id: 'topology_first', firstSeed: canonicalFirst, loadPenalty: 0.05 },
        { id: 'balanced_road_growth', firstSeed: canonicalFirst, loadPenalty: 0.35 },
        { id: 'peripheral_seeds', firstSeed: peripheralFirst, loadPenalty: 0.2 },
        { id: 'balance_led', firstSeed: peripheralFirst, loadPenalty: 0.7 }
    ];
    if (!includeExtraSeeds) return base;

    // Distinct anchors, deliberately far from the two the base set already uses:
    // the second and third most peripheral atoms, and the most CENTRAL one, which
    // grows regions outward from the middle instead of inward from an edge.
    const secondPeripheral = byPeriphery[Math.min(1, byPeriphery.length - 1)].index;
    const thirdPeripheral = byPeriphery[Math.min(2, byPeriphery.length - 1)].index;
    const centralFirst = byPeriphery[byPeriphery.length - 1].index;
    return [
        ...base,
        { id: 'second_periphery', firstSeed: secondPeripheral, loadPenalty: 0.15 },
        { id: 'third_periphery', firstSeed: thirdPeripheral, loadPenalty: 0.45 },
        { id: 'central_outward', firstSeed: centralFirst, loadPenalty: 0.25 }
    ];
}

/**
 * Optimize and independently measure one candidate's K routes.
 *
 * This is where the frozen Precision optimizer runs — once per route, on that
 * route's homes only, untouched. The mileage that decides the winner comes from
 * `measurePath`, a separate measurement of the order the solver returned, so a
 * candidate can never be selected on its own internal estimate.
 */
async function verifyCandidate(members, atoms, options) {
    const { optimizeRoute, measurePath } = options;
    const routes = [];
    for (const atomIndexes of members) {
        const doors = atomIndexes.flatMap((index) => atoms[index].doors);
        const optimized = await optimizeRoute(doors);
        const order = Array.isArray(optimized?.order) ? optimized.order : null;
        if (!order || order.length !== doors.length) {
            return { ok: false, code: 'ROUTE_OPTIMIZATION_FAILED' };
        }
        const identities = order.map(doorIdentityOf);
        if (new Set(identities).size !== doors.length
            || identities.some((identity) => !identity)
            || new Set(doors.map(doorIdentityOf)).size !== doors.length) {
            return { ok: false, code: 'ROUTE_OPTIMIZATION_CHANGED_MEMBERSHIP' };
        }
        const measured = await measurePath(order);
        if (!measured?.ok || !Number.isFinite(measured.totalMiles)) {
            // Fail rather than guess: an unmeasured route cannot take part in a
            // comparison whose entire authority is measured mileage.
            return { ok: false, code: 'ROUTE_MEASUREMENT_FAILED', reason: measured?.error || null };
        }
        routes.push({
            atomIndexes,
            doors,
            order,
            doorCount: doors.length,
            verifiedRoadMiles: measured.totalMiles,
            optimizerMetadata: optimized.metadata || null
        });
    }
    return {
        ok: true,
        routes,
        combinedVerifiedRoadMiles: routes.reduce((sum, route) => sum + route.verifiedRoadMiles, 0)
    };
}

/**
 * Which balance policies this run competes over.
 *
 * `balanceTolerance` stays supported as a single custom policy so controlled
 * single-variable experiments (the K=5 diagnosis) keep working unchanged.
 */
function resolveRequestedPolicies(options) {
    if (Number.isFinite(Number(options.balanceTolerance))) {
        return [{ id: 'custom', tolerance: Math.max(0, Number(options.balanceTolerance)) }];
    }
    const requested = Array.isArray(options.balancePolicies) ? options.balancePolicies : null;
    if (!requested || requested.length === 0) return BALANCE_POLICIES;
    const resolved = requested
        .map((entry) => (typeof entry === 'string'
            ? BALANCE_POLICIES.find((policy) => policy.id === entry)
            : entry))
        .filter((policy) => policy && Number.isFinite(Number(policy.tolerance)));
    return resolved.length > 0 ? resolved : BALANCE_POLICIES;
}

/** Membership identity, independent of which route got which label. */
const membershipSignature = (members) => members
    .map((list) => list.join(','))
    .sort()
    .join('|');

/**
 * Partition a territory into exactly K route memberships.
 *
 * @param {Array} doors every home in the source route
 * @param {number} routeCount requested K (>= 2)
 * @param {object} options `{ optimizeRoute, measurePath, fetchRows, roadNetwork,
 *   territoryPolygon, routingContext, balanceTolerance, verifyCandidates,
 *   baseUrl, profile, timeoutMs }`. `optimizeRoute(doors)` must return
 *   `{ order }` from the frozen Precision optimizer and `measurePath(order)`
 *   must return `{ ok, totalMiles }` from independent road measurement. Both are
 *   injected so this module can be exercised offline against a recorded network.
 * @returns {Promise<object>} `{ ok: true, routes, report, atoms }` or
 *   `{ ok: false, code }`. Never a partial split: any failure returns ok:false
 *   and the caller keeps the route it already had.
 */
export async function partitionRouteTerritories(doors, routeCount, options = {}) {
    const startedAt = Date.now();
    if (typeof options.optimizeRoute !== 'function' || typeof options.measurePath !== 'function') {
        return { ok: false, code: 'VERIFICATION_FUNCTIONS_REQUIRED' };
    }

    const built = buildSplitAtoms(doors, routeCount, options);
    if (!built.ok) return built;
    const atoms = built.atoms;
    if (atoms.length > MAX_SPLIT_ATOMS) {
        return { ok: false, code: 'TOO_MANY_ATOMS_FOR_ROAD_TABLE', atomCount: atoms.length };
    }

    let table;
    try {
        table = await fetchAtomRoadCosts(atoms, options);
    } catch (error) {
        return { ok: false, code: 'SPLIT_ROAD_COST_UNAVAILABLE', reason: error.message };
    }
    const rows = table.rows;
    const cost = makeSymmetricCost(rows);
    const neighbours = buildNeighbours(atoms.length, cost);

    const doorCount = atoms.reduce((sum, atom) => sum + atom.doorCount, 0);
    const largestAtom = atoms.reduce((max, atom) => Math.max(max, atom.doorCount), 0);
    const policies = resolveRequestedPolicies(options);
    const legacyOrder = Array.isArray(options.legacySweepOrder) && options.legacySweepOrder.length === doors.length
        ? options.legacySweepOrder
        : null;

    const attempted = [];
    const bySignature = new Map();

    /** Build one candidate, price it, and score it against its balance contract. */
    const runCandidate = (id, bounds, produce) => {
        const produced = produce();
        if (!produced.ok) {
            attempted.push({ id, policy_id: bounds.policy_id, ok: false, code: produced.code });
            return;
        }
        const members = produced.members;
        if (members.length !== routeCount || members.some((list) => list.length === 0)) {
            attempted.push({ id, policy_id: bounds.policy_id, ok: false, code: 'PARTITION_LOST_A_ROUTE' });
            return;
        }
        const signature = membershipSignature(members);
        const homesPerRoute = members.map((list) => list.reduce((sum, index) => sum + atoms[index].doorCount, 0));
        attempted.push({
            id,
            policy_id: bounds.policy_id,
            ok: true,
            members,
            signature,
            duplicate_of: bySignature.get(signature) || null,
            surrogate_road_miles: Math.round(
                members.reduce((sum, list) => sum + surrogateMiles(list, rows), 0) * 1000
            ) / 1000,
            homes_per_route: homesPerRoute,
            balance: evaluateBalance(homesPerRoute, bounds),
            bounds,
            growth_bound_relaxations: produced.relaxations ?? null,
            balance_repair_moves: produced.balanceRepairs ?? 0,
            refinement: produced.refinement || null
        });
        if (!bySignature.has(signature)) bySignature.set(signature, id);
    };

    /** Every seed strategy crossed with every balance policy, plus the old sweep. */
    const runPortfolio = (strategies) => {
        policies.forEach((policy) => {
            const bounds = resolveBalanceBounds(doorCount, routeCount, policy, { largestAtomHomes: largestAtom });
            if (!bounds.feasible) {
                attempted.push({ id: `policy_${bounds.policy_id}`, policy_id: bounds.policy_id, ok: false, code: 'BALANCE_BOUNDS_INFEASIBLE' });
                return;
            }
            // An atom holding more homes than the band allows cannot be divided,
            // so capacity has to admit it. That is reported as its own condition
            // rather than folded into the balance numbers.
            const capacity = Math.max(largestAtom, bounds.max_homes_allowed);
            const minLoad = bounds.min_homes_allowed;

            strategies.forEach((strategy) => runCandidate(`${strategy.id}@${bounds.policy_id}`, bounds, () => {
                const seeds = selectSeeds(atoms, cost, routeCount, strategy.firstSeed);
                if (seeds.length !== routeCount) return { ok: false, code: 'SEEDING_INCOMPLETE' };
                const grown = growRegions(atoms, cost, seeds, { capacity, minLoad, loadPenalty: strategy.loadPenalty });
                if (!grown.ok) return { ok: false, code: grown.code };
                const repaired = repairBalance(atoms, cost, grown, { capacity, minLoad });
                if (!repaired.ok) return { ok: false, code: 'BALANCE_REPAIR_FAILED' };
                const refined = refineBoundaries(atoms, rows, neighbours, repaired, { capacity, minLoad });
                return {
                    ok: true,
                    members: refined.members,
                    relaxations: grown.relaxations,
                    balanceRepairs: repaired.balanceRepairs,
                    refinement: refined.stats
                };
            }));

            // The old sweep-slice split as one more competitor, so the system can
            // never knowingly ship a higher-mileage split than the old model.
            if (legacyOrder) {
                runCandidate(`legacy_sweep@${bounds.policy_id}`, bounds, () => {
                    const legacy = buildLegacySweepMembership(atoms, legacyOrder, routeCount, bounds);
                    return legacy.ok ? { ok: true, members: legacy.members, relaxations: 0 } : legacy;
                });
            }
        });
    };

    runPortfolio(candidateStrategies(atoms, cost));
    // Extra anchors ONLY when the portfolio is measured to have collapsed into
    // too few distinct memberships — not whenever more candidates might be nice.
    const viableBefore = attempted.filter((candidate) => candidate.ok).length;
    let extraSeedsGenerated = false;
    if (bySignature.size < Math.min(4, viableBefore)) {
        extraSeedsGenerated = true;
        runPortfolio(candidateStrategies(atoms, cost, { includeExtraSeeds: true }).slice(4));
    }

    const okCandidates = attempted.filter((candidate) => candidate.ok);
    const diversity = {
        candidate_count: attempted.length,
        viable_candidate_count: okCandidates.length,
        distinct_partition_count: bySignature.size,
        duplicate_candidates: okCandidates.filter((candidate) => candidate.duplicate_of).length,
        extra_seeds_generated: extraSeedsGenerated,
        balance_policies_tried: policies.map((policy) => policy.id),
        legacy_sweep_candidate_included: Boolean(legacyOrder)
    };
    const summarize = (candidate) => ({
        id: candidate.id,
        policy_id: candidate.policy_id,
        ok: candidate.ok,
        code: candidate.code || null,
        surrogate_road_miles: candidate.surrogate_road_miles ?? null,
        homes_per_route: candidate.homes_per_route ?? null,
        balance: candidate.balance ?? null,
        duplicate_of: candidate.duplicate_of ?? null
    });

    // VALIDITY FIRST. A lower-mileage but invalidly imbalanced candidate must
    // never beat a balanced one, so invalid candidates are removed before mileage
    // is even consulted. Shipping an invalid split requires the caller to enter
    // relaxation mode explicitly, and the report says so.
    // Two tiers, tried in order. Candidates inside the declared band always win
    // outright; only if none exists do candidates that miss the band by less than
    // one indivisible atom compete, and that is recorded as the selection tier.
    // Anything outside even that band is never a finalist.
    const balanceValid = okCandidates.filter((candidate) => candidate.balance.balance_valid);
    const balanceEligible = okCandidates.filter((candidate) => candidate.balance.balance_eligible);
    const selectionTier = balanceValid.length > 0
        ? 'in_declared_band'
        : (balanceEligible.length > 0 ? 'within_atom_granularity_slack' : 'none');
    const relaxationMode = selectionTier !== 'in_declared_band';
    if (selectionTier !== 'in_declared_band' && options.allowBalanceRelaxation !== true) {
        return {
            ok: false,
            code: 'NO_BALANCE_VALID_PARTITION',
            diversity,
            balance_selection_tier: selectionTier,
            candidates: attempted.map(summarize)
        };
    }

    const seenSignatures = new Set();
    const pool = (selectionTier === 'in_declared_band'
        ? balanceValid
        : (selectionTier === 'within_atom_granularity_slack' ? balanceEligible : okCandidates))
        .sort((first, second) => first.surrogate_road_miles - second.surrogate_road_miles
            || compareKeys(first.id, second.id))
        .filter((candidate) => {
            if (seenSignatures.has(candidate.signature)) return false; // same membership, already paid for
            seenSignatures.add(candidate.signature);
            return true;
        });
    if (pool.length === 0) {
        return { ok: false, code: 'NO_VIABLE_PARTITION', diversity, candidates: attempted.map(summarize) };
    }

    // Only the strongest surrogate finalists are paid for in frozen-solver runs
    // and real measurements; the winner among them is chosen on measured miles.
    const verifyCount = Math.max(1, Math.min(
        Number.isFinite(Number(options.verifyCandidates)) ? Number(options.verifyCandidates) : 2,
        pool.length
    ));
    let winner = null;
    const candidateReport = [];
    for (const candidate of pool.slice(0, verifyCount)) {
        const verified = await verifyCandidate(candidate.members, atoms, options);
        candidateReport.push({
            ...summarize(candidate),
            growth_bound_relaxations: candidate.growth_bound_relaxations,
            refinement: candidate.refinement,
            verified: verified.ok,
            verification_code: verified.ok ? null : verified.code,
            combined_verified_road_miles: verified.ok
                ? Math.round(verified.combinedVerifiedRoadMiles * 1000) / 1000
                : null
        });
        if (!verified.ok) continue;
        if (!winner || verified.combinedVerifiedRoadMiles < winner.combinedVerifiedRoadMiles - 1e-9) {
            winner = { ...verified, id: candidate.id, candidate };
        }
    }
    pool.slice(verifyCount).forEach((candidate) => candidateReport.push({
        ...summarize(candidate),
        verified: false,
        verification_code: 'NOT_SELECTED_FOR_VERIFICATION',
        combined_verified_road_miles: null
    }));
    attempted.filter((candidate) => !candidate.ok).forEach((candidate) => candidateReport.push({
        ...summarize(candidate),
        verified: false,
        verification_code: candidate.code,
        combined_verified_road_miles: null
    }));

    if (!winner) {
        return { ok: false, code: 'NO_VERIFIED_PARTITION', diversity, candidates: candidateReport };
    }

    const report = computeSplitQualityMetrics({
        requestedRouteCount: routeCount,
        doorCount,
        atoms,
        routes: winner.routes,
        neighbours,
        runtimeMs: Date.now() - startedAt,
        roadRequestCount: table.requestCount,
        cacheStats: typeof options.cacheStats === 'function' ? options.cacheStats() : null,
        candidates: candidateReport,
        balance: winner.candidate.balance,
        balanceBounds: winner.candidate.bounds,
        diversity
    });
    // Contract, re-checked on the way out rather than assumed from the algorithm.
    if (!report.exact_once || !report.route_count_exact || report.door_count_out !== doorCount) {
        return { ok: false, code: 'SPLIT_INVARIANT_VIOLATED', report };
    }
    if (!report.balance_valid && !relaxationMode) {
        return { ok: false, code: 'BALANCE_CONTRACT_VIOLATED', report };
    }

    return {
        ok: true,
        partitioner_version: SPLIT_PARTITIONER_VERSION,
        selected_candidate: winner.id,
        routes: winner.routes,
        atoms,
        report: {
            ...report,
            partitioner_version: SPLIT_PARTITIONER_VERSION,
            selected_candidate: winner.id,
            selected_balance_policy: winner.candidate.policy_id,
            balance_selection_tier: selectionTier,
            balance_relaxation_mode: relaxationMode,
            eligible_min_homes: winner.candidate.bounds.eligible_min_homes,
            eligible_max_homes: winner.candidate.bounds.eligible_max_homes,
            capacity_per_route: Math.max(largestAtom, winner.candidate.bounds.max_homes_allowed),
            atom_forced_capacity: largestAtom > winner.candidate.bounds.max_homes_allowed,
            ...built.telemetry
        }
    };
}