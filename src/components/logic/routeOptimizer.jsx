/**
 * Advanced Route Optimization Engine
 * Clusters properties into optimal driving routes based on:
 * - Geographic proximity
 * - Property value/score
 * - Distance minimization
 * - Street Sweep pattern (all houses on a street)
 * - Street Cooldown (avoid recently visited streets)
 */

import { filterByStreetCooldown, orderForStreetSweep, COOLDOWN_CONFIG } from './territoryLogic';
import { latLngToCell, gridDisk } from 'h3-js';
import { batchScoreProperties, ownershipDurationScore, SCORING_CONSTANTS } from './leadScoring';

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
        const myLogs = logs.filter(l => l.address_hash === propHash || (legacyHash && l.address_hash === legacyHash));

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

/**
 * Calculate bearing between two points
 */
function calculateBearing(lat1, lng1, lat2, lng2) {
    const y = Math.sin(lng2 - lng1) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) -
        Math.sin(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1);
    const brng = Math.atan2(y, x) * 180 / Math.PI;
    return (brng + 360) % 360;
}

/**
 * Nearest Neighbor TSP approximation for route ordering
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
 * Fatigue-Aware Front-Loading (§2.3)
 * Moves top propensity stops into the first 22 positions.
 * Constraint: max 12% distance increase.
 */
const FATIGUE_FRONT_LOAD_STOPS = 22;
const FRONT_LOAD_PROPENSITY_PERCENTILE = 0.30;
const DEFAULT_MAX_DISTANCE_INCREASE = 0.12;

function fatigueAwareFrontLoad(route) {
    if (route.length <= FATIGUE_FRONT_LOAD_STOPS) return route;

    // Calculate baseline distance
    const routeDist = (r) => {
        let d = 0;
        for (let i = 0; i < r.length - 1; i++) {
            d += calculateDistanceFast(r[i].lat, r[i].lng, r[i + 1].lat, r[i + 1].lng);
        }
        return d;
    };
    const baselineDist = routeDist(route);

    // Find top propensity stops
    const scored = route.map((p, idx) => ({ idx, propensity: p.propensity || p.score || 0 }));
    scored.sort((a, b) => b.propensity - a.propensity);
    const topCount = Math.ceil(route.length * FRONT_LOAD_PROPENSITY_PERCENTILE);
    const topIndices = new Set(scored.slice(0, topCount).map(s => s.idx));

    // Identify high-propensity stops currently outside the front window
    const toMove = [];
    for (let i = FATIGUE_FRONT_LOAD_STOPS; i < route.length; i++) {
        if (topIndices.has(i)) toMove.push(i);
    }

    if (toMove.length === 0) return route;

    // Move them into the front section, respecting distance constraint
    const result = [...route];
    let insertPos = 1; // Keep index 0 (start) locked

    for (const fromIdx of toMove) {
        // Find current position of this element in result
        const currentIdx = result.indexOf(route[fromIdx]);
        if (currentIdx < 0 || currentIdx <= insertPos) continue;
        if (insertPos >= FATIGUE_FRONT_LOAD_STOPS) break;

        const item = result.splice(currentIdx, 1)[0];
        result.splice(insertPos, 0, item);
        insertPos++;

        // Check distance constraint
        const newDist = routeDist(result);
        if ((newDist - baselineDist) / baselineDist > DEFAULT_MAX_DISTANCE_INCREASE) {
            // Undo
            result.splice(insertPos - 1, 1);
            result.splice(currentIdx, 0, item);
            insertPos--;
            break;
        }
    }

    return result;
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
                const newBearing = calculateBearing(current.lat * Math.PI / 180, current.lng * Math.PI / 180, prop.lat * Math.PI / 180, prop.lng * Math.PI / 180);
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
        currentBearing = calculateBearing(current.lat * Math.PI / 180, current.lng * Math.PI / 180, nextProp.lat * Math.PI / 180, nextProp.lng * Math.PI / 180);

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
export function generateOptimizedRoutes(properties, housesPerRoute = 50, startLocation = null, allLogs = [], options = {}, learnedWeights = null) {
    const {
        streetCooldownDays = COOLDOWN_CONFIG.STREET_COOLDOWN_DAYS,
        useStreetSweep = true,
        minimizeTurns = false,
        use2Opt = true,
        returnToStart = false,
        maxRouteDistance = null,
        excludeTerminal = true
    } = options;

    // Filter out properties on streets that are on cooldown
    // Also filter out invalid coordinates (Null Island 0,0)
    let eligible = properties.filter(p =>
        p && p.lat && p.lng &&
        !(Math.abs(p.lat) < 0.0001 && Math.abs(p.lng) < 0.0001)
    );

    // Deduplicate by normalized address (safety net for Phase1/Phase2 hash mismatch)
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

    // Apply street cooldown filter if logs are provided
    let cooldownInfo = null;
    if (allLogs && allLogs.length > 0) {
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
    if (excludeTerminal) {
        const terminalStatuses = ['HARD_NO', 'DO_NOT_KNOCK', 'COOLDOWN'];
        eligible = eligible.filter(p => !terminalStatuses.includes(p.effective_status));
    }

    if (eligible.length === 0) return [];

    // Pre-calculate Neighborhood Heat (Recent Sales count per H3 hexagon)
    const neighborhoodStats = {};
    eligible.forEach(p => {
        if (p.lat && p.lng && (p.effective_status === 'SOLD' || p.effective_status === 'QUALIFIED' || p.effective_status === 'UNVERIFIED')) {
            try {
                const h3Index = latLngToCell(p.lat, p.lng, 9);
                // Add heat to the cell itself and its immediate neighbors (gridDisk radius 1)
                const disk = gridDisk(h3Index, 1);
                disk.forEach(cell => {
                    neighborhoodStats[cell] = (neighborhoodStats[cell] || 0) + 1;
                });
            } catch (e) {}
        }
    });

    // V2 Propensity scoring (§1.5)
    const propensityMap = batchScoreProperties(eligible, allLogs, learnedWeights);

    // Score all properties — propensity feeds into score for backward compat
    const scored = eligible.map(p => {
        const hash = p.address_hash || p.id;
        const pData = propensityMap.get(hash);
        const propensity = pData ? pData.propensity : 0.5;
        return {
            ...p,
            propensity,
            score: scoreProperty(p, allLogs, neighborhoodStats, learnedWeights),
        };
    });

    // MAIL CARRIER: Always generate a single route — all properties in one contiguous sweep
    // Skip K-Means clustering entirely for single-route generation
    const numRoutes = 1;
    let clustered = scored.map(p => ({ ...p, cluster: 0 }));

    // Generate routes
    const routes = [];

    // We iterate through all unique cluster IDs found
    const clusterIds = [...new Set(clustered.map(p => p.cluster))];

    for (const i of clusterIds) {
        const clusterProps = clustered.filter(p => p.cluster === i);
        if (clusterProps.length === 0) continue;

        // MAIL CARRIER: Always use street sweep ordering
        // Every street is fully completed before moving to the next
        // NOTE: orderForStreetSweep already applies nearest-neighbor + 2-opt
        // on the STREET CENTROID sequence to minimize inter-street travel.
        // We intentionally do NOT apply global apply2Opt/applyLinkSwap here
        // because those destroy the street grouping — causing routes to
        // bounce between streets instead of completing one before the next.
        let orderedProps = orderForStreetSweep(clusterProps);

        // Return to start: add first property at the end conceptually (affects distance calc)
        if (returnToStart && orderedProps.length > 1) {
            // We don't literally duplicate, but we account for return distance in metrics
        }

        // Metrics
        let totalDistance = 0;
        let totalScore = 0;

        for (let j = 0; j < orderedProps.length - 1; j++) {
            const legDist = calculateDistance(
                orderedProps[j].lat, orderedProps[j].lng,
                orderedProps[j + 1].lat, orderedProps[j + 1].lng
            );

            // Basic Max Distance Check - Stop adding if we exceed limit
            if (maxRouteDistance && (totalDistance + legDist) > maxRouteDistance) {
                // Remove remaining properties from this route
                // In a real implementation we might want to put them back in the pool, 
                // but for now we just truncate to respect the user's hard constraint.
                orderedProps.splice(j + 1);
                break;
            }

            totalDistance += legDist;
            totalScore += orderedProps[j].score;
        }
        totalScore += orderedProps[orderedProps.length - 1]?.score || 0;

        // Add return-to-start distance if enabled
        if (returnToStart && orderedProps.length > 1) {
            const returnDist = calculateDistance(
                orderedProps[orderedProps.length - 1].lat, orderedProps[orderedProps.length - 1].lng,
                orderedProps[0].lat, orderedProps[0].lng
            );
            totalDistance += returnDist;
        }

        const avgScore = totalScore / orderedProps.length;
        const efficiency = orderedProps.length / Math.max(totalDistance, 0.1);

        // Factor in distance from start location (if provided)
        let distanceFromStart = 0;
        if (startLocation && orderedProps.length > 0) {
            distanceFromStart = calculateDistance(
                startLocation.lat, startLocation.lng,
                orderedProps[0].lat, orderedProps[0].lng
            );
        }

        // H3 Density Scoring
        // Count how many properties are in each H3 cell in this route
        const cellCounts = {};
        let maxDensity = 0;
        orderedProps.forEach(p => {
            if (p.lat && p.lng) {
                try {
                    const cell = latLngToCell(p.lat, p.lng, 9);
                    cellCounts[cell] = (cellCounts[cell] || 0) + 1;
                    if (cellCounts[cell] > maxDensity) maxDensity = cellCounts[cell];
                } catch (e) {}
            }
        });
        
        // Density multiplier: up to 20% bonus for highly dense routes (e.g. 10+ houses in same hex)
        const densityMultiplier = 1 + Math.min(0.2, (maxDensity / 10) * 0.2);

        // Competitiveness: Score (60%) + Efficiency (30%) - Commute Penalty (capped to prevent edge routes from dropping out)
        const commutePenalty = Math.min(distanceFromStart * 2, 20);

        let competitivenessScore = Math.round(((avgScore * 0.6 + efficiency * 100 * 0.4) * densityMultiplier) - commutePenalty);

        // Get unique streets in this route
        const routeStreets = [...new Set(orderedProps.map(p => p.street_name).filter(Boolean))];

        routes.push({
            id: `route_${i + 1}`,
            name: `Route ${i + 1}`,
            properties: orderedProps,
            houseCount: orderedProps.length,
            streetCount: routeStreets.length,
            streets: routeStreets,
            totalDistance: Math.round(totalDistance * 100) / 100,
            distanceFromStart: Math.round(distanceFromStart * 100) / 100,
            totalScore: Math.round(totalScore),
            avgScore: Math.round(avgScore),
            competitivenessScore,
            status: 'NOT_STARTED',
            completedCount: 0
        });
    }

    // Sort routes by competitiveness
    routes.sort((a, b) => b.competitivenessScore - a.competitivenessScore);

    // Rename routes sequentially based on rank
    routes.forEach((route, index) => {
        route.name = `Route ${index + 1}`;
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
export function optimizeRouteByDistance(properties, startLocation = null) {
    if (!properties || properties.length === 0) return [];
    if (properties.length === 1) return [...properties];

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
 * Generate Apple Maps URL for route
 * Returns { url, truncated, totalStops } so callers can warn users
 */
export function generateAppleMapsUrl(route) {
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
    if (waypoints.length > 0) {
        const waypointsStr = waypoints.map(p => `${p.lat},${p.lng}`).join('+to:');
        url = `https://maps.apple.com/?saddr=${originStr}&daddr=${waypointsStr}+to:${destStr}&dirflg=w`;
    } else {
        url = `https://maps.apple.com/?saddr=${originStr}&daddr=${destStr}&dirflg=w`;
    }

    return { url, truncated, totalStops: properties.length };
}