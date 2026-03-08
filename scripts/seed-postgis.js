#!/usr/bin/env node
/**
 * FirstKnock V2 — PostGIS Seed Script
 *
 * Loads tricounty_sold_properties_cleaned.json into the local PostGIS
 * container so Martin can serve vector tiles and MapLibre can render them.
 *
 * Prerequisites:
 *   docker compose up -d           (starts postgis + martin)
 *   npm install pg                 (if not already installed)
 *
 * Usage:
 *   node scripts/seed-postgis.js                   # seed from default JSON
 *   node scripts/seed-postgis.js --file=./my.json  # seed from a custom file
 *   node scripts/seed-postgis.js --limit=500       # seed only first N records
 *   node scripts/seed-postgis.js --clear           # wipe the table first
 *
 * Environment (optional — defaults work with docker-compose.yml):
 *   PGHOST     default: localhost
 *   PGPORT     default: 5432
 *   PGUSER     default: postgres
 *   PGPASSWORD default: password
 *   PGDATABASE default: firstknock_local
 */

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2).reduce((acc, arg) => {
  const [k, v] = arg.replace(/^--/, '').split('=');
  acc[k] = v ?? true;
  return acc;
}, {});

const DATA_FILE = args.file
  ? path.resolve(args.file)
  : path.resolve(__dirname, '../tricounty_sold_properties_cleaned.json');

const LIMIT   = args.limit ? parseInt(args.limit) : null;
const CLEAR   = !!args.clear;
const BATCH   = 500; // rows per INSERT statement

// ── DB connection ─────────────────────────────────────────────────────────────
const client = new Client({
  host:     process.env.PGHOST     || 'localhost',
  port:     parseInt(process.env.PGPORT || '5432'),
  user:     process.env.PGUSER     || 'postgres',
  password: process.env.PGPASSWORD || 'password',
  database: process.env.PGDATABASE || 'firstknock_local',
});

// ── Field mapping: JSON key → DB column ──────────────────────────────────────
function mapRecord(raw) {
  const lat = parseFloat(raw['LATITUDE']  || raw['Geocodio Latitude']  || raw['lat']  || 0);
  const lng = parseFloat(raw['LONGITUDE'] || raw['Geocodio Longitude'] || raw['lng']  || 0);

  // Skip records without usable coordinates
  if (!lat || !lng || Math.abs(lat) < 0.0001 || Math.abs(lng) < 0.0001) return null;

  return {
    sale_type:            (raw['SALE TYPE'] || '').trim()               || null,
    sold_date:            parseSoldDate(raw['SOLD DATE'])               || null,
    property_type:        (raw['PROPERTY TYPE'] || '').trim()           || null,
    address:              (raw['ADDRESS'] || '').trim()                 || null,
    city:                 (raw['CITY'] || '').trim()                    || null,
    state_or_province:    (raw['STATE OR PROVINCE'] || '').trim()       || null,
    zip_or_postal_code:   String(raw['ZIP OR POSTAL CODE'] || '').trim() || null,
    price:                parseNum(raw['PRICE'])                        || null,
    beds:                 parseNum(raw['BEDS'])                         || null,
    baths:                parseNum(raw['BATHS'])                        || null,
    location:             (raw['LOCATION'] || '').trim()                || null,
    square_feet:          parseNum(raw['SQUARE FEET'])                  || null,
    lot_size:             parseNum(raw['LOT SIZE'])                     || null,
    year_built:           parseNum(raw['YEAR BUILT'])                   || null,
    days_on_market:       parseNum(raw['DAYS ON MARKET'])               || null,
    price_per_square_foot:parseNum(raw['$/SQUARE FEET'])                || null,
    hoa_per_month:        parseNum(raw['HOA/MONTH'])                    || null,
    status:               (raw['STATUS'] || '').trim()                  || null,
    url:                  (raw['URL (SEE https://www.redfin.com/buy-a-home/comparative-market-analysis FOR INFO ON PRICING)'] || raw['Redfin Link'] || '').trim() || null,
    source:               (raw['SOURCE'] || raw['County_Source'] || '').trim() || null,
    mls_number:           String(raw['MLS#'] || '').trim()              || null,
    latitude:             lat,
    longitude:            lng,
  };
}

function parseNum(val) {
  if (val === '' || val === null || val === undefined) return null;
  const n = parseFloat(String(val).replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

function parseSoldDate(val) {
  if (!val) return null;
  // Handles formats: "2025-12-31", "June-7-2023", "2023-06-07"
  const cleaned = String(val).trim();
  if (!cleaned) return null;
  const d = new Date(cleaned);
  return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 FirstKnock V2 — PostGIS Seed Script');
  console.log(`📂 Data file : ${DATA_FILE}`);

  if (!fs.existsSync(DATA_FILE)) {
    console.error(`❌ File not found: ${DATA_FILE}`);
    process.exit(1);
  }

  // Parse data
  console.log('📖 Parsing JSON...');
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const allRecords = Array.isArray(raw) ? raw : [raw];

  let records = allRecords
    .map(mapRecord)
    .filter(Boolean);

  console.log(`✅ Valid records with coordinates: ${records.length} / ${allRecords.length}`);

  if (LIMIT) {
    records = records.slice(0, LIMIT);
    console.log(`✂️  Limiting to first ${LIMIT} records`);
  }

  // Connect
  console.log('\n🔗 Connecting to PostGIS...');
  try {
    await client.connect();
    console.log('✅ Connected to PostgreSQL');
  } catch (err) {
    console.error('❌ Connection failed:', err.message);
    console.error('   Is docker compose up -d running?');
    process.exit(1);
  }

  // Ensure PostGIS extension + table exist
  await client.query('CREATE EXTENSION IF NOT EXISTS postgis;');

  // Optional wipe
  if (CLEAR) {
    console.log('🗑️  Clearing existing rows...');
    await client.query('TRUNCATE TABLE properties RESTART IDENTITY;');
  }

  // Bulk insert in batches
  console.log(`\n⏳ Inserting ${records.length} records in batches of ${BATCH}...`);
  let inserted = 0;
  let skipped  = 0;

  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    const values = [];
    const params = [];
    let pIdx = 1;

    for (const r of batch) {
      values.push(`(
        $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++},
        $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++},
        $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++},
        $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++},
        $${pIdx++}, $${pIdx++}, $${pIdx++},
        ST_SetSRID(ST_MakePoint($${pIdx++}, $${pIdx++}), 4326)
      )`);
      params.push(
        r.sale_type, r.sold_date, r.property_type, r.address, r.city,
        r.state_or_province, r.zip_or_postal_code, r.price, r.beds, r.baths,
        r.location, r.square_feet, r.lot_size, r.year_built, r.days_on_market,
        r.price_per_square_foot, r.hoa_per_month, r.status, r.url, r.source,
        r.mls_number, r.latitude, r.longitude,
        r.longitude, r.latitude  // ST_MakePoint(lng, lat)
      );
    }

    const sql = `
      INSERT INTO properties (
        sale_type, sold_date, property_type, address, city,
        state_or_province, zip_or_postal_code, price, beds, baths,
        location, square_feet, lot_size, year_built, days_on_market,
        price_per_square_foot, hoa_per_month, status, url, source,
        mls_number, latitude, longitude, geom
      ) VALUES ${values.join(', ')}
      ON CONFLICT DO NOTHING;
    `;

    try {
      const res = await client.query(sql, params);
      inserted += res.rowCount;
    } catch (err) {
      console.warn(`  ⚠️  Batch ${Math.floor(i / BATCH) + 1} partial error: ${err.message}`);
      skipped += batch.length;
    }

    // Progress bar
    const pct = Math.round(((i + batch.length) / records.length) * 100);
    process.stdout.write(`  Progress: ${pct}% (${Math.min(i + batch.length, records.length)}/${records.length})\r`);
  }

  console.log('\n');

  // Final count
  const { rows } = await client.query('SELECT COUNT(*) AS total FROM properties WHERE geom IS NOT NULL;');
  const total = parseInt(rows[0].total);

  console.log('─────────────────────────────────────');
  console.log(`✅ Inserted  : ${inserted} rows`);
  console.log(`⚠️  Skipped   : ${skipped} rows`);
  console.log(`📍 Total in DB (with geom): ${total}`);
  console.log('─────────────────────────────────────');

  // Quick spatial sanity check
  const bbox = await client.query(`
    SELECT
      MIN(ST_Y(geom)) AS min_lat, MAX(ST_Y(geom)) AS max_lat,
      MIN(ST_X(geom)) AS min_lng, MAX(ST_X(geom)) AS max_lng
    FROM properties WHERE geom IS NOT NULL;
  `);
  const b = bbox.rows[0];
  console.log(`🌍 Bounding box:`);
  console.log(`   Lat: ${parseFloat(b.min_lat).toFixed(4)} → ${parseFloat(b.max_lat).toFixed(4)}`);
  console.log(`   Lng: ${parseFloat(b.min_lng).toFixed(4)} → ${parseFloat(b.max_lng).toFixed(4)}`);

  // Verify Martin catalog (informational)
  console.log('\n🗺️  Martin tile endpoints to test in browser:');
  console.log('   Table source  : http://localhost:3000/public.properties');
  console.log('   Function source: http://localhost:3000/public.properties_mvt');
  console.log('   Full catalog  : http://localhost:3000/catalog');
  console.log('\n   Sample tile (zoom 10, tile 0/0/0):');
  console.log('   http://localhost:3000/public.properties_mvt/10/234/390');
  console.log('\n   Dynamic filter example:');
  console.log('   http://localhost:3000/public.properties_mvt/{z}/{x}/{y}?min_price=200000&max_price=400000');

  await client.end();
  console.log('\n🎉 Seed complete! Run: docker compose up -d && npm run dev');
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  process.exit(1);
});
