/**
 * Advanced Route Optimization Engine
 * Clusters properties into optimal driving routes based on:
 * - Geographic proximity
 * - Property value/score
 * - Distance minimization
 * - Realistic door-to-door patterns
 */

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
 * Score a property based on multiple factors
 * Higher score = better target
 */
export function scoreProperty(property) {
    let score = 100; // Base score
    
    // 1. Status Scoring
    if (property.effective_status === 'ELIGIBLE') score += 50;
    if (property.effective_status === 'CALLBACK') score += 30;
    if (property.effective_status === 'NO_ANSWER') score += 20;
    if (property.effective_status === 'QUALIFIED') score += 70;
    if (property.effective_status === 'SOLD' || property.effective_status === 'HARD_NO') score = 0; // Don't route to these
    
    // 2. Freshness Scoring (Date Sold)
    // "Get to the home buyers first" - Extremely granular decay
    if (property.sold_date) {
        const soldDate = new Date(property.sold_date);
        const now = new Date();
        const daysAgo = (now - soldDate) / (1000 * 60 * 60 * 24);
        
        if (daysAgo <= 7) score += 200;        // 1 week: Hot!
        else if (daysAgo <= 30) score += 180;  // 1 month
        else if (daysAgo <= 60) score += 160;  // 2 months
        else if (daysAgo <= 90) score += 140;  // 3 months
        else if (daysAgo <= 120) score += 120; // 4 months
        else if (daysAgo <= 150) score += 100; // 5 months
        else if (daysAgo <= 180) score += 80;  // 6 months
        else if (daysAgo <= 210) score += 70;  // 7 months
        else if (daysAgo <= 240) score += 60;  // 8 months
        else if (daysAgo <= 270) score += 50;  // 9 months
        else if (daysAgo <= 300) score += 40;  // 10 months
        else if (daysAgo <= 330) score += 30;  // 11 months
        else if (daysAgo <= 365) score += 20;  // 1 year
    }

    // 3. Price/Value Scoring
    // "How expensive the house is"
    if (property.price) {
        if (property.price > 1000000) score += 40;
        else if (property.price > 750000) score += 30;
        else if (property.price > 500000) score += 20;
    }

    // Ghost leads get lower priority
    if (property.is_ghost) score = score * 0.5;
    
    return score;
}

/**
 * K-means clustering for geographic grouping
 */
function kMeansClustering(properties, numClusters) {
    if (properties.length <= numClusters) {
        return properties.map((p, i) => ({ ...p, cluster: i }));
    }
    
    // Initialize centroids randomly
    let centroids = properties
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
        properties.forEach(prop => {
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
            const clusterProps = properties.filter(p => p.cluster === idx);
            if (clusterProps.length === 0) return centroids[idx];
            
            const avgLat = clusterProps.reduce((sum, p) => sum + p.lat, 0) / clusterProps.length;
            const avgLng = clusterProps.reduce((sum, p) => sum + p.lng, 0) / clusterProps.length;
            return { lat: avgLat, lng: avgLng };
        });
    }
    
    return properties;
}

/**
 * Nearest Neighbor TSP approximation for route ordering
 */
function optimizeRouteOrder(properties, startLat = null, startLng = null) {
    if (properties.length === 0) return [];
    
    const unvisited = [...properties];
    const route = [];
    
    // Start from provided location or first property
    let current = startLat && startLng 
        ? { lat: startLat, lng: startLng }
        : unvisited.shift();
    
    if (startLat && startLng) {
        // Find nearest to start
        let nearestIdx = 0;
        let minDist = Infinity;
        unvisited.forEach((prop, idx) => {
            const dist = calculateDistance(current.lat, current.lng, prop.lat, prop.lng);
            if (dist < minDist) {
                minDist = dist;
                nearestIdx = idx;
            }
        });
        current = unvisited.splice(nearestIdx, 1)[0];
    }
    
    route.push(current);
    
    // Nearest neighbor
    while (unvisited.length > 0) {
        let nearestIdx = 0;
        let minDist = Infinity;
        
        unvisited.forEach((prop, idx) => {
            const dist = calculateDistance(current.lat, current.lng, prop.lat, prop.lng);
            if (dist < minDist) {
                minDist = dist;
                nearestIdx = idx;
            }
        });
        
        current = unvisited.splice(nearestIdx, 1)[0];
        route.push(current);
    }
    
    return route;
}

/**
 * Generate optimized routes with clustering
 * @param {Array} properties - All properties to route
 * @param {Number} housesPerRoute - Target houses per route (default 50)
 * @param {Object} startLocation - Optional {lat, lng} starting point
 * @returns {Array} Array of route objects with metadata
 */
export function generateOptimizedRoutes(properties, housesPerRoute = 50, startLocation = null) {
    // Use ALL properties
    const eligible = properties.filter(p => p && p.lat && p.lng);
    if (eligible.length === 0) return [];
    
    // Score all properties
    const scored = eligible.map(p => ({
        ...p,
        score: scoreProperty(p)
    }));
    
    // Calculate number of routes
    const numRoutes = Math.ceil(scored.length / housesPerRoute);
    
    // Cluster properties
    const clustered = kMeansClustering(scored, numRoutes);
    
    // Generate routes
    const routes = [];
    for (let i = 0; i < numRoutes; i++) {
        const clusterProps = clustered.filter(p => p.cluster === i);
        if (clusterProps.length === 0) continue;
        
        // Optimize order
        const orderedProps = optimizeRouteOrder(
            clusterProps, 
            startLocation?.lat, 
            startLocation?.lng
        );
        
        // Metrics
        let totalDistance = 0;
        let totalScore = 0;
        
        for (let j = 0; j < orderedProps.length - 1; j++) {
            totalDistance += calculateDistance(
                orderedProps[j].lat, orderedProps[j].lng,
                orderedProps[j + 1].lat, orderedProps[j + 1].lng
            );
            totalScore += orderedProps[j].score;
        }
        totalScore += orderedProps[orderedProps.length - 1]?.score || 0;
        
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
        
        routes.push({
            id: `route_${i + 1}`,
            name: `Route ${i + 1}`,
            properties: orderedProps,
            houseCount: orderedProps.length,
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
 * Generate Google Maps URL for route
 */
export function generateGoogleMapsUrl(route) {
    if (!route.properties || route.properties.length === 0) return '';
    
    // Google Maps supports up to 10 waypoints, so we'll use key stops
    const properties = route.properties;
    const maxStops = Math.min(properties.length, 10);
    const step = Math.max(1, Math.floor(properties.length / maxStops));
    
    const origin = properties[0];
    const destination = properties[properties.length - 1];
    
    // Select waypoints evenly distributed
    const waypoints = [];
    for (let i = step; i < properties.length - 1; i += step) {
        if (waypoints.length < 8) { // Leave room for origin and destination
            waypoints.push(properties[i]);
        }
    }
    
    const originStr = `${origin.lat},${origin.lng}`;
    const destStr = `${destination.lat},${destination.lng}`;
    const waypointsStr = waypoints.map(p => `${p.lat},${p.lng}`).join('|');
    
    let url = `https://www.google.com/maps/dir/?api=1&origin=${originStr}&destination=${destStr}`;
    if (waypointsStr) {
        url += `&waypoints=${waypointsStr}`;
    }
    url += '&travelmode=walking';
    
    return url;
}