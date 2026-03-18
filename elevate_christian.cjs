const dotenv = require('dotenv');
dotenv.config();

const API_KEY = process.env.VITE_BASE44_API_KEY;
const API_URL = process.env.VITE_BASE44_API_URL || "https://api.base44.io/v1";

if (!API_KEY) {
    console.error("No VITE_BASE44_API_KEY found in .env");
    process.exit(1);
}

async function api(path, method = "GET", body = null) {
    const res = await fetch(`${API_URL}${path}`, {
        method,
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${API_KEY}`
        },
        body: body ? JSON.stringify(body) : undefined
    });
    
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`API error ${res.status}: ${text}`);
    }
    return res.json();
}

async function main() {
    try {
        console.log("Looking up Christian's account...");
        const usersRes = await api("/data/User?filter[email][_eq]=Christian@nativapest.com");
        const users = usersRes.items || usersRes;

        if (!users || users.length === 0) {
            console.log("Account not found.");
            return;
        }

        const user = users[0];
        console.log(`Found user: ${user.email} (ID: ${user.id})`);

        // 1. Elevate to Owner
        await api(`/data/User/${user.id}`, "PATCH", {
            is_owner: true,
            role: 'owner',
            area_pulls_count: 0 // Reset pulls just in case
        });
        console.log("✅ Elevated account to owner status.");

        // 2. Clear duplicate routes
        console.log("Looking for routes created by Christian...");
        const routesRes = await api(`/data/SavedRoute?filter[created_by][_eq]=${user.id}`);
        const routes = routesRes.items || routesRes;
        console.log(`Found ${routes.length} routes.`);

        let deletedCount = 0;
        let skipCount = 0;
        
        for (const route of routes) {
            if (!route.property_hashes) continue;
            
            const uniqueHashes = new Set(route.property_hashes);
            if (uniqueHashes.size < route.property_hashes.length) {
                console.log(`Route "${route.name}" has duplicates. Deleting...`);
                await api(`/data/SavedRoute/${route.id}`, "DELETE");
                deletedCount++;
            } else {
                skipCount++;
            }
        }
        
        console.log(`✅ Clean up complete. Deleted ${deletedCount} duplicate routes, skipped ${skipCount} clean routes.`);

    } catch (e) {
        console.error("Error:", e.message);
    }
}

main();
