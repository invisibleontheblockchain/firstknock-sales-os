import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';
import { secrets } from 'base44:runtime';
import { completeServerRoadAwareRoutes } from '../../shared/roadAwareBetaServer.js';

// Helper: Haversine Distance (Miles)
const calcDist = (lat1, lng1, lat2, lng2) => {
    if (!lat1 || !lng1 || !lat2 || !lng2) return 9999;
    const R = 3959; // Miles
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
            Math.sin(dLng/2) * Math.sin(dLng/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
};

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        
        // 1. Get all managers (users with active subscriptions)
        const users = await base44.asServiceRole.entities.User.filter({ subscription_status: 'active' });
        
        let routesCreated = 0;

        for (const user of users.items || []) {
            // 2. Get properties created by this user
            const properties = await base44.asServiceRole.entities.MasterProperty.filter({
                created_by: user.email
            }, '-created_date', 2000);
            
            // Filter for recent sales (last 30 days)
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
            
            const recentSales = (properties.items || []).filter(p => {
                if (!p.sold_date) return false;
                // Exclude unvalidated MLS Inactive records and BatchData-rejected properties
                if (p.sale_confidence === 'low') return false;
                if (p.original_status === 'REJECTED') return false;
                try {
                    const d = new Date(p.sold_date);
                    return d >= thirtyDaysAgo;
                } catch (e) {
                    return false;
                }
            });
            
            if (recentSales.length < 10) continue; // Need at least some homes
            
            // 3. Cluster them (simple greedy clustering within 5 miles)
            const clusters = [];
            for (const p of recentSales) {
                let added = false;
                for (const cluster of clusters) {
                    const dist = calcDist(cluster.center.lat, cluster.center.lng, p.lat, p.lng);
                    if (dist <= 5) { // Within 5 miles
                        cluster.properties.push(p);
                        // Update center (simple average)
                        cluster.center.lat = ((cluster.center.lat * (cluster.properties.length - 1)) + p.lat) / cluster.properties.length;
                        cluster.center.lng = ((cluster.center.lng * (cluster.properties.length - 1)) + p.lng) / cluster.properties.length;
                        added = true;
                        break;
                    }
                }
                if (!added) {
                    clusters.push({ center: { lat: p.lat, lng: p.lng }, properties: [p] });
                }
            }
            
            // 4. For clusters with >= 20 homes, create a route
            for (const cluster of clusters) {
                if (cluster.properties.length >= 20) { // Configurable threshold
                    const routeName = `🔥 Hot Sales Alert - ${cluster.properties[0].city || 'Area'}`;
                    
                    // Check if a similar route already exists to avoid duplicates
                    const existingRoutes = await base44.asServiceRole.entities.SavedRoute.filter({
                        manager_id: user.id,
                        name: routeName
                    });
                    
                    if (existingRoutes.items && existingRoutes.items.length > 0) continue;
                    
                    // Assign to a rep
                    const reps = await base44.asServiceRole.entities.TeamMember.filter({ manager_id: user.id });
                    let assignedRep = null;
                    if (reps.items && reps.items.length > 0) {
                        // Pick the first available rep
                        assignedRep = reps.items[0];
                    }
                    
                    const baselineRoutes = [{
                        properties: cluster.properties, totalDistance: 5, startLocation: cluster.center,
                    }];
                    const readSecret = name => { try { return String(secrets.get(name) || '').trim(); } catch { return ''; } };
                    const [completed] = await completeServerRoadAwareRoutes(baselineRoutes, { client: base44, user, entryPoint: 'auto_recent_sales', readSecret });
                    const created = await base44.asServiceRole.entities.SavedRoute.create({
                        name: routeName,
                        description: `Auto-generated route for ${cluster.properties.length} recent sales within 5 miles.`,
                        status: 'ACTIVE',
                        assigned_to: assignedRep ? assignedRep.id : null,
                        assigned_to_name: assignedRep ? assignedRep.name : null,
                        manager_id: user.id,
                        property_hashes: completed.properties.map(p => p.address_hash),
                        ...(completed.metadata ? { metadata: completed.metadata } : {}),
                        metrics: {
                            house_count: cluster.properties.length,
                            score: cluster.properties.length * 10, // High score for recent sales
                            distance: completed.totalDistance
                        },
                        start_location: cluster.center
                    });
                    if (completed.metadata?.road_aware_comparison_id) await base44.asServiceRole.entities.RoadAwareRoutingComparison.update(
                        completed.metadata.road_aware_comparison_id, { route_id: created.id }).catch(() => {});
                    
                    routesCreated++;
                }
            }
        }

        return Response.json({ success: true, routesCreated });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});
