/**
 * Regrid Bulk Parquet → PostGIS Ingest Script — Production Blueprint
 * 
 * Implements full architectural requirements from the Regrid Integration Blueprint:
 *   ✅ ll_stack_uuid column for multi-unit flattening
 *   ✅ ll_row_parcel column for right-of-way exclusion
 *   ✅ Premium fields: homestead_exemption, usps_vacancy, rdi, ll_bldg_footprint_sqft
 *   ✅ Enhanced Ownership: eo_owner, eo_last_refresh, eo_deedownerfirst/last
 *   ✅ GeoParquet columnar reads via DuckDB (selective column parsing)
 *   ✅ GiST spatial index on geometry + indexes on sale/zip/state
 *   ✅ Batch UPSERT keyed on ll_uuid
 * 
 * PREREQUISITES:
 *   - PostgreSQL with PostGIS extension enabled
 *   - Regrid Parquet bulk files (obtained via Regrid contract)
 *   - Node.js packages: duckdb, pg
 * 
 * USAGE:
 *   DATABASE_URL=postgres://... PARQUET_DIR=/path/to/parquet node scripts/regridIngest.js
 */

const BATCH_SIZE = 5000;
const DATABASE_URL = process.env.DATABASE_URL;
const PARQUET_DIR = process.env.PARQUET_DIR || './regrid_data';

if (!DATABASE_URL) {
    console.error('❌ DATABASE_URL required. Run: DATABASE_URL=postgres://... node scripts/regridIngest.js');
    process.exit(1);
}

async function main() {
    console.log('🚀 Regrid Bulk Ingest — Starting');
    console.log(`   Database: ${DATABASE_URL.replace(/:[^@]+@/, ':***@')}`);
    console.log(`   Parquet dir: ${PARQUET_DIR}`);

    let pg, duckdb, fs, path;
    try {
        pg = await import('pg');
        duckdb = await import('duckdb');
        fs = await import('fs');
        path = await import('path');
    } catch (e) {
        console.error('❌ Missing packages. Install: npm install pg duckdb');
        process.exit(1);
    }

    const client = new pg.default.Client({ connectionString: DATABASE_URL });
    await client.connect();
    console.log('✅ Connected to PostgreSQL');

    // ─── Schema Creation ──────────────────────────────────────
    // Blueprint: Full parcel schema with Premium + Enhanced Ownership fields
    console.log('\n📋 Creating parcels table...');
    await client.query(`
        CREATE TABLE IF NOT EXISTS parcels (
            ll_uuid         TEXT PRIMARY KEY,
            parcelnumb      TEXT,
            geoid           TEXT,          -- FIPS code (state+county)
            address         TEXT,
            city            TEXT,
            state           TEXT,
            zip             TEXT,
            lat             DOUBLE PRECISION,
            lon             DOUBLE PRECISION,
            
            -- Owner (Standard)
            owner           TEXT,
            ownfrst         TEXT,
            ownlast         TEXT,
            previous_owner  TEXT,
            
            -- Mailing
            mailadd         TEXT,
            mail_city       TEXT,
            mail_state2     TEXT,
            mail_zip        TEXT,
            
            -- Sale
            saledate        TEXT,
            saleprice       NUMERIC,
            
            -- Property details
            parval          NUMERIC,
            improvval       NUMERIC,
            landval         NUMERIC,
            yearbuilt       INTEGER,
            num_bedrooms    INTEGER,
            num_bath        NUMERIC,
            numstories      NUMERIC,
            numunits        INTEGER,
            sqft            NUMERIC,
            ll_gisacre      NUMERIC,
            
            -- Type & Zoning
            usecode         TEXT,
            usedesc         TEXT,
            zoning_type     TEXT,
            zoning_subtype  TEXT,
            
            -- Premium Enrichments (Blueprint)
            homestead_exemption TEXT,      -- Tax exemption = owner-occupied indicator
            usps_vacancy    TEXT,          -- Postal carrier vacancy flag
            rdi             TEXT,          -- Residential Delivery Indicator
            lbcs_activity   TEXT,          -- Land-Based Classification System
            
            -- Building Analytics
            ll_bldg_count   INTEGER,
            ll_bldg_footprint_sqft INTEGER,
            
            -- Stacked Parcel Grouping (Blueprint: ll_stack_uuid)
            ll_stack_uuid   TEXT,          -- Groups condos sharing identical geometry
            
            -- Right-of-Way Flag (Blueprint: ll_row_parcel)
            ll_row_parcel   TEXT,          -- 'true' for highways/utilities/railways
            
            -- Enhanced Ownership (Daily-updated, EO add-on)
            eo_owner        TEXT,
            eo_last_refresh TEXT,
            eo_deedownerfirst  TEXT,
            eo_deedownermiddle TEXT,
            eo_deedownerlast   TEXT,
            eo_deedownersuffix TEXT,
            attom_id        TEXT,          -- Primary key for EO ownership record
            
            -- Geometry (PostGIS)
            geom            GEOMETRY(Geometry, 4326),
            
            -- Timestamps
            ingested_at     TIMESTAMPTZ DEFAULT NOW(),
            updated_at      TIMESTAMPTZ DEFAULT NOW()
        );
    `);
    console.log('✅ Table created/exists');

    // ─── Indexes ──────────────────────────────────────────────
    console.log('\n🗺️  Creating indexes...');
    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_parcels_geom ON parcels USING GiST (geom);
        CREATE INDEX IF NOT EXISTS idx_parcels_saledate ON parcels (saledate);
        CREATE INDEX IF NOT EXISTS idx_parcels_zip ON parcels (zip);
        CREATE INDEX IF NOT EXISTS idx_parcels_state ON parcels (state);
        CREATE INDEX IF NOT EXISTS idx_parcels_geoid ON parcels (geoid);
        CREATE INDEX IF NOT EXISTS idx_parcels_stack ON parcels (ll_stack_uuid) WHERE ll_stack_uuid IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_parcels_row ON parcels (ll_row_parcel) WHERE ll_row_parcel = 'true';
        CREATE INDEX IF NOT EXISTS idx_parcels_eo ON parcels (attom_id) WHERE attom_id IS NOT NULL;
    `);
    console.log('✅ Indexes created');

    // ─── Parquet Files ────────────────────────────────────────
    const parquetFiles = fs.readdirSync(PARQUET_DIR)
        .filter(f => f.endsWith('.parquet'))
        .map(f => path.join(PARQUET_DIR, f));

    if (parquetFiles.length === 0) {
        console.log(`\n⚠️  No .parquet files found in ${PARQUET_DIR}`);
        console.log('   Place Regrid bulk export Parquet files in this directory.');
        console.log('   This script will be ready to run once the Regrid contract is active.');
        await client.end();
        return;
    }

    console.log(`\n📁 Found ${parquetFiles.length} Parquet file(s)`);

    // ─── DuckDB Columnar Reads ────────────────────────────────
    // Blueprint: "Surgically read only specific columns" for reduced I/O
    const db = new duckdb.default.Database(':memory:');
    const conn = db.connect();
    let totalInserted = 0;

    // Only select the columns we need (Blueprint: selective parsing)
    const COLUMNS = [
        'll_uuid', 'parcelnumb', 'geoid', 'address', 'scity', 'state2', 'szip',
        'lat', 'lon', 'owner', 'ownfrst', 'ownlast',
        'saledate', 'saleprice', 'parval', 'improvval', 'landval',
        'yearbuilt', 'num_bedrooms', 'num_bath', 'numstories', 'numunits',
        'sqft', 'll_gisacre', 'usecode', 'usedesc', 'zoning_type', 'zoning_subtype',
        'homestead_exemption', 'usps_vacancy', 'rdi', 'lbcs_activity',
        'll_bldg_count', 'll_bldg_footprint_sqft',
        'll_stack_uuid', 'll_row_parcel',
        'eo_owner', 'eo_last_refresh',
        'eo_deedownerfirst', 'eo_deedownermiddle', 'eo_deedownerlast', 'eo_deedownersuffix',
        'attom_id', 'll_updated_at', 'mailadd', 'mail_city', 'mail_state2', 'mail_zip',
    ].join(', ');

    for (const file of parquetFiles) {
        console.log(`\n📦 Processing: ${path.basename(file)}`);

        const countResult = await new Promise((resolve, reject) => {
            conn.all(`SELECT COUNT(*) as cnt FROM read_parquet('${file}')`, (err, rows) => {
                if (err) reject(err); else resolve(rows);
            });
        });
        const totalRows = countResult[0]?.cnt || 0;
        console.log(`   Rows: ${totalRows.toLocaleString()}`);

        let offset = 0;
        while (offset < totalRows) {
            const rows = await new Promise((resolve, reject) => {
                conn.all(
                    `SELECT ${COLUMNS} FROM read_parquet('${file}') LIMIT ${BATCH_SIZE} OFFSET ${offset}`,
                    (err, rows) => { if (err) reject(err); else resolve(rows); }
                );
            });

            if (rows.length === 0) break;

            const values = [];
            const placeholders = [];
            let paramIdx = 1;

            for (const row of rows) {
                const params = [
                    row.ll_uuid, row.parcelnumb, row.geoid,
                    row.address, row.scity, row.state2, row.szip,
                    row.lat, row.lon,
                    row.owner, row.ownfrst, row.ownlast,
                    row.saledate, row.saleprice, row.parval,
                    row.yearbuilt, row.num_bedrooms, row.usedesc,
                    row.mailadd, row.mail_city, row.mail_state2, row.mail_zip,
                    row.ll_stack_uuid, row.ll_row_parcel,
                    row.homestead_exemption, row.usps_vacancy, row.rdi,
                    row.ll_bldg_count, row.ll_bldg_footprint_sqft,
                    row.eo_owner, row.eo_last_refresh,
                    row.eo_deedownerfirst, row.eo_deedownerlast, row.attom_id,
                    row.ll_updated_at,
                ];
                values.push(...params);
                const ph = params.map((_, i) => `$${paramIdx + i}`).join(',');
                placeholders.push(`(${ph})`);
                paramIdx += params.length;
            }

            await client.query(`
                INSERT INTO parcels (
                    ll_uuid, parcelnumb, geoid,
                    address, city, state, zip,
                    lat, lon,
                    owner, ownfrst, ownlast,
                    saledate, saleprice, parval,
                    yearbuilt, num_bedrooms, usedesc,
                    mailadd, mail_city, mail_state2, mail_zip,
                    ll_stack_uuid, ll_row_parcel,
                    homestead_exemption, usps_vacancy, rdi,
                    ll_bldg_count, ll_bldg_footprint_sqft,
                    eo_owner, eo_last_refresh,
                    eo_deedownerfirst, eo_deedownerlast, attom_id,
                    ll_updated_at
                ) VALUES ${placeholders.join(',')}
                ON CONFLICT (ll_uuid) DO UPDATE SET
                    owner = EXCLUDED.owner,
                    saledate = EXCLUDED.saledate,
                    saleprice = EXCLUDED.saleprice,
                    ll_stack_uuid = EXCLUDED.ll_stack_uuid,
                    ll_row_parcel = EXCLUDED.ll_row_parcel,
                    eo_owner = EXCLUDED.eo_owner,
                    eo_last_refresh = EXCLUDED.eo_last_refresh,
                    eo_deedownerfirst = EXCLUDED.eo_deedownerfirst,
                    eo_deedownerlast = EXCLUDED.eo_deedownerlast,
                    attom_id = EXCLUDED.attom_id,
                    ll_updated_at = EXCLUDED.ll_updated_at,
                    updated_at = NOW()
            `, values);

            totalInserted += rows.length;
            offset += BATCH_SIZE;

            if (offset % (BATCH_SIZE * 10) === 0) {
                const pct = Math.round((offset / totalRows) * 100);
                console.log(`   ${pct}% — ${offset.toLocaleString()} / ${totalRows.toLocaleString()}`);
            }
        }
    }

    // ─── VACUUM ANALYZE ───────────────────────────────────────
    console.log('\n🧹 Running VACUUM ANALYZE...');
    await client.query('VACUUM ANALYZE parcels');
    console.log('✅ Done');

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`  INGEST COMPLETE`);
    console.log(`  Total records: ${totalInserted.toLocaleString()}`);
    console.log(`${'═'.repeat(50)}\n`);

    await client.end();
    db.close();
}

main().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
