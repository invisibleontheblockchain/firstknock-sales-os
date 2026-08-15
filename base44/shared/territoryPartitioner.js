// The single authority for splitting a territory into route-sized partitions.
//
// Stage 2, step 2. Before this module, "how do we cut a big territory" was
// answered in at least three places with three different currencies: route
// generation grouped by street corridor, the split-route flow cut an existing
// route by door count, and the matrix tier ladder silently absorbed whatever
// came out. This module is the one place that decision is made, so generation
// and splitting cannot drift apart.
//
// The rule this module exists to enforce, and the reason it takes two budgets:
//
//   ROUTING UNITS determine where we are ALLOWED to cut.
//   BLOCK COUNT determines whether OSRM can actually carry the result.
//
// They are not interchangeable. A protected pocket is ONE routing unit that may
// contain several street blocks, so a 240-unit route can hold far more than 240
// blocks and would drop to cluster tier without anyone asking for it. Cuts
// therefore land on unit boundaries only, while every emitted partition is
// validated by its real block count against the matrix budget.
//
// Deliberately runtime-agnostic ESM: no Deno, no browser, no network, no OSRM.
// Dispatch and generation wiring are later steps and must not appear here.

import { buildRoutingUnits } from './routingUnits.js';
import { MAX_BLOCKS_PER_ROUTE, MAX_HOMES_PER_ROUTE, ROUTE_ANCHOR_ALLOWANCE } from './routingBudgets.js';
import { predictMatrixTier, TIER_BLOCK, TIER_DOOR } from './roadMatrixTiers.js';
import { stableHash } from './streetTopologyCore.js';
import { balancePartitions } from './territoryBalance.js';
import {
    buildPartitionDiagnostics,
    formatPartitionDiagnostics,
    validatePartitionCoverage
} from './territoryPartitionReport.js';

// A partition may be emitted above budget ONLY when a single atomic routing unit
// is itself too large to cut. That is an explicit, recorded override — never a
// silent one — because the alternative is breaking a pocket apart.
export const OVERRIDE_UNIT_EXCEEDS_HOMES = 'unit_exceeds_home_budget';
export const OVERRIDE_UNIT_EXCEEDS_BLOCKS = 'unit_exceeds_block_budget';

const compareText = (left, right) => {
    const first = String(left);
    const second = String(right);
    if (first < second) return -1;
    if (first > second) return 1;
    return 0;
};

/**
 * Routing units with the geometry the partitioner needs to cut spatially.
 * Doors are collected in canonical block-key order so a unit's door list — and
 * therefore its centroid — never depends on input order.
 */
function describeUnits(model) {
    const blockByKey = new Map(model.blocks.map((block) => [block.key, block]));
    return model.units.map((unit) => {
        const doors = unit.blockKeys.flatMap((key) => blockByKey.get(key)?.doors || []);
        const centroid = doors.reduce(
            (total, door) => ({
                lat: total.lat + Number(door.lat) / doors.length,
                lng: total.lng + Number(door.lng) / doors.length
            }),
            { lat: 0, lng: 0 }
        );
        return {
            key: unit.key,
            protected: unit.protected,
            pocketId: unit.pocketId,
            blockKeys: unit.blockKeys,
            blockCount: unit.blockKeys.length,
            doorCount: doors.length,
            doors,
            centroid
        };
    });
}

const sumDoors = (units) => units.reduce((total, unit) => total + unit.doorCount, 0);
const sumBlocks = (units) => units.reduce((total, unit) => total + unit.blockCount, 0);

function withinBudgets(units, budgets) {
    return sumDoors(units) <= budgets.maxHomes && sumBlocks(units) <= budgets.maxBlocks;
}

/**
 * Split a unit set once, at the median of its wider axis.
 *
 * Longitude is scaled by cos(latitude) so "wider" means wider on the ground
 * rather than wider in degrees. The split index is `floor(n / 2)` of a fully
 * ordered list, so both sides are always non-empty for n >= 2 — that is what
 * guarantees the recursion terminates even when every centroid is identical.
 * Ties fall back to the unit key, so the cut is deterministic.
 */
function bisect(units) {
    const latitudes = units.map((unit) => unit.centroid.lat);
    const longitudes = units.map((unit) => unit.centroid.lng);
    const referenceLatitude = latitudes.reduce((total, value) => total + value, 0) / latitudes.length;
    const scale = Math.cos(referenceLatitude * Math.PI / 180);
    const latitudeSpan = Math.max(...latitudes) - Math.min(...latitudes);
    const longitudeSpan = (Math.max(...longitudes) - Math.min(...longitudes)) * Math.abs(scale);
    const axis = latitudeSpan >= longitudeSpan ? 'lat' : 'lng';

    const ordered = [...units].sort((first, second) => {
        const delta = first.centroid[axis] - second.centroid[axis];
        if (Math.abs(delta) > 1e-12) return delta;
        return compareText(first.key, second.key);
    });
    const middle = Math.floor(ordered.length / 2);
    return [ordered.slice(0, middle), ordered.slice(middle)];
}

/**
 * Recursive deterministic bisection down to route-sized parts.
 *
 * A part that already fits is emitted as-is. A part that does not fit is cut —
 * unless it is a single routing unit, which is atomic by definition: pockets are
 * kept whole and the overflow is recorded as an override for the caller to see.
 */
function partitionUnits(units, budgets) {
    if (units.length === 0) return [];
    if (withinBudgets(units, budgets)) return [units];
    if (units.length === 1) return [units];
    const [left, right] = bisect(units);
    return [...partitionUnits(left, budgets), ...partitionUnits(right, budgets)];
}

function overridesFor(units, budgets) {
    if (units.length !== 1) return [];
    const [unit] = units;
    const overrides = [];
    if (unit.doorCount > budgets.maxHomes) {
        overrides.push({
            code: OVERRIDE_UNIT_EXCEEDS_HOMES,
            unitKey: unit.key,
            pocketId: unit.pocketId,
            protected: unit.protected,
            doorCount: unit.doorCount,
            limit: budgets.maxHomes,
            reason: 'a single atomic routing unit exceeds the home ceiling and was kept whole'
        });
    }
    if (unit.blockCount > budgets.maxBlocks) {
        overrides.push({
            code: OVERRIDE_UNIT_EXCEEDS_BLOCKS,
            unitKey: unit.key,
            pocketId: unit.pocketId,
            protected: unit.protected,
            blockCount: unit.blockCount,
            limit: budgets.maxBlocks,
            reason: 'a single atomic routing unit exceeds the block ceiling and was kept whole'
        });
    }
    return overrides;
}

function describePartition(group, index, budgets) {
    const overrides = overridesFor(group, budgets);
    const doorCount = sumDoors(group);
    const blockCount = sumBlocks(group);
    // Requirement 6: the tier is decided from the partition's ACTUAL block
    // count, using the same rule the matrix planner uses, before this partition
    // is allowed anywhere near a road request.
    const tier = predictMatrixTier({ doorCount, blockCount, anchorCount: budgets.anchorCount });
    const unitKeys = group.map((unit) => unit.key).sort(compareText);
    return {
        index,
        // Hashing the unit set gives a stable identity for the partition that
        // does not depend on emission order — useful for cache keys and for
        // proving determinism.
        signature: `partition:${stableHash(unitKeys.join(','))}`,
        unitKeys,
        blockKeys: group.flatMap((unit) => unit.blockKeys).sort(compareText),
        doors: group.flatMap((unit) => unit.doors),
        doorCount,
        blockCount,
        unitCount: group.length,
        protectedUnitCount: group.filter((unit) => unit.protected).length,
        withinBudget: overrides.length === 0
            && doorCount <= budgets.maxHomes
            && blockCount <= budgets.maxBlocks,
        overrides,
        matrixTier: tier.ok ? tier.tier : null,
        matrixTierOk: tier.ok === true,
        matrixTierCode: tier.ok ? null : tier.code,
        // A partition is road-ready only when the tier rule puts it at block
        // tier or better. Cluster tier is still a working safety net, but it is
        // reported, never assumed.
        roadReady: tier.ok === true && (tier.tier === TIER_DOOR || tier.tier === TIER_BLOCK)
    };
}

/**
 * Partition a territory into route-sized partitions.
 *
 * @param {Array} properties every door in the territory
 * @param {object} options `{ roadNetwork, anchorCount, maxHomes, maxBlocks,
 *   allowedHighways, maxSnapMeters, balance }`. `balance: false` skips the soft
 *   evening-out pass; it never changes validity either way.
 * @returns {object} `{ partitions, units, model, validation, diagnostics,
 *   balance, overrides, budgets, stats }`. Each partition carries `unitKeys`, `blockKeys`, `doors`,
 *   `doorCount`, `blockCount`, `protectedUnitCount`, `withinBudget`,
 *   `overrides`, `matrixTier` and `signature`.
 * @throws when exactly-once coverage fails — a partition set that loses or
 *   duplicates a door must never be returned to a caller.
 */
export function partitionTerritory(properties, options = {}) {
    const anchorCount = Number.isFinite(options.anchorCount)
        ? Number(options.anchorCount)
        : ROUTE_ANCHOR_ALLOWANCE;
    const budgets = {
        maxHomes: Number(options.maxHomes) > 0 ? Number(options.maxHomes) : MAX_HOMES_PER_ROUTE,
        maxBlocks: Number(options.maxBlocks) > 0 ? Number(options.maxBlocks) : MAX_BLOCKS_PER_ROUTE,
        anchorCount
    };

    const model = buildRoutingUnits(properties, {
        roadNetwork: options.roadNetwork || null,
        allowedHighways: options.allowedHighways,
        maxSnapMeters: options.maxSnapMeters
    });

    const units = describeUnits(model);
    const cut = partitionUnits(units, budgets);
    // Balance runs AFTER the territory is already cut into valid partitions, so
    // it can only even out sizes — it can never be the reason a partition
    // becomes invalid or a pocket gets split. Route COUNT is decided by the cut
    // above, never by balancing, and is never steered toward a target number.
    const balance = options.balance === false
        ? { groups: cut, moves: [], spreadBefore: null, spreadAfter: null, limitedBy: 'disabled' }
        : balancePartitions(cut, budgets);

    const partitions = balance.groups.map((group, index) => describePartition(group, index, budgets));

    const validation = validatePartitionCoverage(model, partitions);
    const diagnostics = buildPartitionDiagnostics({ model, partitions, budgets, validation, balance });
    if (!validation.ok) {
        // Fail loudly with the full picture attached: a coverage failure on a
        // 16,000-home territory is unfixable from a bare count.
        const error = new Error(`territoryPartitioner: exactly-once validation failed\n${formatPartitionDiagnostics(diagnostics)}`);
        error.diagnostics = diagnostics;
        throw error;
    }

    const doorCounts = partitions.map((partition) => partition.doorCount);
    const blockCounts = partitions.map((partition) => partition.blockCount);
    return {
        partitions,
        units,
        model,
        budgets,
        validation,
        diagnostics,
        balance,
        overrides: partitions.flatMap((partition) => partition.overrides),
        stats: {
            partitionCount: partitions.length,
            doorCount: model.doorCount,
            blockCount: model.blockCount,
            unitCount: model.unitCount,
            pocketCount: model.pockets.length,
            minHomesPerPartition: doorCounts.length ? Math.min(...doorCounts) : 0,
            maxHomesPerPartition: doorCounts.length ? Math.max(...doorCounts) : 0,
            averageHomesPerPartition: diagnostics.homesPerPartition.average,
            homesSpread: diagnostics.homesPerPartition.spread,
            minBlocksPerPartition: blockCounts.length ? Math.min(...blockCounts) : 0,
            maxBlocksPerPartition: blockCounts.length ? Math.max(...blockCounts) : 0,
            partitionsWithinBudget: partitions.filter((partition) => partition.withinBudget).length,
            roadReadyPartitions: partitions.filter((partition) => partition.roadReady).length,
            balanceMoves: balance.moves.length,
            balanceLimitedBy: balance.limitedBy
        }
    };
}