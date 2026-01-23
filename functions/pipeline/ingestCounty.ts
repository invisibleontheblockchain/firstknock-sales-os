/**
 * BACKEND DATA PIPELINE - INGESTION ENGINE
 * Handles ingestion of external property data from county assessors.
 */

import { base44 } from '@/api/base44Client';

// Mock Data for 3 Counties to simulate the user's "JSON Upload"
const MOCK_DB = {
    'TEST_COUNTY': generateMockData(33.7490, -84.3880, 500, 'Fulton County, GA'), // Atlanta
    'LA_COUNTY': generateMockData(34.0522, -118.2437, 500, 'Los Angeles County, CA'), // LA
    'MARICOPA': generateMockData(33.4484, -112.0740, 500, 'Maricopa County, AZ') // Phoenix
};

function generateMockData(centerLat, centerLng, count, countyName) {
    const data = [];
    for (let i = 0; i < count; i++) {
        // Random spread ~0.1 degrees (approx 10km)
        const lat = centerLat + (Math.random() - 0.5) * 0.1;
        const lng = centerLng + (Math.random() - 0.5) * 0.1;
        
        data.push({
            PropertyAddress: `${Math.floor(Math.random() * 9999)} ${['Main', 'Oak', 'Maple', 'Pine', 'Cedar'][Math.floor(Math.random()*5)]} St`,
            City: countyName.split(',')[0],
            State: countyName.split(', ')[1].split(' ')[0], // Rough parse
            Zip: "00000",
            SaleDate: new Date(Date.now() - Math.floor(Math.random() * 90 * 24 * 60 * 60 * 1000)).toISOString().split('T')[0],
            SalePrice: 300000 + Math.floor(Math.random() * 500000),
            Latitude: lat,
            Longitude: lng,
            YearBuilt: 1990 + Math.floor(Math.random() * 35),
            Bedrooms: 3 + Math.floor(Math.random() * 3),
            Bathrooms: 2 + Math.floor(Math.random() * 2),
            TotalLivingArea: 1500 + Math.floor(Math.random() * 2000)
        });
    }
    return data;
}

function normalizeRecord(rawRecord) {
    const addressHash = btoa(`${rawRecord.PropertyAddress}-${rawRecord.Latitude}-${rawRecord.Longitude}`).replace(/=/g, '');
    return {
        address_hash: addressHash,
        house_number: parseInt(rawRecord.PropertyAddress.split(' ')[0]) || 0,
        street_name: rawRecord.PropertyAddress.split(' ').slice(1).join(' '),
        full_address: `${rawRecord.PropertyAddress}, ${rawRecord.City}, ${rawRecord.State}`,
        city: rawRecord.City,
        state: rawRecord.State,
        zip_code: rawRecord.Zip,
        lat: parseFloat(rawRecord.Latitude),
        lng: parseFloat(rawRecord.Longitude),
        price: rawRecord.SalePrice,
        sold_date: rawRecord.SaleDate,
        year_built: rawRecord.YearBuilt,
        beds: rawRecord.Bedrooms,
        baths: rawRecord.Bathrooms,
        sqft: rawRecord.TotalLivingArea,
        original_status: 'ELIGIBLE'
    };
}

export async function runIngestionPipeline(countyId) {
    console.log(`[Pipeline] Starting ingestion for ${countyId}`);
    
    // Select data source (Mock or potentially real in future)
    const rawData = MOCK_DB[countyId] || MOCK_DB['TEST_COUNTY'];
    console.log(`[Pipeline] Processing ${rawData.length} records for ${countyId}`);

    const normalizedData = rawData.map(normalizeRecord);
    
    let successCount = 0;
    
    // Batch Insert Simulation (In real backend, we'd use bulkCreate if available, or queue)
    // For browser-side simulation, we chunk it to avoid freezing UI
    const CHUNK_SIZE = 50;
    for (let i = 0; i < normalizedData.length; i += CHUNK_SIZE) {
        const chunk = normalizedData.slice(i, i + CHUNK_SIZE);
        await Promise.all(chunk.map(async (prop) => {
            try {
                // Check if exists first to avoid duplicates (Upsert logic)
                const existing = await base44.entities.MasterProperty.filter({ address_hash: prop.address_hash }, '-created_date', 1);
                if (existing.length === 0) {
                    await base44.entities.MasterProperty.create(prop);
                }
                successCount++;
            } catch (e) {
                console.warn('Ingest error:', e);
            }
        }));
        // Small delay to yield to main thread
        await new Promise(r => setTimeout(r, 100));
    }
    
    return { success: true, count: successCount };
}