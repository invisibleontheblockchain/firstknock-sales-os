/**
 * cache-writer.ts
 * Base44 SDK integration for 14-day database caching
 */
import { createClientFromRequest } from "npm:@base44/sdk@0.8.20";

// For standalone scripts, we create a mock version or pass standard auth 
// but since the original AI generated 'createClient', we'll simulate it for tests.
export async function checkAndWriteCache(base44: any, result: any) {
  // If no base44 instance passed (offline sandbox), skip the actual DB write
  if (!base44) {
    console.log(`[Cache-Offline] Would write ${result.address} to DB`);
    return result;
  }

  const addressHash = btoa(result.address);
  
  // Check for existing cache hit within 14 days
  const existing = await base44.asServiceRole.entities.PropertyValidationCache.list({
    filter: { addressHash: { _eq: addressHash } }
  });

  if (existing && existing.length > 0) {
    const cacheDate = new Date(existing[0].createdAt);
    const now = new Date();
    const diffDays = (now.getTime() - cacheDate.getTime()) / (1000 * 3600 * 24);
    
    if (diffDays < 14) return existing; // Valid cache hit
  }

  // Create new cache record with 14-day TTL implicit in the logic
  return await base44.asServiceRole.entities.PropertyValidationCache.create({
    address: result.address,
    addressHash: addressHash,
    status: result.status,
    isSold: result.isSold,
    rawPayload: JSON.stringify(result),
    ttlDays: 14 // Assuming custom field you added
  });
}
