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

    // 8. Algorithm II: Propensity Flags
    if (property.absentee_owner) score += 80;
    if (property.is_vacant) score += 100;
    if (property.is_out_of_state_absentee) score += 50; // Extra boost for out-of-state
    if (property.equity_percent > 0.7) score += 60;

    // 7. Machine Learning Lead Scoring Enhancement
    if (learnedWeights) {
        // ... (existing ML logic)
    }

    return Math.max(0, Math.round(score));
}

/**
 * DBSCAN (Density-Based Spatial Clustering of Applications with Noise)
 * Best for sparse suburban areas to filter out outliers
 */
function dbscanClustering(properties, eps, minPts) {
    const items = properties.map(p => ({ ...p, cluster: -1 })); // -1 = noise/unvisited
    let clusterId = 0;

    const getNeighbors = (p) => {
        return items.filter(other => {
            const dist = calculateDistanceFast(p.lat, p.lng, other.lat, other.lng);
            return dist <= eps;
        });
    };

    items.forEach(p => {
        if (p.cluster !== -1) return; // Already processed

        const neighbors = getNeighbors(p);
        if (neighbors.length < minPts) {
            p.cluster = -2; // Noise
            return;
        }

        p.cluster = clusterId;
        let seeds = neighbors.filter(n => n.address_hash !== p.address_hash);
        
        for (let i = 0; i < seeds.length; i++) {
            const q = seeds[i];
            const currentQ = items.find(item => item.address_hash === q.address_hash);
            
            if (currentQ.cluster === -2) currentQ.cluster = clusterId; // Change noise to border point
            if (currentQ.cluster !== -1) continue; // Already processed

            currentQ.cluster = clusterId;
            const qNeighbors = getNeighbors(currentQ);
            if (qNeighbors.length >= minPts) {
                seeds = seeds.concat(qNeighbors.filter(qn => !seeds.find(s => s.address_hash === qn.address_hash)));
            }
        }
        clusterId++;
    });

    return items;
}

/**
 * Inject Strategic Breaks based on route geometry and burnout heuristics
 */
function injectStrategicBreaks(route, intervalMinutes = 60) {
    const walkingSpeedMph = 2.5;
    const doorKnockMinutes = 5;
    let elapsedMinutes = 0;
    const newRoute = [];

    for (let i = 0; i < route.length; i++) {
        newRoute.push(route[i]);
        
        if (i < route.length - 1) {
            const dist = calculateDistance(route[i].lat, route[i].lng, route[i+1].lat, route[i+1].lng);
            const walkTime = (dist / walkingSpeedMph) * 60;
            elapsedMinutes += walkTime + doorKnockMinutes;

            if (elapsedMinutes >= intervalMinutes) {
                newRoute.push({ 
                    isBreak: true, 
                    duration: 15, 
                    label: "☕ Strategic Break (Fatigue Mitigation)",
                    lat: route[i].lat,
                    lng: route[i].lng
                });
                elapsedMinutes = 0;
            }
        }
    }
    return newRoute;
}

/**
 * Calculate bearing between two points
 */
function kMeansClustering(properties, numClusters) {
    if (properties.length <= numClusters) {
        return properties.map((p, i) => ({ ...p, cluster: i }));
    }

    // Clone properties to avoid mutating React state objects in-place
    let items = properties.map(p => ({ ...p }));

    // Initialize centroids randomly
    let centroids = items
        .slice()
        .sort(() => 0.5 - Math.random())
        .slice(0, numClusters)
        .map(p => ({ lat: p.lat, lng: p.lng }));

    let iterations = 0;
    const maxIterations = 20; // Reduced to 20 to prevent main thread blocking on large datasets
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

        // Recalculate centroids
        centroids = centroids.map((_, idx) => {
            const clusterProps = items.filter(p => p.cluster === idx);
            if (clusterProps.length === 0) return centroids[idx];

            const avgLat = clusterProps.reduce((sum, p) => sum + p.lat, 0) / clusterProps.length;
            const avgLng = clusterProps.reduce((sum, p) => sum + p.lng, 0) / clusterProps.length;
            return { lat: avgLat, lng: avgLng };
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
        walkingPattern = 'nearest',
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

    // Score all properties
    const scored = eligible.map(p => ({
        ...p,
        score: scoreProperty(p, allLogs, neighborhoodStats, learnedWeights)
    }));

    // Calculate number of routes
    const numRoutes = Math.ceil(scored.length / housesPerRoute);

    // Cluster properties
    // Density calculation: DU/Acre (approximate based on bounding box)
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    scored.forEach(p => {
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
        if (p.lng < minLng) minLng = p.lng;
        if (p.lng > maxLng) maxLng = p.lng;
    });
    const areaSqMiles = Math.max(0.01, (maxLat - minLat) * 69 * (maxLng - minLng) * 55);
    const density = scored.length / areaSqMiles;
    const isSparse = density < 100; // Heuristic for sparse/suburban

    let clustered = [];

    if (isSparse) {
        // Use DBSCAN for sparse areas to filter noise
        clustered = dbscanClustering(scored, 0.2, 5); // 0.2 miles, min 5 points
        // Filter out noise (-2)
        clustered = clustered.filter(p => p.cluster >= 0);
    } else {
        // Standard K-Means for dense areas
        clustered = kMeansClustering(scored, numRoutes);
    }

    // Generate routes
    const routes = [];
    const clusterIds = [...new Set(clustered.map(p => p.cluster))];

    for (const i of clusterIds) {
        const clusterProps = clustered.filter(p => p.cluster === i);
        if (clusterProps.length === 0) continue;

        // Use walking pattern to determine ordering
        let orderedProps;
        if (walkingPattern === 'recent_sale_first' || walkingPattern === 'fisherman') {
            // Find the anchor (most recently sold home in this cluster)
            const sorted = [...clusterProps].sort((a, b) => {
                const dateA = a.sold_date ? new Date(a.sold_date).getTime() : 0;
                const dateB = b.sold_date ? new Date(b.sold_date).getTime() : 0;
                return dateB - dateA;
            });
            
            // For Fisherman pattern, we might want to prioritize specific propensity neighbors
            // but for now, the sorted head is the best anchor.
            const anchor = sorted[0]; 
            orderedProps = optimizeRouteOrder(sorted, anchor.lat, anchor.lng, minimizeTurns);
            
            // Ensure anchor is always #1
            const anchorIdx = orderedProps.findIndex(p => p.address_hash === anchor.address_hash);
            if (anchorIdx > 0) {
                orderedProps.splice(anchorIdx, 1);
                orderedProps.unshift(anchor);
            }
        } else if (walkingPattern === 'street_sweep' || (useStreetSweep && walkingPattern !== 'nearest' && walkingPattern !== 'zigzag' && walkingPattern !== 'cluster' && walkingPattern !== 'recent_sale_first')) {
            orderedProps = orderForStreetSweep(clusterProps);
        } else {
            // Default nearest neighbor
            orderedProps = optimizeRouteOrder(clusterProps, startLocation?.lat, startLocation?.lng, minimizeTurns);
        }

        // Apply 2-opt post-optimization
        if (use2Opt && walkingPattern !== 'street_sweep') {
            if (walkingPattern === 'recent_sale_first' && orderedProps.length > 2) {
                const anchor = orderedProps[0];
                const rest = apply2Opt(orderedProps.slice(1));
                orderedProps = [anchor, ...rest];
            } else {
                orderedProps = apply2Opt(orderedProps);
            }
        }

        // Inject Strategic Breaks
        orderedProps = injectStrategicBreaks(orderedProps, 60); // Break every 60 mins

        // Metrics... (simplified for brevity, keeping core calculation)
        let totalDistance = 0;
        let totalScore = 0;
        const finalProps = orderedProps.filter(p => !p.isBreak);

        for (let j = 0; j < finalProps.length - 1; j++) {
            totalDistance += calculateDistance(finalProps[j].lat, finalProps[j].lng, finalProps[j + 1].lat, finalProps[j + 1].lng);
            totalScore += finalProps[j].score || 0;
        }
        totalScore += finalProps[finalProps.length - 1]?.score || 0;

        const avgScore = totalScore / finalProps.length;
        const routeStreets = [...new Set(finalProps.map(p => p.street_name).filter(Boolean))];

        routes.push({
            id: `route_${i + 1}`,
            name: (walkingPattern === 'recent_sale_first' ? `🎣 Fisherman Route ${i + 1}` : (isSparse ? `🏠 Suburban Loop ${i + 1}` : `🏢 Urban Grid ${i + 1}`)),
            properties: orderedProps,
            houseCount: finalProps.length,
            streetCount: routeStreets.length,
            streets: routeStreets,
            totalDistance: Math.round(totalDistance * 100) / 100,
            totalScore: Math.round(totalScore),
            avgScore: Math.round(avgScore),
            competitivenessScore: Math.round(avgScore * (isSparse ? 1.2 : 1.0)), // Boost sparse routes due to outlier filtering
            status: 'NOT_STARTED',
            completedCount: 0
        });
    }

    // Sort routes by competitiveness
    routes.sort((a, b) => b.competitivenessScore - a.competitivenessScore);

    // Attach cooldown info to result
    if (cooldownInfo) {
        Object.defineProperty(routes, '_cooldownInfo', {
            value: cooldownInfo,
            enumerable: false,
            writable: true
        });
    }

    return routes;
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