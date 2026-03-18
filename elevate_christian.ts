import { createClient } from "npm:@base44/sdk@0.8.20";

const base44 = createClient({
    appId: Deno.env.get("BASE44_APP_ID"),
    apiKey: Deno.env.get("BASE44_API_KEY"),
});

async function main() {
    try {
        console.log("Looking up Christian's account...");
        const users = await base44.asServiceRole.entities.User.filter({ email: "Christian@nativapest.com" });
        if (!users || users.length === 0) {
            console.log("Account not found.");
            return;
        }

        const user = users[0];
        console.log(`Found user: ${user.id}`);

        // 1. Elevate to Owner
        await base44.asServiceRole.entities.User.update(user.id, {
            is_owner: true,
            role: 'owner'
        });
        console.log("✅ Elevated account to owner status.");

        // 2. Clear duplicate routes
        console.log("Looking for routes created by Christian...");
        const routes = await base44.asServiceRole.entities.SavedRoute.filter({ created_by: user.id });
        console.log(`Found ${routes.length} routes.`);

        let deletedCount = 0;
        for (const route of routes) {
            // Check if route has duplicate properties
            const uniqueHashes = new Set(route.property_hashes);
            if (uniqueHashes.size < route.property_hashes.length) {
                console.log(`Route ${route.name} has duplicates. Deleting...`);
                await base44.asServiceRole.entities.SavedRoute.delete(route.id);
                deletedCount++;
            }
        }
        
        console.log(`✅ Clean up complete. Deleted ${deletedCount} duplicate routes.`);

    } catch (e) {
        console.error("Error:", e);
    }
}

main();
