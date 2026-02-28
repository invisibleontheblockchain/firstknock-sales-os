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

/**
 * Advanced Property Scoring Engine 3.0
 * Factors: Equity, Recent Sales (Activity), Property Type, Contact Frequency
 */
export function scoreProperty(property, logs = [], neighborhoodStats = {}) {
    let score = 100; // Base score

    // 1. Status Scoring Logic
    if (property.effective_status === 'ELIGIBLE') score += 60; // Slightly higher priority for fresh doors
    if (property.effective_status === 'CALLBACK') score += 100; // Top priority
    if (property.effective_status === 'NO_ANSWER') score += 30; // Worth another try
    if (property.effective_status === 'QUALIFIED') score += 80;
    if (property.effective_status === 'SOLD' || property.effective_status === 'HARD_NO') return 0;

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
    // If neighborhoodStats has data for this street/zip
    if (neighborhoodStats && property.zip_code) {
        const zipHeat = neighborhoodStats[property.zip_code] || 0;
        // Boost if area is hot (lots of recent sales = active market)
        score += Math.min(zipHeat * 5, 50);
    }

    // 5. Contact Frequency (Avoid Burnout, optimize 'when to knock')
    if (logs && logs.length > 0) {
        const myLogs = logs.filter(l => l.address_hash === (property.address_hash || property.id));

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

    return Math.max(0, Math.round(score));
}

/**
 * K-means clustering for geographic grouping
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
    const maxIterations = 50;
    let changed = true;

    while (changed && iterations < maxIterations) {
        changed = false;
        iterations++;

        // Assign each property to nearest centroid
        items.forEach(prop => {
            let minDist = Infinity;
            let bestCluster = 0;

            centroids.forEach((centroid, idx) => {
                const dist = calculateDistance(prop.lat, prop.lng, centroid.lat, centroid.lng);
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
    let improved = true;
    const maxIterations = 50; // Cap iterations for performance
    let iterations = 0;

    while (improved && iterations < maxIterations) {
        improved = false;
        iterations++;

        for (let i = 0; i < route.length - 2; i++) {
            for (let j = i + 2; j < route.length - 1; j++) { // j starts at i+2 to ensure we don't swap adjacent edges
                const p1 = route[i];
                const p2 = route[i + 1];
                const p3 = route[j];
                const p4 = route[j + 1];

                // Current distance: p1->p2 + p3->p4
                const currentDist = calculateDistance(p1.lat, p1.lng, p2.lat, p2.lng) +
                    calculateDistance(p3.lat, p3.lng, p4.lat, p4.lng);

                // New distance if swapped: p1->p3 + p2->p4 (reversing the segment p2...p3)
                const newDist = calculateDistance(p1.lat, p1.lng, p3.lat, p3.lng) +
                    calculateDistance(p2.lat, p2.lng, p4.lat, p4.lng);

                if (newDist < currentDist) {
                    // Reverse the segment from i+1 to j
                    const segment = route.slice(i + 1, j + 1).reverse();
                    route.splice(i + 1, segment.length, ...segment);
                    improved = true;
                }
            }
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
            const dist = calculateDistance(current.lat, current.lng, prop.lat, prop.lng);
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
            const dist = calculateDistance(current.lat, current.lng, prop.lat, prop.lng);
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
export function generateOptimizedRoutes(properties, housesPerRoute = 50, startLocation = null, allLogs = [], options = {}) {
    const {
        streetCooldownDays = COOLDOWN_CONFIG.STREET_COOLDOWN_DAYS,
        useStreetSweep = true,
        minimizeTurns = false,
        use2Opt = true,
        walkingPattern = 'nearest',
        returnToStart = false,
        maxRouteDistance = null
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
    const terminalStatuses = ['HARD_NO', 'SOLD', 'DO_NOT_KNOCK', 'COOLDOWN'];
    eligible = eligible.filter(p => !terminalStatuses.includes(p.effective_status));

    if (eligible.length === 0) return [];

    // Pre-calculate Neighborhood Heat (Recent Sales count per zip)
    const neighborhoodStats = eligible.reduce((acc, p) => {
        if (p.zip_code && (p.effective_status === 'SOLD' || p.effective_status === 'QUALIFIED')) {
            acc[p.zip_code] = (acc[p.zip_code] || 0) + 1;
        }
        return acc;
    }, {});

    // Score all properties
    const scored = eligible.map(p => ({
        ...p,
        score: scoreProperty(p, allLogs, neighborhoodStats)
    }));

    // Calculate number of routes
    const numRoutes = Math.ceil(scored.length / housesPerRoute);

    // Cluster properties
    // OPTIMIZATION: If multiple zip codes are present, cluster by Zip Code first to respect boundaries
    let clustered = [];

    // Group by Zip Code if we have enough properties and variance
    const uniqueZips = [...new Set(scored.map(p => p.zip_code).filter(Boolean))];
    // Disable zip clustering to prevent tiny routes in sparse zips - prefer pure geographic clustering
    const useZipClustering = false;

    if (useZipClustering) {
        let routeOffset = 0;
        uniqueZips.forEach(zip => {
            const zipProps = scored.filter(p => p.zip_code === zip);
            // Determine routes needed for this zip
            const zipRoutesCount = Math.max(1, Math.ceil(zipProps.length / housesPerRoute));

            // Sub-cluster this zip
            const zipClustered = kMeansClustering(zipProps, zipRoutesCount);

            // Apply global cluster IDs
            zipClustered.forEach(p => {
                p.cluster = p.cluster + routeOffset;
            });

            clustered = [...clustered, ...zipClustered];
            routeOffset += zipRoutesCount;
        });
    } else {
        // Standard K-Means for single area
        clustered = kMeansClustering(scored, numRoutes);
    }

    // Generate routes
    const routes = [];
    const totalClusters = useZipClustering ? Math.ceil(scored.length / housesPerRoute) + uniqueZips.length : numRoutes; // Approximate upper bound for loop

    // We iterate through all unique cluster IDs found
    const clusterIds = [...new Set(clustered.map(p => p.cluster))];

    for (const i of clusterIds) {
        const clusterProps = clustered.filter(p => p.cluster === i);
        if (clusterProps.length === 0) continue;

        // Use walking pattern to determine ordering
        let orderedProps;
        if (walkingPattern === 'street_sweep' || (useStreetSweep && walkingPattern !== 'nearest' && walkingPattern !== 'zigzag' && walkingPattern !== 'cluster')) {
            orderedProps = orderForStreetSweep(clusterProps);
        } else if (walkingPattern === 'zigzag') {
            // Zig-zag: sort by street, then alternate odd/even within each street
            const byStreet = {};
            clusterProps.forEach(p => {
                const s = p.street_name || 'unknown';
                if (!byStreet[s]) byStreet[s] = [];
                byStreet[s].push(p);
            });
            orderedProps = [];
            Object.values(byStreet).forEach(streetProps => {
                streetProps.sort((a, b) => a.house_number - b.house_number);
                // Interleave: take one from start, one from end
                const result = [];
                let left = 0, right = streetProps.length - 1;
                let fromLeft = true;
                while (left <= right) {
                    result.push(fromLeft ? streetProps[left++] : streetProps[right--]);
                    fromLeft = !fromLeft;
                }
                orderedProps.push(...result);
            });
        } else if (walkingPattern === 'cluster') {
            // Cluster hop: sort by score descending (hit high-density/high-score pockets first)
            orderedProps = [...clusterProps].sort((a, b) => (b.score || 0) - (a.score || 0));
            // Then apply nearest neighbor from top-scored property
            if (orderedProps.length > 0) {
                orderedProps = optimizeRouteOrder(orderedProps, orderedProps[0].lat, orderedProps[0].lng, minimizeTurns);
            }
        } else {
            // Nearest neighbor (default fallback)
            orderedProps = optimizeRouteOrder(
                clusterProps,
                startLocation?.lat,
                startLocation?.lng,
                minimizeTurns
            );
        }

        // Apply 2-opt post-optimization for smoother paths (if enabled)
        if (use2Opt && walkingPattern !== 'street_sweep') {
            orderedProps = apply2Opt(orderedProps);
        }

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

        // Competitiveness: Score (60%) + Efficiency (30%) - Commute Penalty (10%)
        // Commute penalty: subtract 10 points per mile away?
        const commutePenalty = distanceFromStart * 5;

        let competitivenessScore = Math.round((avgScore * 0.6 + efficiency * 100 * 0.4) - commutePenalty);

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