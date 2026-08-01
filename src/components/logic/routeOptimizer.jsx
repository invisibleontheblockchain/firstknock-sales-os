/**
 * Advanced Route Optimization Engine
 *
 * Implements a mail-carrier (boustrophedon) walking pattern:
 * 1. Group properties by normalized street name.
 * 2. Order streets via nearest-neighbor TSP on street centroids + 2-Opt.
 * 3. Within each street, walk one side low→high then the other side high→low
 *    (or reversed, depending on which end of the street you arrive from).
 *    Streets with only a door or two on a side are walked straight through in
 *    geographic order so reps never pass a door and double back for it.
 * 4. Apply intra-street 2-Opt to tighten each side independently.
 *
 * This eliminates the cross-street backtracking visible as yellow lines
 * crossing back over themselves on the map.
 */

import { filterByStreetCooldown, COOLDOWN_CONFIG } from './territoryLogic';
import { latLngToCell, gridDisk } from 'h3-js';
import { batchScoreProperties } from './leadScoring';
import { isKnockActivityLog } from '@/lib/interactionLogs';
import {
    calculateRouteDistanceMiles,
    isValidRoutePoint,
    optimizeRouteWithBounds
} from '@/lib/routeBounds';
import { normalizeRouteOriginMode } from '@/lib/routeOriginModes';
import {
    BLOCK_SEQUENCING_LIMITS,
    countStreetReentries,
    selectBestBlockOrderCandidate,
    selectDiverseSeedBlockIndexes,
    summarizeRouteTail
} from './routeBlockSequencing';

function cleanAreaLabel(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim().replace(/\s+/g, ' ').replace(/\bcounty\b$/i, '').trim();
}

function mostCommonLabel(properties, getters) {
    const counts = new Map();
    properties.forEach((property) => {
        for (const getter of getters) {
            const value = cleanAreaLabel(getter(property));
            if (value) {
                counts.set(value, (counts.get(value) || 0) + 1);
                break;
            }
        }
    });
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

function buildRouteName(properties, routeMode, routeNumber) {
    const county = mostCommonLabel(properties, [
        p => p.county,
        p => p.county_name,
        p => p.countyName,
        p => p.raw_metadata?.county,
        p => p.raw_metadata?.county_name,
        p => p.raw_metadata?.COUNTY,
        p => p.raw_metadata?.County
    ]);
    const city = mostCommonLabel(properties, [p => p.city, p => p.raw_metadata?.city, p => p.raw_metadata?.CITY, p => p.raw_metadata?.City]);
    const zip = mostCommonLabel(properties, [p => p.zip_code, p => p.zip, p => p.raw_metadata?.zip, p => p.raw_metadata?.ZIP]);
    const street = mostCommonLabel(properties, [p => p.street_name]);
    const area = county ? `${county} County` : city || (zip ? `ZIP ${zip}` : street || 'Territory');
    const type = routeMode === 'canvas' ? 'Canvas' : 'Precision';
    return `${area} ${type} Route ${routeNumber}`;
}

function routeMembershipKey(property) {
    const durableIdentity = property?.address_hash || property?.legacy_hash || property?.id;
    if (durableIdentity !== null && durableIdentity !== undefined && String(durableIdentity).trim()) {
        return `id:${String(durableIdentity).trim()}`;
    }
    // SavedRoute membership is a durable hash manifest. A coordinate-derived
    // identity could pass optimization and then disappear when the route is
    // persisted, so fail closed instead of inventing an unsaveable key.
    return '';
}

function assertExactRouteMembership(expectedProperties, routes) {
    const expectedKeys = expectedProperties.map(routeMembershipKey);
    const routedKeys = routes
        .flatMap(route => route?.properties || [])
        .map(routeMembershipKey);
    const expectedSet = new Set(expectedKeys);
    const routedSet = new Set(routedKeys);
    if (
        expectedKeys.some(key => !key)
        || routedKeys.some(key => !key)
        || routedKeys.length !== expectedKeys.length
        || expectedSet.size !== expectedKeys.length
        || routedSet.size !== routedKeys.length
        || expectedSet.size !== routedSet.size
        || routedKeys.some(key => !expectedSet.has(key))
    ) {
        throw new Error(
            `Route integrity verification failed: expected ${expectedKeys.length} unique homes and received ${routedKeys.length}.`
        );
    }
}

export function isStrictRoutePropertyPoint(property) {
    if (
        !property
        || property.lat === null
        || property.lat === undefined
        || property.lat === ''
        || property.lng === null
        || property.lng === undefined
        || property.lng === ''
    ) return false;
    const lat = Number(property.lat);
    const lng = Number(property.lng);
    return Number.isFinite(lat)
        && Number.isFinite(lng)
        && lat >= -90
        && lat <= 90
        && lng >= -180
        && lng <= 180
        && !(Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001);
}

// Haversine distance in miles
function calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 3959; // Earth radius in miles
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// Fast squared distance for clustering comparisons (avoids expensive Math operations)
function calculateDistanceSquaredFast(lat1, lng1, lat2, lng2) {
    const x = (lng2 - lng1) * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
    const y = lat2 - lat1;
    return x * x + y * y;
}

// Fast approximate distance for routing comparisons
function calculateDistanceFast(lat1, lng1, lat2, lng2) {
    const x = (lng2 - lng1) * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
    const y = lat2 - lat1;
    return Math.sqrt(x * x + y * y) * 69; // rough miles
}

/**
 * Advanced Property Scoring Engine 3.0
 * Factors: Equity, Recent Sales (Activity), Property Type, Contact Frequency
 */
export function scoreProperty(property, logs = [], neighborhoodStats = {}, learnedWeights = null) {
    let score = 100; // Base score

    // 1. Status Scoring Logic
    if (property.effective_status === 'ELIGIBLE') score += 60; // Slightly higher priority for fresh doors
    if (property.effective_status === 'UNVERIFIED') score += 40; // Legacy CSV data, treat as routable but lower confidence
    if (property.effective_status === 'CALLBACK') score += 100; // Top priority
    if (property.effective_status === 'NO_ANSWER') score += 30; // Worth another try
    if (property.effective_status === 'NOT_MOVED_IN') score += 20; // Come back later
    if (property.effective_status === 'DM_NOT_HOME') score += 50; // Decision maker absent — high re-visit value
    if (property.effective_status === 'QUALIFIED') score += 80;
    if (property.effective_status === 'HARD_NO') return 0;
    // 'SOLD' = recently sold home from MLS (new homeowner = prime lead), score based on recency
    if (property.effective_status === 'SOLD') {
        if (property.sold_date) {
            const monthsAgo = (Date.now() - new Date(property.sold_date).getTime()) / (1000 * 60 * 60 * 24 * 30);
            if (monthsAgo <= 3) score += 80;       // Just moved in — hottest leads
            else if (monthsAgo <= 6) score += 60;  // Settled in, ready to buy
            else if (monthsAgo <= 12) score += 40;  // Still new-ish homeowner
            else score += 20;
        } else {
            score += 20;
        }
    }

    // 2. Estimated Equity & Tenure
    if (property.sold_date && property.price) {
        const soldDate = new Date(property.sold_date);
        const now = new Date();
        const yearsOwned = Number(now.getTime() - soldDate.getTime()) / (1000 * 60 * 60 * 24 * 365);

        // Simple Equity Proxy: 3% appreciation per year + down payment
        // (Just a heuristic score, not financial advice)
        const appreciationFactor = 1 + (0.03 * yearsOwned);
        const estValue = property.price * appreciationFactor;
        const loanAmortization = Math.min(1, yearsOwned / 30); // Rough loan payoff
        const estEquity = estValue * (0.2 + (0.8 * loanAmortization)); // Assuming 20% down

        if (estEquity > 200000) score += 60; // High equity = High potential
        else if (estEquity > 100000) score += 30;

        if (yearsOwned < 1) score -= 30; // Brand new, likely no money or overwhelmed
        else if (yearsOwned > 7) score += 40; // 7+ years is prime move/upgrade/solar time
    }

    // 3. Property Type
    if (property.property_type) {
        const type = property.property_type.toLowerCase();
        if (type.includes('single')) score += 20;
        else if (type.includes('condo') || type.includes('town')) score -= 10; // HOA barriers
        else if (type.includes('multi')) score += 10;
    }

    // 4. Neighborhood Heat (Recent Sales Activity)
    // If neighborhoodStats has data for this H3 cell
    if (neighborhoodStats && property.lat && property.lng) {
        try {
            const h3Index = latLngToCell(property.lat, property.lng, 9);
            const zipHeat = neighborhoodStats[h3Index] || 0;
            // Boost if area is hot (lots of recent sales = active market)
            score += Math.min(zipHeat * 5, 50);
        } catch (e) {}
    }

    // 5. Contact Frequency (Avoid Burnout, optimize 'when to knock')
    // Support legacy_hash alias for interaction log lookups
    if (logs && logs.length > 0) {
        const propHash = property.address_hash || property.id;
        const legacyHash = property.legacy_hash;
        const myLogs = logs.filter(l => isKnockActivityLog(l) && (l.address_hash === propHash || (legacyHash && l.address_hash === legacyHash)));

        // Optimize for feedback from finished routes
        if (myLogs.length > 3) {
            score -= 60; // Too many touches, severely diminish priority
        } else if (myLogs.length === 1 && myLogs[0].parsed_status === 'NO_ANSWER') {
            score += 25; // Definitely try a second time
        } else if (myLogs.length === 2 && myLogs.every(l => l.parsed_status === 'NO_ANSWER')) {
            score -= 10; // 3rd try on NO_ANSWER is less ideal
        }
    }

    // 6. High Value
    if (property.price > 1000000) score += 30;

    // 7. Machine Learning Lead Scoring Enhancement
    if (learnedWeights) {
        // Age weight
        if (property.year_built) {
            const age = new Date().getFullYear() - property.year_built;
            if (age > 10 && learnedWeights.age_gt_10_weight) {
                score *= learnedWeights.age_gt_10_weight;
            }
        }

        // Price weight
        if (property.price > 300000 && learnedWeights.price_gt_300k_weight) {
            score *= learnedWeights.price_gt_300k_weight;
        }

        // Property type weight
        if (property.property_type && property.property_type.toLowerCase().includes('single') && learnedWeights.single_family_weight) {
            score *= learnedWeights.single_family_weight;
        }

        // Recent sale weight
        if (property.sold_date) {
            const yearsOwned = (new Date() - new Date(property.sold_date)) / (1000 * 60 * 60 * 24 * 365);
            if (yearsOwned <= 3 && learnedWeights.recent_sale_weight) {
                score *= learnedWeights.recent_sale_weight;
            }
        }

        // Phase 3: High value weight (>$750k)
        if (property.price > 750000 && learnedWeights.high_value_weight) {
            score *= learnedWeights.high_value_weight;
        }

        // Phase 3: Large lot weight (>0.25 acre)
        if (property.lot_size > 10890 && learnedWeights.large_lot_weight) {
            score *= learnedWeights.large_lot_weight;
        }
    }

    return Math.max(0, Math.round(score));
}

/**
 * K-Means++ Initialization (§4.1)
 * D²-weighted probabilistic seeding — ensures well-spread initial centroids.
 * Reduces iterations 2-5× and improves WCSS 8-15% vs random init.
 */
function kMeansPlusPlusInit(items, numClusters) {
    const centroids = [];
    // First centroid: uniform random
    const first = items[Math.floor(Math.random() * items.length)];
    centroids.push({ lat: first.lat, lng: first.lng });

    for (let c = 1; c < numClusters; c++) {
        // Compute D² for each point to nearest centroid
        const distances = items.map(p => {
            let minD = Infinity;
            centroids.forEach(cen => {
                const d = calculateDistanceSquaredFast(p.lat, p.lng, cen.lat, cen.lng);
                if (d < minD) minD = d;
            });
            return minD;
        });
        const totalD = distances.reduce((s, d) => s + d, 0);
        if (totalD === 0) {
            // Degenerate: all points at same location — pick random
            const pick = items[Math.floor(Math.random() * items.length)];
            centroids.push({ lat: pick.lat, lng: pick.lng });
            continue;
        }
        // Weighted random selection
        let r = Math.random() * totalD;
        for (let i = 0; i < distances.length; i++) {
            r -= distances[i];
            if (r <= 0) {
                centroids.push({ lat: items[i].lat, lng: items[i].lng });
                break;
            }
        }
        // Edge case: floating point didn't pick — take last
        if (centroids.length <= c) {
            centroids.push({ lat: items[items.length - 1].lat, lng: items[items.length - 1].lng });
        }
    }
    return centroids;
}

/**
 * K-Means++ clustering for geographic grouping (§4.1, §4.2)
 * Uses K-Means++ init and propensity-weighted centroids.
 */
function kMeansClustering(properties, numClusters) {
    if (properties.length <= numClusters) {
        return properties.map((p, i) => ({ ...p, cluster: i }));
    }

    let items = properties.map(p => ({ ...p }));

    // K-Means++ initialization (replaces random)
    let centroids = kMeansPlusPlusInit(items, numClusters);

    let iterations = 0;
    const maxIterations = 20;
    let changed = true;

    while (changed && iterations < maxIterations) {
        changed = false;
        iterations++;

        // Assign each property to nearest centroid
        items.forEach(prop => {
            let minDist = Infinity;
            let bestCluster = 0;

            centroids.forEach((centroid, idx) => {
                const dist = calculateDistanceSquaredFast(prop.lat, prop.lng, centroid.lat, centroid.lng);
                if (dist < minDist) {
                    minDist = dist;
                    bestCluster = idx;
                }
            });

            if (prop.cluster !== bestCluster) {
                changed = true;
                prop.cluster = bestCluster;
            }
        });

        // Propensity-weighted centroids (§4.2 Approach B)
        centroids = centroids.map((_, idx) => {
            const clusterProps = items.filter(p => p.cluster === idx);
            if (clusterProps.length === 0) return centroids[idx];

            let totalWeight = 0;
            let wLat = 0;
            let wLng = 0;
            clusterProps.forEach(p => {
                const w = Math.max(0.1, p.propensity || p.score / 400 || 0.5);
                wLat += w * p.lat;
                wLng += w * p.lng;
                totalWeight += w;
            });
            return { lat: wLat / totalWeight, lng: wLng / totalWeight };
        });
    }

    return items;
}

/** Bearing in degrees (0–360) from point 1 to point 2. Inputs in degrees. */
function calculateBearing(lat1, lng1, lat2, lng2) {
    const lat1r = lat1 * Math.PI / 180;
    const lat2r = lat2 * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const y = Math.sin(dLng) * Math.cos(lat2r);
    const x = Math.cos(lat1r) * Math.sin(lat2r) - Math.sin(lat1r) * Math.cos(lat2r) * Math.cos(dLng);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/**
 * 2-opt Optimization to uncross paths and reduce total distance
 */
function apply2Opt(route) {
    if (route.length < 4) return route;
    if (route.length > 300) {
        console.warn(`[routeOptimizer] Route too large for 2-Opt (${route.length} nodes). Slipping to Nearest Neighbor for performance.`);
        return route;
    }

    let improved = true;
    const maxIterations = 50; // Cap iterations for performance
    let iterations = 0;

    // The Dummy Node Strategy for open routes
    // Instead of a physical coordinate, we use a logical dummy node with 0.0 distance
    const dummy = { isDummy: true };
    const currentRoute = [...route, dummy];

    const dist = (pA, pB) => {
        if (pA.isDummy || pB.isDummy) return 0.0;
        return calculateDistanceFast(pA.lat, pA.lng, pB.lat, pB.lng);
    };

    while (improved && iterations < maxIterations) {
        improved = false;
        iterations++;

        // Start at i = 1 to protect the starting node (Stop #1)
        for (let i = 1; i < currentRoute.length - 2; i++) {
            for (let j = i + 2; j < currentRoute.length - 1; j++) { // j starts at i+2 to ensure we don't swap adjacent edges
                const p1 = currentRoute[i];
                const p2 = currentRoute[i + 1];
                const p3 = currentRoute[j];
                const p4 = currentRoute[j + 1];

                // Current distance: p1->p2 + p3->p4
                const currentDist = dist(p1, p2) + dist(p3, p4);

                // New distance if swapped: p1->p3 + p2->p4 (reversing the segment p2...p3)
                const newDist = dist(p1, p3) + dist(p2, p4);

                if (newDist < currentDist) {
                    // Reverse the segment from i+1 to j
                    const segment = currentRoute.slice(i + 1, j + 1).reverse();
                    currentRoute.splice(i + 1, segment.length, ...segment);
                    improved = true;
                }
            }
        }
    }

    // Remove the dummy to reveal the open-ended line
    const sIdx = currentRoute.findIndex(p => p.isDummy);
    currentRoute.splice(sIdx, 1);

    route.length = 0;
    route.push(...currentRoute);
    return route;
}

/**
 * Link Swap Operator / Or-Opt (§2.2, §2.3)
 * Relocates single nodes and 2-node chains to better positions.
 * Contributes ~50% of all improvements in open-path TSP for 40-60 nodes.
 * Runs AFTER 2-Opt for additional refinement.
 */
function applyLinkSwap(route) {
    if (route.length < 4) return route;
    if (route.length > 300) {
        return route; // Safety limit
    }
    let improved = true;
    let iterations = 0;
    const maxIterations = 30;

    const dist = (a, b) => {
        if (!a || !b || a.isDummy || b.isDummy) return 0;
        return calculateDistanceFast(a.lat, a.lng, b.lat, b.lng);
    };

    while (improved && iterations < maxIterations) {
        improved = false;
        iterations++;

        // Try relocating each node to a better position
        for (let segLen = 1; segLen <= 2; segLen++) {
            for (let i = 1; i < route.length - segLen; i++) {
                // Cost of removing segment [i..i+segLen-1]
                const prev = route[i - 1];
                const segEnd = route[i + segLen - 1];
                const next = route[i + segLen] || null;

                const removeCost = dist(prev, route[i]) +
                    (next ? dist(segEnd, next) : 0);
                const removeGain = next ? dist(prev, next) : 0;
                const removalSaving = removeCost - removeGain;

                // Try inserting this segment at every other position
                for (let j = 0; j < route.length - 1; j++) {
                    if (j >= i - 1 && j <= i + segLen - 1) continue;

                    const insertCost = dist(route[j], route[i]) + dist(segEnd, route[j + 1]) - dist(route[j], route[j + 1]);

                    if (removalSaving - insertCost > 0.001) {
                        // Perform the move
                        const segment = route.splice(i, segLen);
                        const insertIdx = j < i ? j + 1 : j + 1 - segLen;
                        route.splice(insertIdx, 0, ...segment);
                        improved = true;
                        break;
                    }
                }
                if (improved) break;
            }
            if (improved) break;
        }
    }
    return route;
}

/**
 * Nearest Neighbor TSP approximation for route ordering
 * Enhanced with weighted heuristics
 */
function optimizeRouteOrder(properties, startLat = null, startLng = null, minimizeTurns = false) {
    if (properties.length === 0) return [];

    const unvisited = [...properties];
    const route = [];

    // Start from provided location or first property
    let current = startLat && startLng
        ? { lat: startLat, lng: startLng }
        : unvisited.shift();

    let currentBearing = null; // Track current direction of travel

    if (startLat && startLng) {
        // Find nearest to start
        let nearestIdx = 0;
        let minScore = Infinity;

        unvisited.forEach((prop, idx) => {
            const dist = calculateDistanceFast(current.lat, current.lng, prop.lat, prop.lng);
            if (dist < minScore) {
                minScore = dist;
                nearestIdx = idx;
            }
        });
        current = unvisited.splice(nearestIdx, 1)[0];
    }

    route.push(current);

    // Nearest neighbor loop with heuristics
    while (unvisited.length > 0) {
        let bestIdx = 0;
        let bestScore = Infinity;

        unvisited.forEach((prop, idx) => {
            const dist = calculateDistanceFast(current.lat, current.lng, prop.lat, prop.lng);
            let score = dist;

            // Heuristic: Minimize Turns
            if (minimizeTurns && currentBearing !== null) {
                const newBearing = calculateBearing(current.lat, current.lng, prop.lat, prop.lng);
                const turnAngle = Math.abs(newBearing - currentBearing);
                const normalizedTurn = turnAngle > 180 ? 360 - turnAngle : turnAngle;

                // Penalize sharp turns (e.g., 90-180 degrees)
                // Add "virtual miles" to the distance for sharp turns
                if (normalizedTurn > 45) {
                    score += (normalizedTurn / 180) * 0.5; // Up to 0.5 miles penalty for u-turn
                }
            }

            if (score < bestScore) {
                bestScore = score;
                bestIdx = idx;
            }
        });

        const nextProp = unvisited.splice(bestIdx, 1)[0];

        // Update bearing
        currentBearing = calculateBearing(current.lat, current.lng, nextProp.lat, nextProp.lng);

        current = nextProp;
        route.push(current);
    }

    return route;
}

/**
 * Generate optimized routes with clustering
 * @param {Array} properties - All properties to route
 * @param {Number} housesPerRoute - Target houses per route (default 50)
 * @param {Object} startLocation - Optional {lat, lng} starting point
 * @param {Array} allLogs - Optional logs for street cooldown filtering
 * @param {Object} options - Additional options { streetCooldownDays, useStreetSweep }
 * @returns {Array} Array of route objects with metadata
 */
export function generateOptimizedRoutes(
    properties,
    housesPerRoute = 50,
    startLocation = null,
    allLogs = [],
    options = {},
    learnedWeights = null,
    routingContext = null
) {
    const {
        streetCooldownDays = COOLDOWN_CONFIG.STREET_COOLDOWN_DAYS,
        useStreetSweep = true,
        minimizeTurns = false,
        returnToStart = false,
        endLocation = null,
        routeOriginMode = 'none',
        maxRouteDistance = null,
        excludeTerminal = true,
        preserveInputMembership = false,
        preserveGlobalChunkOrder = false,
        routingContext: optionRoutingContext = null
    } = options;
    const effectiveRoutingContext = routingContext || optionRoutingContext || null;
    const normalizedRouteOriginMode = normalizeRouteOriginMode(routeOriginMode);
    const effectiveEndLocation = normalizedRouteOriginMode !== 'none' && isValidRoutePoint(endLocation)
        ? endLocation
        : null;
    const hasFixedRouteBounds = normalizedRouteOriginMode !== 'none'
        && isValidRoutePoint(startLocation)
        && isValidRoutePoint(effectiveEndLocation);

    // Filter out properties on streets that are on cooldown
    // Also filter out invalid coordinates (Null Island 0,0)
    const inputProperties = Array.isArray(properties) ? properties : [];
    let eligible = inputProperties.filter(isStrictRoutePropertyPoint);
    if (preserveInputMembership && eligible.length !== inputProperties.length) {
        throw new Error(
            `Route integrity verification failed: ${inputProperties.length - eligible.length} homes have invalid coordinates.`
        );
    }

    // Deduplicate by normalized address (safety net for Phase1/Phase2 hash mismatch)
    if (!preserveInputMembership) {
        const addrMap = new Map();
        eligible.forEach(p => {
            const street = (p.street_name || '').toUpperCase().trim();
            const num = p.house_number || 0;
            const zip = String(p.zip_code || '').trim().slice(0, 5);
            const key = `${num}|${street}|${zip}`;
            const existing = addrMap.get(key);
            if (!existing) {
                addrMap.set(key, p);
            } else {
                const existDate = existing.sold_date ? new Date(existing.sold_date).getTime() : 0;
                const newDate = p.sold_date ? new Date(p.sold_date).getTime() : 0;
                if (newDate > existDate) addrMap.set(key, p);
            }
        });
        if (addrMap.size < eligible.length) {
            console.log(`[routeOptimizer] Deduped: ${eligible.length} → ${addrMap.size} (removed ${eligible.length - addrMap.size} duplicate addresses)`);
        }
        eligible = Array.from(addrMap.values());
    }

    // Apply street cooldown filter if logs are provided
    let cooldownInfo = null;
    const hasPropertyStreetCooldown = eligible.some(
        property => property?.street_next_eligible_date
    );
    if (
        !preserveInputMembership
        && ((allLogs && allLogs.length > 0) || hasPropertyStreetCooldown)
    ) {
        const filtered = filterByStreetCooldown(eligible, allLogs, streetCooldownDays);
        eligible = filtered.eligible;
        cooldownInfo = {
            streetsOnCooldown: filtered.cooldownStreets,
            propertiesExcluded: filtered.onCooldown.length
        };
    }

    // Double Dip Protection: Exclude Terminal Statuses
    // NOTE: 'SOLD' here means the property's original MLS sale record, NOT that a rep already sold them.
    // 'UNVERIFIED' = legacy CSV data, still actionable for routing (treated like ELIGIBLE)
    // so we only exclude HARD_NO / DO_NOT_KNOCK / COOLDOWN — NOT 'SOLD' or 'UNVERIFIED'.
    if (!preserveInputMembership && excludeTerminal) {
        const terminalStatuses = ['HARD_NO', 'DO_NOT_KNOCK', 'COOLDOWN'];
        eligible = eligible.filter(p => !terminalStatuses.includes(p.effective_status));
    }

    if (eligible.length === 0) return [];

    console.log(`[routeOptimizer] Scoring ${eligible.length} properties...`);
    const t0 = Date.now();

    let scored;
    // FAST PATH: Skip expensive per-property scoring for large datasets
    if (eligible.length > 5000) {
        console.log(`[routeOptimizer] Large dataset (${eligible.length}) — using fast scoring`);
        // Simple inline score: no H3, no log lookups, no batchScoreProperties
        scored = eligible.map(p => {
            let score = 100;
            if (p.effective_status === 'ELIGIBLE') score += 60;
            if (p.effective_status === 'CALLBACK') score += 100;
            if (p.effective_status === 'QUALIFIED') score += 80;
            if (p.effective_status === 'UNVERIFIED') score += 40;
            if (p.effective_status === 'NO_ANSWER') score += 30;
            if (p.effective_status === 'HARD_NO') score = 0;
            if (p.effective_status === 'SOLD' && p.sold_date) {
                const monthsAgo = (Date.now() - new Date(p.sold_date).getTime()) / (1000 * 60 * 60 * 24 * 30.44);
                if (monthsAgo <= 3) score += 80;
                else if (monthsAgo <= 6) score += 60;
                else if (monthsAgo <= 12) score += 40;
                else score += 20;
            }
            if (p.price > 1000000) score += 30;
            return { ...p, score: Math.max(0, score), propensity: 0.5 };
        });
    } else {
        // FULL PATH: H3 neighborhood heat + propensity + full scoring
        const neighborhoodStats = {};
        eligible.forEach(p => {
            if (p.lat && p.lng && (p.effective_status === 'SOLD' || p.effective_status === 'QUALIFIED' || p.effective_status === 'UNVERIFIED')) {
                try {
                    const h3Index = latLngToCell(p.lat, p.lng, 9);
                    const disk = gridDisk(h3Index, 1);
                    disk.forEach(cell => {
                        neighborhoodStats[cell] = (neighborhoodStats[cell] || 0) + 1;
                    });
                } catch (e) {}
            }
        });

        const propensityMap = batchScoreProperties(eligible, allLogs, learnedWeights);

        scored = eligible.map(p => {
            const hash = p.address_hash || p.id;
            const pData = propensityMap.get(hash);
            const propensity = pData ? pData.propensity : 0.5;
            return {
                ...p,
                propensity,
                score: scoreProperty(p, allLogs, neighborhoodStats, learnedWeights),
            };
        });
    }

    console.log(`[routeOptimizer] Scoring done in ${Date.now() - t0}ms`);

    // MAIL CARRIER: Geographic cluster pre-separation happens inside mailCarrierOrder.
    let clustered = scored.map(p => ({ ...p, cluster: 0 }));

    // Generate routes
    const routes = [];

    // We iterate through all unique cluster IDs found
    const clusterIds = [...new Set(clustered.map(p => p.cluster))];

    for (const i of clusterIds) {
        const clusterProps = clustered.filter(p => p.cluster === i);
        if (clusterProps.length === 0) continue;

        // MAIL CARRIER ORDERING
        console.log(`[routeOptimizer] Mail carrier ordering ${clusterProps.length} properties...`);
        const t1 = Date.now();
        const orderedProps = mailCarrierOrder(
            clusterProps,
            startLocation,
            hasFixedRouteBounds ? effectiveEndLocation : null,
            effectiveRoutingContext
        );
        console.log(`[routeOptimizer] Mail carrier done in ${Date.now() - t1}ms (${orderedProps.length} ordered)`);

        const orderedChunks = splitOrderedPropertiesByRoutingBoundaries(
            orderedProps,
            housesPerRoute,
            effectiveRoutingContext
        );
        const useRoadMetrics = effectiveRoutingContext?.costOnly !== true
            && typeof effectiveRoutingContext?.distanceBetween === 'function';

        for (const orderedChunk of orderedChunks) {
            const routeProperties = orderedChunks.length > 1 && !preserveGlobalChunkOrder
                ? mailCarrierOrder(
                    orderedChunk,
                    startLocation,
                    hasFixedRouteBounds ? effectiveEndLocation : null,
                    effectiveRoutingContext
                )
                : orderedChunk;

        // Street Sweep treats each street as an atomic walking block. Point-level
        // front-loading or endpoint optimization here can pull one door out of
        // its street and create A Street -> B Street -> A Street backtracking.

        // Metrics — use fast distance for large routes
        let totalDistance = 0;
        let totalScore = 0;
        const distFn = routeProperties.length > 5000 ? calculateDistanceFast : calculateDistance;

        for (let j = 0; j < routeProperties.length - 1; j++) {
            const legDist = useRoadMetrics
                ? routingDistance(
                    routeProperties[j],
                    routeProperties[j + 1],
                    effectiveRoutingContext
                )
                : distFn(
                    routeProperties[j].lat, routeProperties[j].lng,
                    routeProperties[j + 1].lat, routeProperties[j + 1].lng
                );

            totalDistance += legDist;
            totalScore += routeProperties[j].score;
        }
        totalScore += routeProperties[routeProperties.length - 1]?.score || 0;

        // In bounded mode the displayed estimate represents the complete trip:
        // external start -> every door -> external finish.
        if (hasFixedRouteBounds && routeProperties.length > 0) {
            totalDistance = useRoadMetrics
                ? routingDistance(startLocation, routeProperties[0], effectiveRoutingContext)
                    + totalDistance
                    + routingDistance(
                        routeProperties[routeProperties.length - 1],
                        effectiveEndLocation,
                        effectiveRoutingContext
                    )
                : calculateRouteDistanceMiles(routeProperties, {
                    startLocation,
                    endLocation: effectiveEndLocation
                });
        } else if (returnToStart && routeProperties.length > 1) {
            totalDistance += useRoadMetrics
                ? routingDistance(
                    routeProperties[routeProperties.length - 1],
                    routeProperties[0],
                    effectiveRoutingContext
                )
                : calculateDistance(
                    routeProperties[routeProperties.length - 1].lat,
                    routeProperties[routeProperties.length - 1].lng,
                    routeProperties[0].lat,
                    routeProperties[0].lng
                );
        }

        const avgScore = totalScore / routeProperties.length;
        const efficiency = routeProperties.length / Math.max(totalDistance, 0.1);

        // Factor in distance from start location (if provided)
        let distanceFromStart = 0;
        if (startLocation && routeProperties.length > 0) {
            distanceFromStart = useRoadMetrics
                ? routingDistance(startLocation, routeProperties[0], effectiveRoutingContext)
                : calculateDistance(
                    startLocation.lat, startLocation.lng,
                    routeProperties[0].lat, routeProperties[0].lng
                );
        }
        let distanceToEnd = 0;
        if (effectiveEndLocation && routeProperties.length > 0) {
            distanceToEnd = useRoadMetrics
                ? routingDistance(
                    routeProperties[routeProperties.length - 1],
                    effectiveEndLocation,
                    effectiveRoutingContext
                )
                : calculateDistance(
                    routeProperties[routeProperties.length - 1].lat,
                    routeProperties[routeProperties.length - 1].lng,
                    effectiveEndLocation.lat,
                    effectiveEndLocation.lng
                );
        }

        // H3 Density Scoring (skip for large routes — too expensive)
        let densityMultiplier = 1.0;
        if (routeProperties.length <= 5000) {
            const cellCounts = {};
            let maxDensity = 0;
            routeProperties.forEach(p => {
                if (p.lat && p.lng) {
                    try {
                        const cell = latLngToCell(p.lat, p.lng, 9);
                        cellCounts[cell] = (cellCounts[cell] || 0) + 1;
                        if (cellCounts[cell] > maxDensity) maxDensity = cellCounts[cell];
                    } catch (e) {}
                }
            });
            densityMultiplier = 1 + Math.min(0.2, (maxDensity / 10) * 0.2);
        }

        // Competitiveness: Score (60%) + Efficiency (30%) - Commute Penalty (capped to prevent edge routes from dropping out)
        const commutePenalty = Math.min(distanceFromStart * 2, 20);

        let competitivenessScore = Math.round(((avgScore * 0.6 + efficiency * 100 * 0.4) * densityMultiplier) - commutePenalty);

        // Get unique streets in this route
        const routeStreets = [...new Set(routeProperties.map(p => p.street_name).filter(Boolean))];

        let routeMode = 'precision';
        try { if (typeof localStorage !== 'undefined') routeMode = localStorage.getItem('fk_routeMode') || 'precision'; } catch (e) {}
        const routeNumber = routes.length + 1;
        routes.push({
            id: `route_${routeNumber}`,
            name: buildRouteName(routeProperties, routeMode, routeNumber),
            route_mode: routeMode,
            properties: routeProperties,
            houseCount: routeProperties.length,
            streetCount: routeStreets.length,
            streets: routeStreets,
            totalDistance: Math.round(totalDistance * 100) / 100,
            distanceFromStart: Math.round(distanceFromStart * 100) / 100,
            distanceToEnd: Math.round(distanceToEnd * 100) / 100,
            totalScore: Math.round(totalScore),
            avgScore: Math.round(avgScore),
            competitivenessScore,
            status: 'NOT_STARTED',
            completedCount: 0,
            ...(hasFixedRouteBounds ? {
                startLocation: { ...startLocation },
                endLocation: { ...effectiveEndLocation },
                routeOriginMode: normalizedRouteOriginMode,
                metadata: {
                    route_bounds: {
                        enabled: true,
                        mode: normalizedRouteOriginMode
                    }
                }
            } : {})
        });
        }
    }

    // Route ordering may change, but membership may not. Fail before any caller
    // can save if a future optimization regression drops or duplicates a door.
    assertExactRouteMembership(eligible, routes);

    // Sort routes by competitiveness
    routes.sort((a, b) => b.competitivenessScore - a.competitivenessScore);

    // Rename routes sequentially by rank while keeping the area context visible.
    routes.forEach((route, index) => {
        route.name = buildRouteName(route.properties || [], route.route_mode, index + 1);
    });

    // Attach cooldown info to result
    if (cooldownInfo) {
        // Use Object.defineProperty to avoid TS complaining about Array properties
        Object.defineProperty(routes, '_cooldownInfo', {
            value: cooldownInfo,
            enumerable: false,
            writable: true
        });
    }

    return routes;
}

// ─── Mail-Carrier (Boustrophedon) Algorithm ─────────────────────────────────

const STREET_SUFFIX_CANONICAL = new Map([
    ['ALY', 'ALY'], ['ALLEY', 'ALY'],
    ['AVE', 'AVE'], ['AVENUE', 'AVE'],
    ['BLVD', 'BLVD'], ['BOULEVARD', 'BLVD'],
    ['CIR', 'CIR'], ['CIRCLE', 'CIR'],
    ['CT', 'CT'], ['COURT', 'CT'],
    ['CV', 'CV'], ['COVE', 'CV'],
    ['DR', 'DR'], ['DRIVE', 'DR'],
    ['HWY', 'HWY'], ['HIGHWAY', 'HWY'],
    ['LN', 'LN'], ['LANE', 'LN'],
    ['PKWY', 'PKWY'], ['PARKWAY', 'PKWY'],
    ['PL', 'PL'], ['PLACE', 'PL'],
    ['PT', 'PT'], ['POINT', 'PT'],
    ['RD', 'RD'], ['ROAD', 'RD'],
    ['SQ', 'SQ'], ['SQUARE', 'SQ'],
    ['ST', 'ST'], ['STREET', 'ST'],
    ['TER', 'TER'], ['TERRACE', 'TER'],
    ['TRL', 'TRL'], ['TRAIL', 'TRL'],
    ['WAY', 'WAY']
]);

/** Canonicalize trailing street types while preserving the type and direction. */
function normalizeStreetName(raw) {
    if (!raw || !raw.trim()) return '__UNKNOWN__';
    const tokens = raw
        .toUpperCase()
        .trim()
        .split(/\s+/)
        .map(token => token.replace(/[.,]+$/g, ''));
    // DO NOT strip directional prefix.
    // 'N Main St' and 'S Main St' are different streets on opposite sides of an intersection.
    // Stripping 'N'/'S' causes them to be grouped together and walked as one street.
    // Preserve the trailing type so Oak Dr and Oak Ln cannot be collapsed together.
    if (tokens.length > 1 && STREET_SUFFIX_CANONICAL.has(tokens[tokens.length - 1])) {
        tokens[tokens.length - 1] = STREET_SUFFIX_CANONICAL.get(tokens[tokens.length - 1]);
    }
    return tokens.join(' ') || '__UNKNOWN__';
}

function stablePropertyKey(property, fallbackIndex = 0) {
    return String(
        property?.address_hash
        || property?.legacy_hash
        || property?.id
        || [
            property?.house_number || '',
            normalizeStreetName(property?.street_name),
            property?.lat ?? '',
            property?.lng ?? '',
            fallbackIndex
        ].join('|')
    );
}

function compareStableKeys(first, second) {
    const firstKey = String(first);
    const secondKey = String(second);
    if (firstKey < secondKey) return -1;
    if (firstKey > secondKey) return 1;
    return 0;
}

function contextKey(routingContext, method, property) {
    if (typeof routingContext?.[method] !== 'function') return '';
    try {
        const value = routingContext[method](property);
        return value === undefined || value === null ? '' : String(value).trim();
    } catch (error) {
        console.warn(`[routeOptimizer] routingContext.${method} failed; using geographic fallback`, error);
        return '';
    }
}

export function canonicalStreetRoutingKey(property, fallbackIndex = 0) {
    const normalizedStreet = normalizeStreetName(property?.street_name);
    const zip = String(property?.zip_code || property?.zip || '').trim().slice(0, 5);
    const city = String(property?.city || '').trim().toUpperCase();
    const unknownIdentity = stablePropertyKey(property, fallbackIndex);
    return normalizedStreet === '__UNKNOWN__'
        ? `__UNKNOWN__|${unknownIdentity}`
        : `${normalizedStreet}|${city}|${zip}`;
}

function streetGroupKey(property, fallbackIndex, routingContext = null) {
    const normalizedStreet = normalizeStreetName(property?.street_name);
    const canonicalKey = canonicalStreetRoutingKey(property, fallbackIndex);
    const segmentKey = contextKey(routingContext, 'streetSegmentKey', property);
    if (segmentKey) {
        const segmentStreet = normalizedStreet === '__UNKNOWN__'
            ? canonicalKey
            : normalizedStreet;
        return `${segmentStreet}|SEGMENT:${segmentKey}`;
    }
    return canonicalKey;
}

function accessGroupKey(property, routingContext = null) {
    return contextKey(routingContext, 'accessGroupKey', property);
}

function routingDistance(first, second, routingContext = null) {
    if (typeof routingContext?.distanceBetween === 'function') {
        try {
            const rawDistance = routingContext.distanceBetween(first, second);
            if (rawDistance !== null && rawDistance !== undefined && rawDistance !== '') {
                const distance = Number(rawDistance);
                if (Number.isFinite(distance) && distance >= 0) return distance;
            }
        } catch (error) {
            console.warn('[routeOptimizer] routingContext.distanceBetween failed; using geographic fallback', error);
        }
    }
    return calculateDistanceFast(first.lat, first.lng, second.lat, second.lng);
}

function splitOrderedPropertiesByRoutingBoundaries(
    properties,
    housesPerRoute,
    routingContext = null
) {
    if (!properties || properties.length === 0) return [];
    const targetSize = Math.floor(Number(housesPerRoute));
    if (!Number.isFinite(targetSize) || targetSize <= 0 || targetSize >= properties.length) {
        return [[...properties]];
    }

    const streetRuns = [];
    properties.forEach((property, index) => {
        const streetKey = streetGroupKey(property, index, routingContext);
        const accessKey = accessGroupKey(property, routingContext);
        const previous = streetRuns[streetRuns.length - 1];
        if (
            previous
            && previous.streetKey === streetKey
            && previous.accessKey === accessKey
        ) {
            previous.properties.push(property);
        } else {
            streetRuns.push({
                streetKey,
                accessKey,
                properties: [property]
            });
        }
    });

    // A known access group is the preferred cut boundary. Streets without an
    // access group remain their own preferred atomic unit.
    const accessUnits = [];
    streetRuns.forEach((streetRun) => {
        const previous = accessUnits[accessUnits.length - 1];
        if (
            streetRun.accessKey
            && previous
            && previous.accessKey === streetRun.accessKey
        ) {
            previous.streetRuns.push(streetRun);
            previous.properties.push(...streetRun.properties);
        } else {
            accessUnits.push({
                accessKey: streetRun.accessKey,
                streetRuns: [streetRun],
                properties: [...streetRun.properties]
            });
        }
    });

    const preferredPieces = [];
    accessUnits.forEach((unit) => {
        if (unit.properties.length <= targetSize) {
            preferredPieces.push(unit.properties);
            return;
        }

        // An access group larger than a route must be divided. Fall back to its
        // complete street segments, splitting individual streets only when one
        // street alone is larger than the requested route size.
        unit.streetRuns.forEach((streetRun) => {
            for (let index = 0; index < streetRun.properties.length; index += targetSize) {
                preferredPieces.push(streetRun.properties.slice(index, index + targetSize));
            }
        });
    });

    const chunks = [];
    let current = [];
    preferredPieces.forEach((piece) => {
        if (current.length > 0 && current.length + piece.length > targetSize) {
            chunks.push(current);
            current = [];
        }
        current.push(...piece);
        if (current.length >= targetSize) {
            chunks.push(current);
            current = [];
        }
    });
    if (current.length > 0) chunks.push(current);

    return chunks;
}

/** Group properties by canonical street and optional road-network segment. */
function groupByStreet(properties, routingContext = null) {
    const groups = new Map();
    [...properties]
        .sort((first, second) => compareStableKeys(
            stablePropertyKey(first),
            stablePropertyKey(second)
        ))
        .forEach((p, index) => {
        const key = streetGroupKey(p, index, routingContext);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
    });
    return groups;
}

/** Order streets by nearest-neighbor on centroids, then 2-opt refine. */
function orderStreetsByNearestNeighbor(streetGroups, startLocation) {
    const streetNames = Array.from(streetGroups.keys());
    if (streetNames.length <= 1) return streetNames;

    // Compute centroids
    const centroids = streetNames.map(name => {
        const props = streetGroups.get(name);
        const lat = props.reduce((s, p) => s + p.lat, 0) / props.length;
        const lng = props.reduce((s, p) => s + p.lng, 0) / props.length;
        return { name, lat, lng };
    });

    // For very large street counts, use a simple lat/lng sort instead of O(n²) NN
    if (centroids.length > 500) {
        console.log(`[routeOptimizer] ${centroids.length} streets — using spatial sort (fast path)`);
        // Sort by a space-filling curve approximation (interleaved lat+lng)
        centroids.sort((a, b) => {
            const cellSize = 0.01; // ~0.7 miles
            const rowA = Math.floor(a.lat / cellSize);
            const rowB = Math.floor(b.lat / cellSize);
            if (rowA !== rowB) return rowA - rowB;
            // Boustrophedon: alternate lng direction per row
            return rowA % 2 === 0 ? a.lng - b.lng : b.lng - a.lng;
        });
        return centroids.map(c => c.name);
    }

    // Nearest neighbor from start
    const visited = [];
    const remaining = [...centroids];
    let current = startLocation
        ? { lat: startLocation.lat, lng: startLocation.lng }
        : remaining[0];

    // Find closest to start
    let bestIdx = 0;
    let bestDist = Infinity;
    remaining.forEach((c, i) => {
        const d = calculateDistanceFast(current.lat, current.lng, c.lat, c.lng);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
    });
    current = remaining.splice(bestIdx, 1)[0];
    visited.push(current);

    while (remaining.length > 0) {
        bestIdx = 0;
        bestDist = Infinity;
        remaining.forEach((c, i) => {
            const d = calculateDistanceFast(current.lat, current.lng, c.lat, c.lng);
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        });
        current = remaining.splice(bestIdx, 1)[0];
        visited.push(current);
    }

    // 2-opt on the street sequence (small N, fast)
    if (visited.length >= 4 && visited.length <= 200) {
        let improved = true;
        let iters = 0;
        while (improved && iters < 30) {
            improved = false;
            iters++;
            for (let i = 1; i < visited.length - 2; i++) {
                for (let j = i + 2; j < visited.length; j++) {
                    const d1 = calculateDistanceFast(visited[i-1].lat, visited[i-1].lng, visited[i].lat, visited[i].lng)
                             + calculateDistanceFast(visited[j].lat, visited[j].lng, (visited[j+1]||visited[j]).lat, (visited[j+1]||visited[j]).lng);
                    const d2 = calculateDistanceFast(visited[i-1].lat, visited[i-1].lng, visited[j].lat, visited[j].lng)
                             + calculateDistanceFast(visited[i].lat, visited[i].lng, (visited[j+1]||visited[j]).lat, (visited[j+1]||visited[j]).lng);
                    if (d2 < d1) {
                        const seg = visited.splice(i, j - i + 1).reverse();
                        visited.splice(i, 0, ...seg);
                        improved = true;
                    }
                }
            }
        }
    }

    return visited.map(c => c.name);
}

// A dedicated pass down one side of the street only pays off when that side has
// enough doors. With one or two scattered doors per side (typical Precision
// pulls) the odd-then-even U-turn makes reps walk past a door and double back.
const DENSE_SIDE_DOOR_COUNT = 3;
const MAX_AXIS_ORDER_DOORS = 60;

/**
 * Order sparse street doors by their position along the street itself, so the
 * walk continues in one direction instead of skipping a door and returning.
 */
function orderAlongStreetAxis(props) {
    if (props.length <= 2 || props.length > MAX_AXIS_ORDER_DOORS) return props;

    // The two farthest-apart doors define the street's direction.
    let start = props[0];
    let end = props[1];
    let longest = -1;
    for (let i = 0; i < props.length; i++) {
        for (let j = i + 1; j < props.length; j++) {
            const span = calculateDistanceFast(props[i].lat, props[i].lng, props[j].lat, props[j].lng);
            if (span > longest) {
                longest = span;
                start = props[i];
                end = props[j];
            }
        }
    }

    const axisLat = end.lat - start.lat;
    const axisLng = end.lng - start.lng;
    if (axisLat === 0 && axisLng === 0) return props;

    const projection = p => (p.lat - start.lat) * axisLat + (p.lng - start.lng) * axisLng;
    return [...props].sort((a, b) => projection(a) - projection(b));
}

/** Walk one side of the street low→high, cross, walk the other side high→low. */
function boustrophedonStreet(props, reverseDirection) {
    if (props.length <= 1) return props;

    const odd = props.filter(p => {
        const num = parseInt(p.house_number, 10);
        return isNaN(num) || num % 2 !== 0;
    });
    const even = props.filter(p => {
        const num = parseInt(p.house_number, 10);
        return !isNaN(num) && num % 2 === 0;
    });

    // Sparse coverage on either side: walk the street straight through instead of
    // committing to a full side-by-side sweep that backtracks.
    if (odd.length < DENSE_SIDE_DOOR_COUNT || even.length < DENSE_SIDE_DOOR_COUNT) {
        const axisOrder = orderAlongStreetAxis(props);
        return reverseDirection ? [...axisOrder].reverse() : axisOrder;
    }

    const sortByNum = (a, b) => (parseInt(a.house_number, 10) || 0) - (parseInt(b.house_number, 10) || 0);
    odd.sort(sortByNum);
    even.sort(sortByNum);

    if (reverseDirection) {
        return [...even.reverse(), ...odd];
    }
    return [...odd, ...even.reverse()];
}

/** 2-opt scoped to a single street's properties only. */
function applyIntraStreet2Opt(props) {
    if (props.length < 4 || props.length > 50) return props; // Skip for large streets
    let improved = true;
    let iters = 0;
    while (improved && iters < 10) {
        improved = false;
        iters++;
        for (let i = 0; i < props.length - 2; i++) {
            for (let j = i + 2; j < props.length; j++) {
                const d1 = calculateDistanceFast(props[i].lat, props[i].lng, props[i+1].lat, props[i+1].lng)
                         + (j + 1 < props.length ? calculateDistanceFast(props[j].lat, props[j].lng, props[j+1].lat, props[j+1].lng) : 0);
                const d2 = calculateDistanceFast(props[i].lat, props[i].lng, props[j].lat, props[j].lng)
                         + (j + 1 < props.length ? calculateDistanceFast(props[i+1].lat, props[i+1].lng, props[j+1].lat, props[j+1].lng) : 0);
                if (d2 < d1) {
                    const seg = props.splice(i + 1, j - i).reverse();
                    props.splice(i + 1, 0, ...seg);
                    improved = true;
                }
            }
        }
    }
    return props;
}

// Two doors that share a street name but sit nearly half a mile apart are not
// one walkable street to a rep — forcing them adjacent makes the route march
// away past other doors and circle back (the reported Mesquite Eastbrook Dr /
// Flamingo Way bounce). Split only on gaps decisively larger than a dense long
// avenue's door spacing (~0.35 mi in the wide-street regression fixture), so
// genuinely continuous streets always remain one atomic block.
const STREET_SPLIT_GAP_MILES = 0.4;

function splitStreetGroupByGaps(props, groupKey) {
    // A road-network segment key is ground truth that these doors sit on one
    // connected road — never second-guess it with the aerial gap heuristic.
    if (String(groupKey).includes('|SEGMENT:')) return [props];
    if (props.length <= 1 || props.length > MAX_AXIS_ORDER_DOORS) return [props];
    const ordered = orderAlongStreetAxis(props);
    const pieces = [];
    let current = [ordered[0]];
    for (let i = 1; i < ordered.length; i++) {
        const gap = calculateDistanceFast(
            ordered[i - 1].lat, ordered[i - 1].lng,
            ordered[i].lat, ordered[i].lng
        );
        if (gap > STREET_SPLIT_GAP_MILES) {
            pieces.push(current);
            current = [];
        }
        current.push(ordered[i]);
    }
    pieces.push(current);
    return pieces;
}

function buildStreetSweepBlocks(properties, routingContext = null) {
    return [...groupByStreet(properties, routingContext).entries()]
        .sort(([firstKey], [secondKey]) => compareStableKeys(firstKey, secondKey))
        .flatMap(([key, allProps]) => splitStreetGroupByGaps(allProps, key).map((props, pieceIndex, pieces) => {
        const forward = applyIntraStreet2Opt(
            boustrophedonStreet([...props], false)
        );
        const accessKeys = [...new Set(
            props.map(property => accessGroupKey(property, routingContext)).filter(Boolean)
        )].sort();
        return {
            key: pieces.length > 1 ? `${key}#${pieceIndex}` : key,
            lat: props.reduce((sum, property) => sum + property.lat, 0) / props.length,
            lng: props.reduce((sum, property) => sum + property.lng, 0) / props.length,
            accessKey: accessKeys.length === 1 ? accessKeys[0] : '',
            variants: [forward, [...forward].reverse()]
        };
    }));
}

function streetBlockOrderCost(
    blocks,
    startLocation = null,
    endLocation = null,
    includePath = false,
    routingContext = null
) {
    if (blocks.length === 0) {
        return includePath ? { cost: 0, orientations: [] } : 0;
    }

    const costs = blocks.map(() => [Infinity, Infinity]);
    const previous = blocks.map(() => [-1, -1]);

    for (let orientation = 0; orientation < 2; orientation++) {
        const firstDoor = blocks[0].variants[orientation][0];
        costs[0][orientation] = isValidRoutePoint(startLocation)
            ? routingDistance(startLocation, firstDoor, routingContext)
            : 0;
    }

    for (let blockIndex = 1; blockIndex < blocks.length; blockIndex++) {
        for (let orientation = 0; orientation < 2; orientation++) {
            const firstDoor = blocks[blockIndex].variants[orientation][0];
            for (let previousOrientation = 0; previousOrientation < 2; previousOrientation++) {
                const previousDoors = blocks[blockIndex - 1].variants[previousOrientation];
                const previousLastDoor = previousDoors[previousDoors.length - 1];
                const candidateCost = costs[blockIndex - 1][previousOrientation]
                    + routingDistance(previousLastDoor, firstDoor, routingContext);
                if (candidateCost + 0.000000001 < costs[blockIndex][orientation]) {
                    costs[blockIndex][orientation] = candidateCost;
                    previous[blockIndex][orientation] = previousOrientation;
                }
            }
        }
    }

    let finalOrientation = 0;
    let finalCost = Infinity;
    for (let orientation = 0; orientation < 2; orientation++) {
        const finalDoors = blocks[blocks.length - 1].variants[orientation];
        const finalDoor = finalDoors[finalDoors.length - 1];
        const candidateCost = costs[blocks.length - 1][orientation]
            + (isValidRoutePoint(endLocation)
                ? routingDistance(finalDoor, endLocation, routingContext)
                : 0);
        if (candidateCost + 0.000000001 < finalCost) {
            finalCost = candidateCost;
            finalOrientation = orientation;
        }
    }

    if (!includePath) return finalCost;

    const orientations = new Array(blocks.length);
    orientations[blocks.length - 1] = finalOrientation;
    for (let blockIndex = blocks.length - 1; blockIndex > 0; blockIndex--) {
        orientations[blockIndex - 1] = previous[blockIndex][orientations[blockIndex]];
    }
    return { cost: finalCost, orientations };
}

function minimumBlockTransitionDistance(firstBlock, secondBlock, routingContext) {
    let bestDistance = Infinity;
    firstBlock.variants.forEach((firstVariant) => {
        const exit = firstVariant[firstVariant.length - 1];
        secondBlock.variants.forEach((secondVariant) => {
            const entry = secondVariant[0];
            bestDistance = Math.min(bestDistance, routingDistance(exit, entry, routingContext));
        });
    });
    return bestDistance;
}

function minimumDistanceFromPoint(point, block, routingContext) {
    return Math.min(
        ...block.variants.map(variant => routingDistance(point, variant[0], routingContext))
    );
}

function minimumDistanceToPoint(block, point, routingContext) {
    return Math.min(
        ...block.variants.map((variant) => (
            routingDistance(variant[variant.length - 1], point, routingContext)
        ))
    );
}

function contextAwareNearestNeighbor(
    blocks,
    startLocation,
    endLocation,
    routingContext,
    forcedFirstBlock = null
) {
    const remaining = [...blocks].sort((first, second) => compareStableKeys(first.key, second.key));
    const ordered = [];
    let finalBlock = null;

    if (isValidRoutePoint(endLocation) && remaining.length > 1) {
        let finalIndex = 0;
        let finalDistance = Infinity;
        remaining.forEach((block, index) => {
            const distance = minimumDistanceToPoint(block, endLocation, routingContext);
            if (
                distance + 0.000000001 < finalDistance
                || (
                    Math.abs(distance - finalDistance) <= 0.000000001
                    && compareStableKeys(block.key, remaining[finalIndex].key) < 0
                )
            ) {
                finalDistance = distance;
                finalIndex = index;
            }
        });
        [finalBlock] = remaining.splice(finalIndex, 1);
    }

    // Multi-start search: the caller may pin which block the sweep opens with so
    // several candidate macro orders can be generated from the same road costs.
    // A block already reserved as the finish is never also used as the start.
    let firstIndex = 0;
    const forcedIndex = forcedFirstBlock
        ? remaining.findIndex(block => block.key === forcedFirstBlock.key)
        : -1;
    if (forcedIndex >= 0) {
        ordered.push(remaining.splice(forcedIndex, 1)[0]);
    } else if (isValidRoutePoint(startLocation)) {
        let firstDistance = Infinity;
        remaining.forEach((block, index) => {
            const distance = minimumDistanceFromPoint(startLocation, block, routingContext);
            if (
                distance + 0.000000001 < firstDistance
                || (
                    Math.abs(distance - firstDistance) <= 0.000000001
                    && compareStableKeys(block.key, remaining[firstIndex].key) < 0
                )
            ) {
                firstDistance = distance;
                firstIndex = index;
            }
        });
    } else if (isValidRoutePoint(endLocation)) {
        let farthestDistance = -Infinity;
        remaining.forEach((block, index) => {
            const distance = minimumDistanceToPoint(block, endLocation, routingContext);
            if (
                distance > farthestDistance + 0.000000001
                || (
                    Math.abs(distance - farthestDistance) <= 0.000000001
                    && compareStableKeys(block.key, remaining[firstIndex].key) < 0
                )
            ) {
                farthestDistance = distance;
                firstIndex = index;
            }
        });
    }
    if (ordered.length === 0) ordered.push(remaining.splice(firstIndex, 1)[0]);

    while (remaining.length > 0) {
        const current = ordered[ordered.length - 1];
        let bestIndex = 0;
        let bestDistance = Infinity;
        remaining.forEach((candidate, index) => {
            const distance = minimumBlockTransitionDistance(current, candidate, routingContext);
            if (
                distance + 0.000000001 < bestDistance
                || (
                    Math.abs(distance - bestDistance) <= 0.000000001
                    && compareStableKeys(candidate.key, remaining[bestIndex].key) < 0
                )
            ) {
                bestDistance = distance;
                bestIndex = index;
            }
        });
        ordered.push(remaining.splice(bestIndex, 1)[0]);
    }

    if (finalBlock) ordered.push(finalBlock);
    return ordered;
}

function blockOrderSignature(blocks) {
    return blocks.map(block => String(block.key)).join('>');
}

/** Door-level leg costs for one oriented block order, in route order. */
function blockOrderLegDistances(blocks, orientations, routingContext) {
    const doors = blocks.flatMap((block, index) => block.variants[orientations[index]]);
    const legs = [];
    for (let index = 0; index < doors.length - 1; index++) {
        legs.push(routingDistance(doors[index], doors[index + 1], routingContext));
    }
    return legs;
}

/** Complete-route cost plus end-of-route concentration for one block order. */
function evaluateBlockOrder(blocks, startLocation, endLocation, routingContext) {
    const { cost, orientations } = streetBlockOrderCost(
        blocks,
        startLocation,
        endLocation,
        true,
        routingContext
    );
    return {
        order: blocks,
        cost,
        reentries: countStreetReentries(blocks),
        tail: summarizeRouteTail(blockOrderLegDistances(blocks, orientations, routingContext))
    };
}

/**
 * Improve one candidate block order with whole-block reversal and relocation.
 * Every move is scored on the complete route, never on the next leg alone, so a
 * repair cannot simply push the expensive stretch somewhere else.
 */
function refineBlockOrder(order, startLocation, endLocation, routingContext, passLimit) {
    let ordered = order;
    let currentCost = streetBlockOrderCost(
        ordered,
        startLocation,
        endLocation,
        false,
        routingContext
    );
    for (let pass = 0; pass < passLimit; pass++) {
        let bestCost = currentCost;
        let bestOrder = null;
        for (let start = 0; start < ordered.length - 1; start++) {
            for (let finish = start + 1; finish < ordered.length; finish++) {
                const candidate = [
                    ...ordered.slice(0, start),
                    ...ordered.slice(start, finish + 1).reverse(),
                    ...ordered.slice(finish + 1)
                ];
                const candidateCost = streetBlockOrderCost(
                    candidate,
                    startLocation,
                    endLocation,
                    false,
                    routingContext
                );
                if (candidateCost + 0.000001 < bestCost) {
                    bestCost = candidateCost;
                    bestOrder = candidate;
                }
            }
        }
        // Or-opt: relocate a single street block. Reversal moves alone cannot
        // rescue a block that greedy nearest-neighbor stranded — the route
        // otherwise walks away and bounces back for it many stops later.
        for (let from = 0; from < ordered.length; from++) {
            for (let to = 0; to <= ordered.length; to++) {
                if (to === from || to === from + 1) continue;
                const candidate = [...ordered];
                const [moved] = candidate.splice(from, 1);
                candidate.splice(to > from ? to - 1 : to, 0, moved);
                const candidateCost = streetBlockOrderCost(
                    candidate,
                    startLocation,
                    endLocation,
                    false,
                    routingContext
                );
                if (candidateCost + 0.000001 < bestCost) {
                    bestCost = candidateCost;
                    bestOrder = candidate;
                }
            }
        }
        if (!bestOrder) break;
        ordered = bestOrder;
        currentCost = bestCost;
    }
    return ordered;
}

function optimizeStreetBlockOrder(blocks, startLocation = null, endLocation = null, routingContext = null) {
    if (blocks.length <= 1) return [...blocks];

    // Point optimization is safe at this level because each point represents a
    // complete street sweep. No property can be detached from its street block.
    const stableBlocks = [...blocks].sort((first, second) => compareStableKeys(
        first.key,
        second.key
    ));
    if (stableBlocks.length > 500) {
        const cellSize = 0.01;
        const spatiallySorted = [...stableBlocks].sort((first, second) => {
            const firstRow = Math.floor(Number(first.lat) / cellSize);
            const secondRow = Math.floor(Number(second.lat) / cellSize);
            if (firstRow !== secondRow) return firstRow - secondRow;
            if (Number(first.lng) !== Number(second.lng)) {
                return firstRow % 2 === 0
                    ? Number(first.lng) - Number(second.lng)
                    : Number(second.lng) - Number(first.lng);
            }
            return compareStableKeys(first.key, second.key);
        });
        const reversed = [...spatiallySorted].reverse();
        return streetBlockOrderCost(
            reversed,
            startLocation,
            endLocation,
            false,
            routingContext
        ) + 0.000001 < streetBlockOrderCost(
            spatiallySorted,
            startLocation,
            endLocation,
            false,
            routingContext
        )
            ? reversed
            : spatiallySorted;
    }
    const costOnlyContext = routingContext?.costOnly === true;
    const canSeedFromRoutingContext = typeof routingContext?.distanceBetween === 'function';
    const seededOrder = canSeedFromRoutingContext
        ? contextAwareNearestNeighbor(
            stableBlocks,
            startLocation,
            endLocation,
            routingContext
        )
        : optimizeRouteWithBounds(stableBlocks, {
            startLocation: isValidRoutePoint(startLocation) ? startLocation : null,
            endLocation: isValidRoutePoint(endLocation) ? endLocation : null,
            max2OptPasses: 20,
            max2OptStops: 300
        });

    // Refine smaller routes using the true entry and exit doors of each whole
    // sweep. Cost-only contexts intentionally use a lower bound: evaluating
    // every reversal otherwise turns ~100 street blocks into millions of
    // synchronous road-cost lookups even though nearest-neighbor already used
    // the road graph and every street/access group remains atomic.
    const refinementBlockLimit = costOnlyContext ? 40 : 120;
    const refinementPassLimit = costOnlyContext ? 2 : 5;
    if (seededOrder.length > refinementBlockLimit) return seededOrder;

    // Multi-start: one greedy seed is what stranded an expensive group of blocks
    // at the end of the verified Mesquite route. Several deterministic diverse
    // starts are refined with the same cost function and the best complete route
    // wins, so a bad opening choice can no longer decide the whole sweep.
    const seedBudget = costOnlyContext
        ? BLOCK_SEQUENCING_LIMITS.maxCostOnlySeedCandidates
        : BLOCK_SEQUENCING_LIMITS.maxSeedCandidates;
    const refinedBudget = costOnlyContext
        ? BLOCK_SEQUENCING_LIMITS.maxCostOnlyRefinedCandidates
        : BLOCK_SEQUENCING_LIMITS.maxRefinedCandidates;
    const multiStartBlockLimit = costOnlyContext
        ? BLOCK_SEQUENCING_LIMITS.maxCostOnlyMultiStartBlocks
        : BLOCK_SEQUENCING_LIMITS.maxMultiStartBlocks;

    const seedOrders = [seededOrder];
    if (canSeedFromRoutingContext && stableBlocks.length <= multiStartBlockLimit) {
        selectDiverseSeedBlockIndexes(stableBlocks, seedBudget).forEach((seedIndex) => {
            seedOrders.push(contextAwareNearestNeighbor(
                stableBlocks,
                startLocation,
                endLocation,
                routingContext,
                stableBlocks[seedIndex]
            ));
        });
    }

    const seenSignatures = new Set();
    const refinedCandidates = seedOrders
        .filter((candidate) => {
            const signature = blockOrderSignature(candidate);
            if (seenSignatures.has(signature)) return false;
            seenSignatures.add(signature);
            return true;
        })
        .map(candidate => ({
            order: candidate,
            cost: streetBlockOrderCost(candidate, startLocation, endLocation, false, routingContext)
        }))
        .sort((first, second) => (
            first.cost - second.cost
            || compareStableKeys(blockOrderSignature(first.order), blockOrderSignature(second.order))
        ))
        .slice(0, Math.max(1, refinedBudget))
        .map(({ order }) => evaluateBlockOrder(
            refineBlockOrder(order, startLocation, endLocation, routingContext, refinementPassLimit),
            startLocation,
            endLocation,
            routingContext
        ));

    return selectBestBlockOrderCandidate(refinedCandidates)?.order || seededOrder;
}

function flattenOrientedStreetBlocks(
    blocks,
    startLocation = null,
    endLocation = null,
    routingContext = null
) {
    const { orientations } = streetBlockOrderCost(
        blocks,
        startLocation,
        endLocation,
        true,
        routingContext
    );
    return blocks.flatMap((block, index) => block.variants[orientations[index]]);
}

function buildAccessSweepBlocks(streetBlocks, routingContext = null) {
    const grouped = new Map();
    streetBlocks.forEach((block) => {
        const key = block.accessKey ? `ACCESS:${block.accessKey}` : `STREET:${block.key}`;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(block);
    });

    return [...grouped.entries()]
        .sort(([firstKey], [secondKey]) => compareStableKeys(firstKey, secondKey))
        .map(([key, blocks]) => {
            if (blocks.length === 1) {
                return {
                    ...blocks[0],
                    key
                };
            }

            const ordered = optimizeStreetBlockOrder(blocks, null, null, routingContext);
            const forward = flattenOrientedStreetBlocks(ordered, null, null, routingContext);
            return {
                key,
                lat: forward.reduce((sum, property) => sum + property.lat, 0) / forward.length,
                lng: forward.reduce((sum, property) => sum + property.lng, 0) / forward.length,
                accessKey: blocks[0].accessKey,
                variants: [forward, [...forward].reverse()]
            };
        });
}

/** Compute centroid for a property list. */
function computeCentroid(properties) {
    return {
        lat: properties.reduce((s, p) => s + p.lat, 0) / properties.length,
        lng: properties.reduce((s, p) => s + p.lng, 0) / properties.length,
    };
}

/**
 * Detect whether properties span multiple geographic clusters.
 * Returns cluster assignments (0, 1, 2...) if spread > thresholdMiles, else all 0.
 * This is a no-op for compact routes (spread <= 3 miles).
 *
 * @param {Array} properties - Array of property objects with .lat and .lng
 * @param {number} thresholdMiles - Minimum spread to trigger clustering (default 3.0)
 * @param {number} maxClusters - Maximum number of clusters (default 4)
 * @returns {number[]} Cluster assignment for each property (0-indexed)
 */
function detectGeoClusters(properties, thresholdMiles = 3.0, maxClusters = 4) {
    if (properties.length < 10) return properties.map(() => 0);

    // Compute bounding box diagonal to estimate geographic spread
    const lats = properties.map(p => p.lat);
    const lngs = properties.map(p => p.lng);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const spread = calculateDistanceFast(minLat, minLng, maxLat, maxLng);

    // No-op for compact routes
    if (spread <= thresholdMiles) return properties.map(() => 0);

    // Determine k: 1 cluster per thresholdMiles, capped at maxClusters
    const k = Math.min(maxClusters, Math.max(2, Math.round(spread / thresholdMiles)));

    return kMeansAssign(properties, k);
}

/**
 * K-Means++ assignment — returns cluster index (0..k-1) for each property.
 * Uses K-Means++ initialization for well-spread initial centroids.
 * Runs 15 iterations of Lloyd's algorithm.
 *
 * @param {Array} properties - Array of property objects with .lat and .lng
 * @param {number} k - Number of clusters
 * @returns {number[]} Cluster assignment for each property
 */
function kMeansAssign(properties, k) {
    // K-Means++ initialization: first centroid is properties[0],
    // each subsequent centroid chosen with probability proportional to D^2
    const centroids = [];
    centroids.push({ lat: properties[0].lat, lng: properties[0].lng });

    for (let c = 1; c < k; c++) {
        const dists = properties.map(p => {
            const minD = Math.min(...centroids.map(ct =>
                calculateDistanceFast(p.lat, p.lng, ct.lat, ct.lng)
            ));
            return minD * minD;
        });
        const total = dists.reduce((a, b) => a + b, 0);
        let r = Math.random() * total;
        let chosen = 0;
        for (let i = 0; i < dists.length; i++) {
            r -= dists[i];
            if (r <= 0) { chosen = i; break; }
        }
        centroids.push({ lat: properties[chosen].lat, lng: properties[chosen].lng });
    }

    // Lloyd's algorithm — 15 iterations
    let assignments = new Array(properties.length).fill(0);
    for (let iter = 0; iter < 15; iter++) {
        // Assign each property to nearest centroid
        assignments = properties.map(p => {
            let best = 0, bestD = Infinity;
            centroids.forEach((c, ci) => {
                const d = calculateDistanceFast(p.lat, p.lng, c.lat, c.lng);
                if (d < bestD) { bestD = d; best = ci; }
            });
            return best;
        });
        // Update centroids to mean of assigned properties
        for (let c = 0; c < k; c++) {
            const pts = properties.filter((_, i) => assignments[i] === c);
            if (pts.length > 0) {
                centroids[c] = {
                    lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length,
                    lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length,
                };
            }
        }
    }
    return assignments;
}

/**
 * Order cluster centroids by nearest-neighbor from a start position.
 * Returns an array of cluster indices in visit order.
 *
 * @param {Array} centroids - Array of {lat, lng} objects
 * @param {number} startLat - Starting latitude
 * @param {number} startLng - Starting longitude
 * @returns {number[]} Cluster indices in nearest-neighbor order
 */
function orderClustersByNN(centroids, startLat, startLng) {
    const unvisited = centroids.map((_, i) => i);
    const order = [];
    let curLat = startLat, curLng = startLng;
    while (unvisited.length > 0) {
        let bestIdx = 0, bestD = Infinity;
        unvisited.forEach((ci, idx) => {
            const d = calculateDistanceFast(curLat, curLng, centroids[ci].lat, centroids[ci].lng);
            if (d < bestD) { bestD = d; bestIdx = idx; }
        });
        const chosen = unvisited.splice(bestIdx, 1)[0];
        order.push(chosen);
        curLat = centroids[chosen].lat;
        curLng = centroids[chosen].lng;
    }
    return order;
}

/**
 * Internal mail-carrier ordering.
 * Streets remain atomic, and streets sharing a known access point remain inside
 * one higher-level block so a route cannot leave and later re-enter that pocket.
 */
function mailCarrierOrderSingleCluster(
    properties,
    startLocation,
    endLocation = null,
    routingContext = null
) {
    if (!properties || properties.length === 0) return [];

    // Filter out properties with missing/NaN coordinates
    const validProperties = properties.filter(p =>
        p && typeof p.lat === 'number' && !isNaN(p.lat) &&
        typeof p.lng === 'number' && !isNaN(p.lng)
    );
    if (validProperties.length === 0) return [];

    const streetBlocks = buildStreetSweepBlocks(validProperties, routingContext);
    const accessBlocks = buildAccessSweepBlocks(streetBlocks, routingContext);
    if (accessBlocks.length === 1 && streetBlocks.length > 1) {
        const orderedStreetBlocks = optimizeStreetBlockOrder(
            streetBlocks,
            startLocation,
            endLocation,
            routingContext
        );
        return flattenOrientedStreetBlocks(
            orderedStreetBlocks,
            startLocation,
            endLocation,
            routingContext
        );
    }
    const orderedBlocks = optimizeStreetBlockOrder(
        accessBlocks,
        startLocation,
        endLocation,
        routingContext
    );
    return flattenOrientedStreetBlocks(
        orderedBlocks,
        startLocation,
        endLocation,
        routingContext
    );
}

/** Full mail-carrier ordering with every normalized street kept contiguous. */
export function mailCarrierOrder(
    properties,
    startLocation = null,
    endLocation = null,
    routingContext = null
) {
    if (!properties || properties.length === 0) return [];
    if (properties.length === 1) return [...properties];

    // Filter out properties with missing/NaN coordinates
    const validProperties = properties.filter(p =>
        p && typeof p.lat === 'number' && !isNaN(p.lat) &&
        typeof p.lng === 'number' && !isNaN(p.lng)
    );
    if (validProperties.length === 0) return [];

    return mailCarrierOrderSingleCluster(
        validProperties,
        startLocation,
        endLocation,
        routingContext
    );
}

export function optimizeRouteByStreetSweep(
    properties,
    startLocation = null,
    endLocation = null,
    routingContext = null
) {
    return mailCarrierOrder(properties, startLocation, endLocation, routingContext);
}

// Re-export lead scoring for external consumers
export { batchScoreProperties, ownershipDurationScore, SCORING_CONSTANTS } from './leadScoring';

/**
 * Optimize route purely by minimum walking distance.
 * Applies: Nearest Neighbor → 2-Opt → Or-Opt (Link Swap)
 * Does NOT group by street — pure distance minimization.
 * @param {Array} properties - Array of {lat, lng, address_hash, ...}
 * @param {Object|null} startLocation - Optional {lat, lng} starting point
 * @returns {Array} Properties in optimized order
 */
export function optimizeRouteByDistance(properties, startLocation = null, endLocation = null) {
    if (!properties || properties.length === 0) return [];
    if (properties.length === 1) return [...properties];

    if (isValidRoutePoint(endLocation)) {
        return optimizeRouteWithBounds(properties, { startLocation, endLocation });
    }

    // Build working copy
    const props = properties.map(p => ({ ...p }));

    // Step 1: Nearest neighbor from start
    const startLat = startLocation?.lat ?? null;
    const startLng = startLocation?.lng ?? null;
    let ordered = optimizeRouteOrder(props, startLat, startLng, false);

    // Step 2: 2-Opt to eliminate crossings
    ordered = apply2Opt(ordered);

    // Step 3: Or-Opt (link swap) for further improvements
    ordered = applyLinkSwap(ordered);

    return ordered;
}

/**
 * Export route to JSON format
 */
export function exportRouteToJSON(route) {
    return {
        route_metadata: {
            route_id: route.id,
            route_name: route.name,
            total_houses: route.houseCount,
            total_distance_miles: route.totalDistance,
            competitiveness_score: route.competitivenessScore,
            status: route.status,
            completed: route.completedCount,
            generated_date: new Date().toISOString()
        },
        properties: route.properties.map((p, idx) => ({
            sequence: idx + 1,
            address_hash: p.address_hash,
            full_address: p.full_address,
            house_number: p.house_number,
            street_name: p.street_name,
            lat: p.lat,
            lng: p.lng,
            status: p.effective_status,
            score: p.score,
            is_ghost: p.is_ghost || false
        }))
    };
}

/**
 * Generate Maps URL for route using the selected provider
 * Returns { url, truncated, totalStops } so callers can warn users
 */
export function generateAppleMapsUrl(route, app = 'apple') {
    if (!route.properties || route.properties.length === 0) return { url: '', truncated: false, totalStops: 0 };

    const properties = route.properties;
    const maxStops = Math.min(properties.length, 10);
    const truncated = properties.length > 10;
    const step = Math.max(1, Math.floor(properties.length / maxStops));

    const origin = properties[0];
    const destination = properties[properties.length - 1];

    // Select waypoints evenly distributed
    const waypoints = [];
    for (let i = step; i < properties.length - 1; i += step) {
        if (waypoints.length < 8) {
            waypoints.push(properties[i]);
        }
    }

    // Apple Maps format: saddr (start), daddr (destination with +to: for waypoints)
    const originStr = `${origin.lat},${origin.lng}`;
    const destStr = `${destination.lat},${destination.lng}`;

    let url;
    if (app === 'google') {
        const destination = encodeURIComponent(destStr);
        const waypointParam = waypoints.length > 0 ? `&waypoints=${encodeURIComponent(waypoints.map(p => `${p.lat},${p.lng}`).join('|'))}` : '';
        url = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(originStr)}&destination=${destination}${waypointParam}&travelmode=walking`;
    } else if (waypoints.length > 0) {
        const waypointsStr = waypoints.map(p => `${p.lat},${p.lng}`).join('+to:');
        url = `https://maps.apple.com/?saddr=${originStr}&daddr=${waypointsStr}+to:${destStr}&dirflg=w`;
    } else {
        url = `https://maps.apple.com/?saddr=${originStr}&daddr=${destStr}&dirflg=w`;
    }

    return { url, truncated, totalStops: properties.length };
}