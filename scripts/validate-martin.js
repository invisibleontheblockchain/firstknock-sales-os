#!/usr/bin/env node
/**
 * FirstKnock V2 — Martin + PostGIS Validation Script
 *
 * Checks that all V2 backend services are running correctly before
 * you start the frontend.
 *
 * Usage:
 *   npm run validate
 *   node scripts/validate-martin.js
 */

const http  = require('http');
const { Client } = require('pg');

const MARTIN_URL = process.env.MARTIN_URL || 'http://localhost:3000';
const PG_CONFIG  = {
  host:     process.env.PGHOST     || 'localhost',
  port:     parseInt(process.env.PGPORT || '5432'),
  user:     process.env.PGUSER     || 'postgres',
  password: process.env.PGPASSWORD || 'password',
  database: process.env.PGDATABASE || 'firstknock_local',
};

const PASS = '✅';
const FAIL = '❌';
const WARN = '⚠️ ';

let allPassed = true;

function check(label, passed, detail = '') {
  const icon = passed ? PASS : FAIL;
  if (!passed) allPassed = false;
  console.log(`  ${icon}  ${label}${detail ? '  — ' + detail : ''}`);
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body }); }
      });
    }).on('error', reject);
  });
}

async function validatePostGIS(client) {
  console.log('\n📦 PostGIS Database');

  // Extension
  const ext = await client.query("SELECT extname FROM pg_extension WHERE extname='postgis';");
  check('PostGIS extension enabled', ext.rows.length > 0);

  // Table
  const tbl = await client.query(`
    SELECT COUNT(*) AS cnt FROM information_schema.tables
    WHERE table_schema='public' AND table_name='properties';
  `);
  check('properties table exists', parseInt(tbl.rows[0].cnt) > 0);

  // Row count
  const rows = await client.query('SELECT COUNT(*) AS cnt FROM properties WHERE geom IS NOT NULL;');
  const cnt = parseInt(rows[0]?.cnt ?? 0);
  check(`${cnt} rows with geometry`, cnt > 0, cnt === 0 ? 'Run: npm run seed' : '');

  // GiST index
  const idx = await client.query(`
    SELECT indexname FROM pg_indexes
    WHERE tablename='properties' AND indexdef ILIKE '%gist%';
  `);
  check(`${idx.rows.length} spatial GiST index(es)`, idx.rows.length > 0);

  // Function source
  const fn = await client.query(`
    SELECT proname FROM pg_proc
    WHERE proname='properties_mvt' AND prokind='f';
  `);
  check('properties_mvt function exists', fn.rows.length > 0,
    fn.rows.length === 0 ? 'Re-run: docker compose down -v && docker compose up -d' : '');

  // PARALLEL SAFE
  if (fn.rows.length > 0) {
    const safe = await client.query(`
      SELECT proparallel FROM pg_proc WHERE proname='properties_mvt';
    `);
    check('properties_mvt is PARALLEL SAFE', safe.rows[0]?.proparallel === 's');
  }

  // Bounding box
  if (cnt > 0) {
    const bbox = await client.query(`
      SELECT
        ROUND(MIN(ST_Y(geom))::numeric, 3) min_lat,
        ROUND(MAX(ST_Y(geom))::numeric, 3) max_lat,
        ROUND(MIN(ST_X(geom))::numeric, 3) min_lng,
        ROUND(MAX(ST_X(geom))::numeric, 3) max_lng
      FROM properties WHERE geom IS NOT NULL;
    `);
    const b = bbox.rows[0];
    console.log(`  ℹ️   Bounding box: lat [${b.min_lat} → ${b.max_lat}]  lng [${b.min_lng} → ${b.max_lng}]`);
  }
}

async function validateMartin() {
  console.log('\n🗺️  Martin Tile Server');

  // Health check
  try {
    const health = await fetchJSON(`${MARTIN_URL}/health`);
    check('Martin is reachable', health.status === 200);
  } catch {
    check('Martin is reachable', false, `Cannot connect to ${MARTIN_URL} — is docker compose up -d running?`);
    return;
  }

  // Catalog
  try {
    const catalog = await fetchJSON(`${MARTIN_URL}/catalog`);
    check('Catalog endpoint returns JSON', typeof catalog.body === 'object');

    const sources = Object.keys(catalog.body?.tiles ?? {});
    check(`${sources.length} tile source(s) discovered`, sources.length > 0,
      sources.length === 0 ? 'Ensure PostGIS has at least one row' : sources.join(', '));

    const hasTable = sources.some(s => s.includes('properties'));
    check('public.properties table source visible', hasTable);

    const hasFn = sources.some(s => s.includes('properties_mvt'));
    check('properties_mvt function source visible', hasFn,
      hasFn ? '' : 'Check 01-schema.sql was applied (docker compose down -v && up -d)');
  } catch (e) {
    check('Catalog endpoint', false, e.message);
  }
}

async function main() {
  console.log('════════════════════════════════════════');
  console.log('  FirstKnock V2 — Backend Validation');
  console.log('════════════════════════════════════════');

  // PostGIS
  const client = new Client(PG_CONFIG);
  try {
    await client.connect();
    await validatePostGIS(client);
    await client.end();
  } catch (err) {
    check('Connect to PostgreSQL', false, err.message + ' — run: docker compose up -d');
  }

  // Martin
  await validateMartin();

  // Summary
  console.log('\n════════════════════════════════════════');
  if (allPassed) {
    console.log('🎉  All checks passed! Start the app:');
    console.log('    npm run dev');
    console.log('\n   Then open http://localhost:5173 and');
    console.log('   zoom to the Tri-County SC area to see tiles.');
  } else {
    console.log('⚠️   Some checks failed — review above.');
    console.log('    Common fix: docker compose down -v && docker compose up -d');
    console.log('    Then re-seed: npm run seed');
  }
  console.log('════════════════════════════════════════');
  process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
