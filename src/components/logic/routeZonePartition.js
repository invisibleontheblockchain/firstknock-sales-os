/**
 * Geographic zone partitioning for route generation.
 *
 * Route generation used to order EVERY qualifying door into one long street
 * sequence and then cut it into routes by count, so two reps could be handed
 * order-neighbors instead of neighborhoods. This partitions the doors into
 * contiguous zones first — one zone per rep route — using lat/lng proximity
 * only. No road network is consulted here: zoning answers "which doors belong
 * together", and the road matrix runs afterwards, once per zone.
 *
 * Determinism is a hard requirement (the route harnesses compare repeated runs),
 * so seeding is farthest-point greedy over a stable key order rather than the
 * random k-means++ draw.
 */

const CAPACITY_BALANCE_PASSES = 12;

function stableKey(property, index) {
    return String(
        property?.address_hash
        || property?.legacy_hash
        || property?.id
        || `${property?.house_number ?? ''}|${property?.street_name ?? ''}|${property?.lat ?? ''}|${property?.lng ?? ''}|${index}`
    );
}

/** Squared planar distance — comparisons only, so no trig beyond the lat scale. */
function distanceSquared(first, second) {
    const x = (second.lng - first.lng) * Math.cos((first.lat + second.lat) / 2 * Math.PI / 180);
    const y = second.lat - first.lat;
    return x * x + y * y;
}

function centroidOf(members) {
    return {
        lat: members.reduce((sum, member) => sum + member.lat, 0) / members.length,
        lng: members.reduce((sum, member) => sum + member.lng, 0) / members.length
    };
}

/** Farthest-point greedy seeds: spread out, and identical on every run. */
function seedCentroids(items, zoneCount) {
    const centroids = [{ lat: items[0].lat, lng: items[0].lng }];
    while (centroids.length < zoneCount) {
        let bestIndex = 0;
        let bestDistance = -Infinity;
        items.forEach((item, index) => {
            let nearest = Infinity;
            centroids.forEach((centroid) => {
                const distance = distanceSquared(item, centroid);
                if (distance < nearest) nearest = distance;
            });
            if (nearest > bestDistance) {
                bestDistance = nearest;
                bestIndex = index;
            }
        });
        if (bestDistance <= 0) break; // Every remaining door duplicates a seed.
        centroids.push({ lat: items[bestIndex].lat, lng: items[bestIndex].lng });
    }
    return centroids;
}

function assignToNearest(items, centroids) {
    return items.map((item) => {
        let best = 0;
        let bestDistance = Infinity;
        centroids.forEach((centroid, index) => {
            const distance = distanceSquared(item, centroid);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = index;
            }
        });
        return best;
    });
}

/**
 * k-means alone produces lopsided zones, and each zone becomes one rep's day.
 * Push the members farthest from their own centroid into the nearest zone that
 * still has room until every zone fits the requested route size.
 */
function balanceZoneCapacity(items, assignments, centroids, capacity) {
    for (let pass = 0; pass < CAPACITY_BALANCE_PASSES; pass++) {
        const counts = centroids.map(() => 0);
        assignments.forEach((zone) => { counts[zone] += 1; });
        const overflowing = counts.some(count => count > capacity);
        if (!overflowing) return assignments;

        let moved = false;
        centroids.forEach((centroid, zone) => {
            if (counts[zone] <= capacity) return;
            const members = items
                .map((item, index) => ({ index, item }))
                .filter(entry => assignments[entry.index] === zone)
                .sort((first, second) => (
                    distanceSquared(second.item, centroid) - distanceSquared(first.item, centroid)
                ));

            for (const entry of members) {
                if (counts[zone] <= capacity) break;
                let target = -1;
                let targetDistance = Infinity;
                centroids.forEach((candidate, candidateZone) => {
                    if (candidateZone === zone || counts[candidateZone] >= capacity) return;
                    const distance = distanceSquared(entry.item, candidate);
                    if (distance < targetDistance) {
                        targetDistance = distance;
                        target = candidateZone;
                    }
                });
                if (target === -1) return; // Nowhere with room; leave this zone larger.
                assignments[entry.index] = target;
                counts[zone] -= 1;
                counts[target] += 1;
                moved = true;
            }
        });
        if (!moved) return assignments;
    }
    return assignments;
}

/**
 * Partition properties into contiguous zones of at most `housesPerRoute` doors.
 * Returns the same property objects with a `cluster` index. Membership is never
 * added to or dropped — only the zone label is attached.
 */
export function partitionPropertiesIntoZones(properties, housesPerRoute) {
    const items = Array.isArray(properties) ? properties : [];
    const capacity = Math.floor(Number(housesPerRoute));
    if (
        items.length === 0
        || !Number.isFinite(capacity)
        || capacity <= 0
        || items.length <= capacity
    ) {
        return items.map(property => ({ ...property, cluster: 0 }));
    }

    const ordered = items
        .map((property, index) => ({ property, key: stableKey(property, index) }))
        .sort((first, second) => (first.key < second.key ? -1 : first.key > second.key ? 1 : 0))
        .map(entry => entry.property);

    const zoneCount = Math.ceil(ordered.length / capacity);
    let centroids = seedCentroids(ordered, zoneCount);
    let assignments = assignToNearest(ordered, centroids);

    // Lloyd's algorithm. Fixed iteration count keeps generation time predictable.
    for (let iteration = 0; iteration < 15; iteration++) {
        centroids = centroids.map((centroid, zone) => {
            const members = ordered.filter((_, index) => assignments[index] === zone);
            return members.length > 0 ? centroidOf(members) : centroid;
        });
        const next = assignToNearest(ordered, centroids);
        const settled = next.every((zone, index) => zone === assignments[index]);
        assignments = next;
        if (settled) break;
    }

    assignments = balanceZoneCapacity(ordered, assignments, centroids, capacity);

    return ordered.map((property, index) => ({ ...property, cluster: assignments[index] }));
}