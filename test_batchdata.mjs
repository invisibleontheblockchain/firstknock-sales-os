import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

const API_KEY = process.env.BATCH_DATA_SANDBOX_KEY || process.env.BATCH_DATA_API_KEY;

if (!API_KEY) {
    console.error("❌ ERROR: No BatchData API key found in .env");
    process.exit(1);
}

console.log(`🔑 Using API Key: ${API_KEY.slice(0, 5)}...${API_KEY.slice(-4)}`);

async function testSandbox() {
    // We will use the standard search endpoint to find a mock property
    const url = 'https://api.batchdata.com/api/v1/property/search';
    
    const payload = { searchCriteria: { query: "123 Main St Phoenix AZ" } };

    console.log(`\n🚀 Sending payload to BatchData: ${JSON.stringify(payload)}`);
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify(payload)
        });
        
        console.log(`📡 Status: ${response.status} ${response.statusText}`);
        const data = await response.json().catch(() => ({}));
        
        if (response.ok || (data.status && data.status.code === 200)) {
            console.log("\n✅ SUCCESS! Received Data:");
            // Log exactly what BatchData returns so we can see where the MLS status lives
            console.log(JSON.stringify(data.results || data, null, 2));
        } else {
            console.log("❌ FAILED:", JSON.stringify(data, null, 2));
        }
    } catch (err) {
        console.error("Fatal Error", err);
    }
}

testSandbox();
