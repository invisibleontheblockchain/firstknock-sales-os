/**
 * Route Optimization Engine
 * K-means clustering + Nearest Neighbor TSP
 */

// Haversine distance in miles
function haversineDistance(lat1, lng1, lat2, lng2) {
    const R = 3959;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Score property for prioritization
function scoreProperty(prop) {
    const statusScores = {
        'ELIGIBLE': 50,
        'CALLBACK': 30,
        'QUALIFIED': 70,
        'NO_ANSWER': 20,
        'OTHER': 10,
        'SOLD': 0,
        'HARD_NO': 0,
        'DO_NOT_KNOCK': 0
    };
    return statusScores[prop.effective_status] || 0;
}

// K-means clustering
function kMeansClustering(properties, k) {
    if (properties.length <= k) {
        return properties.map((p, i) => ({ ...p, cluster: i }));
    }
    
    // Initialize centroids
    const shuffled = [...properties].sort(() => Math.random() - 0.5);
    let centroids = shuffled.slice(0, k).map(p => ({ lat: p.lat, lng: p.lng }));
    
    const result = properties.map(p => ({ ...p, cluster: 0 }));
    
    for (let iter = 0; iter < 30; iter++) {
        let changed = false;
        
        // Assign to nearest centroid
        result.forEach(prop => {
            let minDist = Infinity;
            let bestCluster = 0;
            
            centroids.forEach((c, idx) => {
                const dist = haversineDistance(prop.lat, prop.lng, c.lat, c.lng);
                if (dist < minDist) {
                    minDist = dist;
                    bestCluster = idx;
                }
            });
            
            if (prop.cluster !== bestCluster) {
                prop.cluster = bestCluster;
                changed = true;
            }
        });
        
        if (!changed) break;
        
        // Recalculate centroids
        centroids = centroids.map((_, idx) => {
            const cluster = result.filter(p => p.cluster === idx);
            if (cluster.length === 0) return centroids[idx];
            return {
                lat: cluster.reduce((s, p) => s + p.lat, 0) / cluster.length,
                lng: cluster.reduce((s, p) => s + p.lng, 0) / cluster.length
            };
        });
    }
    
    return result;
}

// Nearest neighbor route ordering
function optimizeOrder(properties) {
    if (properties.length <= 1) return properties;
    
    const unvisited = [...properties];
    const route = [unvisited.shift()];
    
    while (unvisited.length > 0) {
        const current = route[route.length - 1];
        let nearestIdx = 0;
        let minDist = Infinity;
        
        unvisited.forEach((p, idx) => {
            const dist = haversineDistance(current.lat, current.lng, p.lat, p.lng);
            if (dist < minDist) {
                minDist = dist;
                nearestIdx = idx;
            }
        });
        
        route.push(unvisited.splice(nearestIdx, 1)[0]);
    }
    
    return route;
}

/**
 * Generate optimized routes
 */
export function generateRoutes(properties, housesPerRoute = 50) {
    // Filter out excluded statuses
    const eligible = properties.filter(p => 
        p.effective_status !== 'SOLD' && 
        p.effective_status !== 'HARD_NO' &&
        p.effective_status !== 'DO_NOT_KNOCK'
    );
    
    if (eligible.length === 0) return [];
    
    // Limit for performance
    const limited = eligible.slice(0, 1000);
    const numRoutes = Math.min(20, Math.ceil(limited.length / housesPerRoute));
    
    // Cluster
    const clustered = kMeansClustering(limited, numRoutes);
    
    // Generate routes
    const routes = [];
    for (let i = 0; i < numRoutes; i++) {
        const clusterProps = clustered.filter(p => p.cluster === i);
        if (clusterProps.length === 0) continue;
        
        const ordered = optimizeOrder(clusterProps);
        
        // Calculate metrics
        let distance = 0;
        let totalScore = 0;
        
        for (let j = 0; j < ordered.length; j++) {
            totalScore += scoreProperty(ordered[j]);
            if (j > 0) {
                distance += haversineDistance(
                    ordered[j-1].lat, ordered[j-1].lng,
                    ordered[j].lat, ordered[j].lng
                );
            }
        }
        
        const avgScore = Math.round(totalScore / ordered.length);
        const efficiency = Math.round((ordered.length / Math.max(distance, 0.1)) * 10);
        
        routes.push({
            id: `route_${i + 1}`,
            name: `Route ${i + 1}`,
            properties: ordered,
            houseCount: ordered.length,
            distance: Math.round(distance * 100) / 100,
            totalScore,
            avgScore,
            competitiveness: avgScore + efficiency
        });
    }
    
    // Sort by competitiveness
    return routes.sort((a, b) => b.competitiveness - a.competitiveness);
}

/**
 * Generate Google Maps URL
 */
export function getGoogleMapsUrl(route) {
    if (!route.properties?.length) return '';
    
    const props = route.properties;
    const origin = `${props[0].lat},${props[0].lng}`;
    const dest = `${props[props.length - 1].lat},${props[props.length - 1].lng}`;
    
    // Select up to 8 waypoints evenly
    const waypoints = [];
    const step = Math.max(1, Math.floor(props.length / 8));
    for (let i = step; i < props.length - 1 && waypoints.length < 8; i += step) {
        waypoints.push(`${props[i].lat},${props[i].lng}`);
    }
    
    let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${dest}&travelmode=walking`;
    if (waypoints.length) {
        url += `&waypoints=${waypoints.join('|')}`;
    }
    
    return url;
}

/**
 * Export route to JSON
 */
export function exportRouteJSON(route) {
    return {
        metadata: {
            id: route.id,
            name: route.name,
            houses: route.houseCount,
            distance_miles: route.distance,
            score: route.competitiveness,
            generated: new Date().toISOString()
        },
        stops: route.properties.map((p, i) => ({
            sequence: i + 1,
            address_hash: p.address_hash,
            address: p.full_address,
            lat: p.lat,
            lng: p.lng,
            status: p.effective_status
        }))
    };
}