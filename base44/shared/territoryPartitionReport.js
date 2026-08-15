// Whole-territory validation and diagnostics for the partitioner.
//
// Stage 2, step 3. Kept in its own module for two reasons: the partitioner
// should read as "how a territory is cut" rather than "how a territory is
// audited", and a 16,000-home partition set is only debuggable if the audit
// output is deliberately designed rather than assembled inline.
//
// Nothing here mutates a partition. Validation observes and reports; the
// partitioner decides what to do about a failure.

const compareText = (left, right) => {
    const first = String(left);
    const second = String(right);
    if (first < second) return -1;
    if (first > second) return 1;
    return 0;
};

const sum = (values) => values.reduce((total, value) => total + value, 0);

/**
 * Stable identity for a door. `address_hash` is the identity the rest of the
 * system uses; the coordinate fallback exists so an un-hashed door still cannot
 * be silently double counted.
 */
export function doorIdentity(door) {
    if (door?.address_hash) return `hash:${door.address_hash}`;
    return `geo:${Number(door?.lat).toFixed(6)},${Number(door?.lng).toFixed(6)}|${door?.street_name || ''}|${door?.house_number ?? ''}`;
}

function countIdentities(doors) {
    const counts = new Map();
    doors.forEach((door) => {
        const identity = doorIdentity(door);
        counts.set(identity, (counts.get(identity) || 0) + 1);
    });
    return counts;
}

/**
 * Exactly-once across the WHOLE partition set — not per partition.
 *
 * Compares the multiset of door identities in the partitions against the
 * model's own door inventory, so a door that is dropped, duplicated, or moved
 * between partitions is caught even when every partition looks internally
 * consistent. Routing units are checked the same way: a unit appearing in two
 * partitions is an overlap, and a missing unit is a gap.
 */
export function validatePartitionCoverage(model, partitions) {
    const expectedDoors = countIdentities(model.blocks.flatMap((block) => block.doors));
    const actualDoors = countIdentities(partitions.flatMap((partition) => partition.doors));

    const missingDoors = [];
    const duplicatedDoors = [];
    expectedDoors.forEach((count, identity) => {
        const seen = actualDoors.get(identity) || 0;
        if (seen < count) missingDoors.push({ identity, expected: count, actual: seen });
        if (seen > count) duplicatedDoors.push({ identity, expected: count, actual: seen });
    });
    actualDoors.forEach((count, identity) => {
        if (!expectedDoors.has(identity)) duplicatedDoors.push({ identity, expected: 0, actual: count });
    });

    const expectedUnits = new Set(model.units.map((unit) => unit.key));
    const unitOwners = new Map();
    partitions.forEach((partition) => partition.unitKeys.forEach((key) => {
        unitOwners.set(key, [...(unitOwners.get(key) || []), partition.index]);
    }));
    const missingUnits = [...expectedUnits].filter((key) => !unitOwners.has(key)).sort(compareText);
    const overlappingUnits = [...unitOwners.entries()]
        .filter(([key, owners]) => owners.length > 1 || !expectedUnits.has(key))
        .map(([key, owners]) => ({ unitKey: key, partitions: owners }))
        .sort((first, second) => compareText(first.unitKey, second.unitKey));

    const assignedDoorCount = sum([...actualDoors.values()]);
    const ok = missingDoors.length === 0
        && duplicatedDoors.length === 0
        && missingUnits.length === 0
        && overlappingUnits.length === 0
        && assignedDoorCount === model.doorCount;

    return {
        ok,
        exactlyOnce: ok,
        expectedDoorCount: model.doorCount,
        assignedDoorCount,
        expectedUnitCount: expectedUnits.size,
        assignedUnitCount: unitOwners.size,
        // Capped: a systemic failure would otherwise produce a report too large
        // to read. The counts above stay exact.
        missingDoorCount: missingDoors.length,
        duplicatedDoorCount: duplicatedDoors.length,
        missing: missingDoors.sort((first, second) => compareText(first.identity, second.identity)).slice(0, 20),
        duplicated: duplicatedDoors.sort((first, second) => compareText(first.identity, second.identity)).slice(0, 20),
        missingUnits: missingUnits.slice(0, 20),
        overlappingUnits: overlappingUnits.slice(0, 20)
    };
}

/**
 * The debugging surface for a large territory: everything needed to answer
 * "why does this territory look like this" without re-running the partitioner.
 */
export function buildPartitionDiagnostics({ model, partitions, budgets, validation, balance }) {
    const homes = partitions.map((partition) => partition.doorCount);
    const blocks = partitions.map((partition) => partition.blockCount);
    const units = partitions.map((partition) => partition.unitCount);
    const overrides = partitions.flatMap((partition) => partition.overrides);
    const extreme = (values, pick) => (values.length ? pick(...values) : 0);

    return {
        territory: {
            totalHomes: model.doorCount,
            totalBlocks: model.blockCount,
            totalRoutingUnits: model.unitCount,
            protectedPockets: model.pockets.length
        },
        budgets: { maxHomesPerRoute: budgets.maxHomes, maxBlocksPerRoute: budgets.maxBlocks },
        partitionCount: partitions.length,
        homesPerPartition: {
            min: extreme(homes, Math.min),
            max: extreme(homes, Math.max),
            // Rounded to one decimal: an average of 999.9375 reads as noise.
            average: homes.length ? Math.round((sum(homes) / homes.length) * 10) / 10 : 0,
            spread: extreme(homes, Math.max) - extreme(homes, Math.min)
        },
        blocksPerPartition: { min: extreme(blocks, Math.min), max: extreme(blocks, Math.max) },
        routingUnitsPerPartition: { min: extreme(units, Math.min), max: extreme(units, Math.max) },
        pocketOverrides: overrides,
        pocketOverrideCount: overrides.length,
        exactlyOnce: {
            ok: validation.ok,
            expectedHomes: validation.expectedDoorCount,
            assignedHomes: validation.assignedDoorCount,
            missingHomes: validation.missingDoorCount,
            duplicatedHomes: validation.duplicatedDoorCount,
            missingUnits: validation.missingUnits.length,
            overlappingUnits: validation.overlappingUnits.length
        },
        balance: balance || null,
        withinBudget: partitions.every((partition) => partition.withinBudget),
        roadReady: partitions.every((partition) => partition.roadReady),
        partitions: partitions.map((partition) => ({
            index: partition.index,
            signature: partition.signature,
            homes: partition.doorCount,
            blocks: partition.blockCount,
            routingUnits: partition.unitCount,
            protectedUnits: partition.protectedUnitCount,
            matrixTier: partition.matrixTier,
            roadReady: partition.roadReady,
            withinBudget: partition.withinBudget,
            overrideCodes: partition.overrides.map((override) => override.code)
        })),
        signatures: partitions.map((partition) => partition.signature)
    };
}

/** One-screen text form of the diagnostics, for logs and failure messages. */
export function formatPartitionDiagnostics(diagnostics) {
    const lines = [
        `territory: ${diagnostics.territory.totalHomes} homes, ${diagnostics.territory.totalBlocks} blocks, ${diagnostics.territory.totalRoutingUnits} routing units, ${diagnostics.territory.protectedPockets} pockets`,
        `partitions: ${diagnostics.partitionCount} (homes min ${diagnostics.homesPerPartition.min} / avg ${diagnostics.homesPerPartition.average} / max ${diagnostics.homesPerPartition.max}, spread ${diagnostics.homesPerPartition.spread})`,
        `blocks per partition: ${diagnostics.blocksPerPartition.min}-${diagnostics.blocksPerPartition.max} (budget ${diagnostics.budgets.maxBlocksPerRoute})`,
        `routing units per partition: ${diagnostics.routingUnitsPerPartition.min}-${diagnostics.routingUnitsPerPartition.max}`,
        `exactly-once: ${diagnostics.exactlyOnce.ok ? 'ok' : 'FAILED'} (${diagnostics.exactlyOnce.assignedHomes}/${diagnostics.exactlyOnce.expectedHomes} homes, ${diagnostics.exactlyOnce.missingHomes} missing, ${diagnostics.exactlyOnce.duplicatedHomes} duplicated, ${diagnostics.exactlyOnce.missingUnits} unit gaps, ${diagnostics.exactlyOnce.overlappingUnits} unit overlaps)`,
        `pocket overrides: ${diagnostics.pocketOverrideCount}`,
        `within budget: ${diagnostics.withinBudget} | road ready: ${diagnostics.roadReady}`
    ];
    if (diagnostics.balance) {
        lines.push(`balance: spread ${diagnostics.balance.spreadBefore} -> ${diagnostics.balance.spreadAfter} after ${diagnostics.balance.moves.length} unit moves, stopped because ${diagnostics.balance.limitedBy}`);
    }
    return lines.join('\n');
}