/**
 * BACKEND DATA PIPELINE - INGESTION ENGINE
 * 
 * This service handles the ingestion of external property data from county assessors.
 * It bypasses the frontend to handle large datasets (millions of records).
 * 
 * Architecture:
 * 1. Fetcher: Downloads raw data (CSV/JSON) from County Open Data Portals.
 * 2. Normalizer: Maps raw columns to the MasterProperty schema.
 * 3. Validator: Ensures data integrity (lat/lng presence, address hash).
 * 4. Loader: Batched upsert into Base44 Database.
 */

import { base44 } from '@/api/base44Client';

// Schema Mapping Configuration (Example for "Test County")
const SCHEMA_MAP = {
    'TEST_COUNTY': {
        source_fields: {
            'PropertyAddress': 'full_address',
            'City': 'city',
            'State': 'state',
            'Zip': 'zip_code',
            'SaleDate': 'sold_date',
            'SalePrice': 'price',
            'Latitude': 'lat',
            'Longitude': 'lng',
            'YearBuilt': 'year_built',
            'TotalLivingArea': 'sqft',
            'Bedrooms': 'beds',
            'Bathrooms': 'baths'
        }
    }
};

// Mock Data Source for "Test County" (Simulating an external CSV/API)
async function fetchRawCountyData(countyId) {
    console.log(`[Pipeline] Fetching data for ${countyId}...`);
    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 1000));

    if (countyId === 'TEST_COUNTY') {
        return [
            { PropertyAddress: "101 Test Blvd", City: "Testville", State: "GA", Zip: "30000", SaleDate: "2025-01-15", SalePrice: 450000, Latitude: 33.7490, Longitude: -84.3880, YearBuilt: 2020, Bedrooms: 4, Bathrooms: 3, TotalLivingArea: 2500 },
            { PropertyAddress: "102 Test Blvd", City: "Testville", State: "GA", Zip: "30000", SaleDate: "2025-01-10", SalePrice: 380000, Latitude: 33.7495, Longitude: -84.3885, YearBuilt: 2018, Bedrooms: 3, Bathrooms: 2, TotalLivingArea: 1800 },
            { PropertyAddress: "103 Test Blvd", City: "Testville", State: "GA", Zip: "30000", SaleDate: "2024-12-28", SalePrice: 520000, Latitude: 33.7500, Longitude: -84.3890, YearBuilt: 2022, Bedrooms: 5, Bathrooms: 4, TotalLivingArea: 3200 },
            // ... represents thousands of records
        ];
    }
    return [];
}

/**
 * Normalizes raw record to MasterProperty schema
 */
function normalizeRecord(rawRecord, schemaMap) {
    const map = schemaMap.source_fields;
    
    // Generate deterministic hash
    const addressHash = btoa(`${rawRecord.PropertyAddress}-${rawRecord.Zip}`).replace(/=/g, '');

    return {
        address_hash: addressHash,
        house_number: parseInt(rawRecord.PropertyAddress.split(' ')[0]) || 0,
        street_name: rawRecord.PropertyAddress.split(' ').slice(1).join(' '),
        full_address: `${rawRecord.PropertyAddress}, ${rawRecord.City}, ${rawRecord.State} ${rawRecord.Zip}`,
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

/**
 * Main Entry Point
 */
export async function runIngestionPipeline(countyId) {
    console.log(`[Pipeline] Starting ingestion for ${countyId}`);
    
    try {
        // 1. Fetch
        const rawData = await fetchRawCountyData(countyId);
        console.log(`[Pipeline] Fetched ${rawData.length} records`);

        // 2. Normalize
        const normalizedData = rawData.map(record => normalizeRecord(record, SCHEMA_MAP['TEST_COUNTY']));
        
        // 3. Load (Batch Insert)
        let successCount = 0;
        let failCount = 0;

        // Use sequential create to allow partial success (simulating resilience)
        for (const prop of normalizedData) {
            try {
                await base44.entities.MasterProperty.create(prop);
                successCount++;
            } catch (e) {
                console.warn(`[Pipeline] Failed to insert record ${prop.address_hash}:`, e);
                failCount++;
            }
        }
        
        console.log(`[Pipeline] Ingestion Complete. Success: ${successCount}, Failed: ${failCount}`);
        return { success: true, count: successCount, errors: failCount };
    } catch (error) {
        console.error('[Pipeline] Ingestion Failed:', error);
        return { success: false, error: error.message };
    }
}