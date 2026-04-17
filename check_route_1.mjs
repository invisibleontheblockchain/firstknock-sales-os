import { createClient } from "@base44/sdk";

const base44 = createClient("695eb764b077190880be21de", {
  url: "https://my-to-do-list-81bfaad7.base44.app"
});

async function run() {
    const routesRes = await base44.entities.SavedRoute.list('-created_date', 10);
    const routes = Array.isArray(routesRes) ? routesRes : (routesRes?.items || []);
    
    const route1 = routes.find(r => r.name === "Route 1" || r.name?.includes("Route 1")) || routes[0];
    if (!route1) {
        console.log("No routes found.");
        return;
    }
    
    console.log(`Found route: ${route1.name} (ID: ${route1.id})`);
    const hashes = route1.property_hashes || [];
    console.log(`Route has ${hashes.length} stops.`);
}

run().catch(console.error);
