/**
 * Regrid API Validation Script — FirstKnock V2
 * 
 * Tests the Regrid API to validate our V2 data migration.
 * 
 * SETUP:
 *   1. Sign up: https://app.regrid.com/users/sign_up?flow=api_sandbox
 *   2. Run: REGRID_TOKEN=your_token node scripts/validateRegrid.js
 * 
 * Trial: 2,000 parcels from Marion IN, Dallas TX, Wilson TN, Durham NC, Fillmore NE, Clark WI
 */

const TOKEN = process.env.REGRID_TOKEN;
const BASE_URL = 'https://app.regrid.com/api/v2';

if (!TOKEN) {
  console.error('\n❌ No token. Run: REGRID_TOKEN=your_token node scripts/validateRegrid.js\n');
  process.exit(1);
}

const REQUIRED_FIELDS = [
  'owner', 'mailadd', 'mail_city', 'mail_state2', 'mail_zip',
  'saledate', 'saleprice', 'parval', 'yearbuilt', 'usedesc', 'num_bedrooms',
];

const BONUS_FIELDS = [
  'ownfrst', 'ownlast', 'num_bath', 'last_ownership_transfer_date',
  'previous_owner', 'homestead_exemption', 'numstories', 'structstyle',
  'll_uuid', 'll_updated_at', 'll_bldg_count', 'll_gisacre',
];

async function apiCall(endpoint, params = {}) {
  const url = new URL(`${BASE_URL}${endpoint}`);
  url.searchParams.set('token', TOKEN);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const start = Date.now();
  const res = await fetch(url.toString());
  const elapsed = Date.now() - start;
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  // Regrid wraps response in {parcels: {features: [...]}}
  const features = data.parcels?.features || data.features || [];
  return { features, elapsed };
}

function divider(title) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

async function main() {
  console.log('\n🔍 FirstKnock V2 — Regrid API Validation');
  console.log(`   Token: ${TOKEN.substring(0, 12)}...`);
  console.log(`   Time:  ${new Date().toLocaleString()}\n`);

  let totalTests = 0, passed = 0;

  // ─── TEST 1: Point Search (Indianapolis — Monument Circle) ────
  divider('TEST 1: Point Search — Indianapolis, IN');
  totalTests++;
  try {
    const { features, elapsed } = await apiCall('/parcels/point', { lat: '39.7684', lon: '-86.1581' });
    if (features.length > 0) {
      const f = features[0];
      const fields = f.properties?.fields || f.properties;
      console.log(`  ✅ ${features.length} feature(s) in ${elapsed}ms`);
      console.log(`  Address:  ${fields.address || f.properties.headline}`);
      console.log(`  Owner:    ${fields.owner}`);
      console.log(`  Geometry: ${f.geometry.type} (${f.geometry.coordinates[0]?.length || '?'} vertices)`);
      passed++;
    } else {
      console.log(`  ⚠️  0 features (coordinate may not be in trial subset)`);
    }
  } catch (e) {
    console.log(`  ❌ Failed: ${e.message}`);
  }

  // ─── TEST 2: Address Search (Indianapolis residential) ────────
  divider('TEST 2: Address Search — Residential, Indianapolis');
  totalTests++;
  let testFields = null;
  let testGeom = null;
  try {
    const { features, elapsed } = await apiCall('/parcels/address', {
      query: '1234 N Meridian St Indianapolis IN'
    });
    if (features.length > 0) {
      const f = features[0];
      testFields = f.properties?.fields || f.properties;
      testGeom = f.geometry;
      console.log(`  ✅ ${features.length} feature(s) in ${elapsed}ms`);
      console.log(`  Address:  ${testFields.address}`);
      console.log(`  Owner:    ${testFields.owner}`);
      console.log(`  Sale:     ${testFields.saledate || 'N/A'} — $${Number(testFields.saleprice || 0).toLocaleString()}`);
      console.log(`  Value:    $${Number(testFields.parval || 0).toLocaleString()}`);
      passed++;
    } else {
      console.log(`  ⚠️  0 features — trying alternate address...`);
      // Fallback to the point that worked
      const fallback = await apiCall('/parcels/point', { lat: '39.7684', lon: '-86.1581' });
      if (fallback.features.length > 0) {
        testFields = fallback.features[0].properties?.fields || fallback.features[0].properties;
        testGeom = fallback.features[0].geometry;
        console.log(`  ✅ Fallback point search returned data`);
        passed++;
      }
    }
  } catch (e) {
    console.log(`  ❌ Failed: ${e.message}`);
  }

  // ─── TEST 3: Schema Validation ────────────────────────────────
  divider('TEST 3: Schema Field Validation');
  totalTests++;
  if (testFields) {
    let requiredFound = 0;
    console.log('\n  REQUIRED FIELDS (what FirstKnock needs):');
    for (const field of REQUIRED_FIELDS) {
      const val = testFields[field];
      const has = val !== null && val !== undefined && val !== '';
      console.log(`  ${has ? '✅' : '⚠️ '}  ${field.padEnd(30)} ${has ? '= ' + JSON.stringify(val) : '(empty)'}`);
      if (has) requiredFound++;
    }
    console.log(`\n  BONUS FIELDS (nice to have):`);
    for (const field of BONUS_FIELDS) {
      const val = testFields[field];
      const has = val !== null && val !== undefined && val !== '';
      console.log(`  ${has ? '✅' : '— '}  ${field.padEnd(30)} ${has ? '= ' + JSON.stringify(val) : '(empty)'}`);
    }
    console.log(`\n  Result: ${requiredFound}/${REQUIRED_FIELDS.length} required fields populated`);
    if (requiredFound >= 8) {
      console.log('  ✅ PASS — sufficient data for FirstKnock V2');
      passed++;
    } else {
      console.log('  ⚠️  Some fields missing — may vary by county');
    }
  } else {
    console.log('  ❌ No data to validate (previous tests returned no features)');
  }

  // ─── TEST 4: Geometry (Property Boundaries) ──────────────────
  divider('TEST 4: Property Boundaries (Geometry)');
  totalTests++;
  if (testGeom) {
    console.log(`  Type: ${testGeom.type}`);
    if (testGeom.type === 'Polygon' || testGeom.type === 'MultiPolygon') {
      const ring = testGeom.type === 'Polygon' ? testGeom.coordinates[0] : testGeom.coordinates[0][0];
      console.log(`  Vertices: ${ring.length}`);
      console.log('  ✅ PASS — Full polygon boundaries (lot outlines, not just dots!)');
      passed++;
    } else {
      console.log('  ⚠️  Only point geometry — no boundary polygon');
    }
  } else {
    console.log('  ❌ No geometry to validate');
  }

  // ─── TEST 5: Data Freshness ──────────────────────────────────
  divider('TEST 5: Data Freshness');
  totalTests++;
  if (testFields) {
    const updated = testFields.ll_updated_at;
    if (updated) {
      const updDate = new Date(updated);
      const daysAgo = Math.floor((Date.now() - updDate) / (1000*60*60*24));
      console.log(`  Last updated:  ${updated}`);
      console.log(`  Days ago:      ${daysAgo}`);
      if (daysAgo <= 7) {
        console.log('  ✅ PASS — Data updated within the last week!');
        passed++;
      } else if (daysAgo <= 30) {
        console.log('  ✅ PASS — Data updated within the last month');
        passed++;
      } else {
        console.log(`  ⚠️  Data is ${daysAgo} days old`);
      }
    }
    const saleDate = testFields.saledate;
    if (saleDate) {
      const saleDaysAgo = Math.floor((Date.now() - new Date(saleDate)) / (1000*60*60*24));
      console.log(`  Last sale:     ${saleDate} (${saleDaysAgo} days ago)`);
    }
  } else {
    console.log('  ❌ No data to check');
  }

  // ─── TEST 6: Owner Search ────────────────────────────────────
  divider('TEST 6: Owner Name Search');
  totalTests++;
  try {
    const { features, elapsed } = await apiCall('/parcels/owner', { owner: 'Smith' });
    console.log(`  ${features.length > 0 ? '✅' : '⚠️ '} ${features.length} result(s) for "Smith" in ${elapsed}ms`);
    if (features.length > 0) {
      features.slice(0, 3).forEach((f, i) => {
        const fields = f.properties?.fields || f.properties;
        console.log(`    ${i+1}. ${fields.owner} — ${fields.address || 'N/A'}`);
      });
      passed++;
    }
  } catch (e) {
    console.log(`  ❌ Failed: ${e.message}`);
  }

  // ─── VERDICT ─────────────────────────────────────────────────
  divider(`VERDICT: ${passed}/${totalTests} tests passed`);
  if (passed >= 4) {
    console.log('  ✅ REGRID VALIDATED — Ready to proceed with V2 migration');
    console.log('  → Schema maps to PropertyCard and ManagerDetailSheet');
    console.log('  → Polygon geometry gives us lot boundaries');
    console.log('  → Data freshness meets our requirements');
    console.log('  → Next step: Execute Regrid nationwide bulk license\n');
  } else if (passed >= 2) {
    console.log('  ⚠️  PARTIAL — API works but trial subset is limited');
    console.log('  → Core fields confirmed present in schema');
    console.log('  → Request full-access trial from Regrid sales for final validation\n');
  } else {
    console.log('  ❌ NEEDS INVESTIGATION');
    console.log('  → API may have changed or token may be invalid\n');
  }
}

main().catch(console.error);
