// @ts-nocheck
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

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
        const payload = await req.json();
        
        // Event payload from entity automation
        const { event, data: route, old_data: oldRoute } = payload;

        console.log(`[AutoAssign] Processing event: ${event.type} for route ${route?.id}`);

        // Only proceed if status changed to COMPLETED
        if (event.type !== 'update' || route.status !== 'COMPLETED' || oldRoute?.status === 'COMPLETED') {
            return Response.json({ message: "Not a completion event" });
        }

        const repId = route.assigned_to;
        if (!repId) {
            return Response.json({ message: "No rep assigned to completed route" });
        }

        // Get Rep Details (Service Role to access TeamMember)
        const rep = await base44.asServiceRole.entities.TeamMember.get(repId);
        
        if (!rep) {
            return Response.json({ message: "Rep not found" });
        }

        if (!rep.auto_assign_enabled) {
            // TODO: Maybe send notification to manager suggesting a route?
            return Response.json({ message: "Auto-assign disabled for rep", rep: rep.name });
        }

        console.log(`[AutoAssign] Finding next route for ${rep.name} (${rep.id})`);

        // FIND NEXT BEST ROUTE
        // 1. Get all PENDING routes for this manager
        const managerId = rep.manager_id;
        if (!managerId) return Response.json({ message: "Rep has no manager" });

        const pendingRoutes = await base44.asServiceRole.entities.SavedRoute.filter({
            manager_id: managerId,
            status: 'PENDING',
            assigned_to: null // Ensure unassigned
        }, '-metrics.score', 100); // Top 100 by score

        if (!pendingRoutes.items || pendingRoutes.items.length === 0) {
            console.log("[AutoAssign] No pending routes available");
            return Response.json({ message: "No pending routes available" });
        }

        // 2. Score them based on proximity to completed route
        // Use the completed route's center/start as the "current location"
        const lastLocation = route.start_location || (route.properties && route.properties[0]) || null;
        
        // If we don't have location, just pick the highest score
        let bestRoute = null;

        if (lastLocation) {
            const routesWithDist = pendingRoutes.items.map(r => {
                const start = r.start_location || { lat: 0, lng: 0 }; // Fallback
                const dist = calcDist(lastLocation.lat, lastLocation.lng, start.lat, start.lng);
                
                // Composite score: High quality (metrics.score) + Proximity (lower dist)
                // Normalize dist: < 1 mile = bonus. > 10 miles = penalty.
                // Simple approach: Score - (Distance * 2)
                const effectiveScore = (r.metrics?.score || 0) - (dist * 2);
                
                return { ...r, dist, effectiveScore };
            });

            // Sort by effective score
            routesWithDist.sort((a, b) => b.effectiveScore - a.effectiveScore);
            bestRoute = routesWithDist[0];
        } else {
            // Just take highest score
            bestRoute = pendingRoutes.items[0];
        }

        if (bestRoute) {
            console.log(`[AutoAssign] Assigning route ${bestRoute.name} to ${rep.name}`);
            
            // Assign the route
            await base44.asServiceRole.entities.SavedRoute.update(bestRoute.id, {
                assigned_to: rep.id,
                assigned_to_name: rep.name,
                status: 'ACTIVE'
            });

            // Optional: Send notification (email/push) - For now just log
            // await base44.integrations.Core.SendEmail({...})

            return Response.json({ 
                success: true, 
                message: `Assigned ${bestRoute.name} to ${rep.name}`,
                route: bestRoute 
            });
        }

        return Response.json({ message: "No suitable route found" });

    } catch (error) {
        console.error("[AutoAssign] Error:", error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});