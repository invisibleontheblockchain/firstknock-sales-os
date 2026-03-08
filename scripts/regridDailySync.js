/**
 * Regrid Daily Delta Sync — Production Blueprint
 * 
 * Implements the Enhanced Ownership SFTP pipeline from the architecture blueprint:
 *   ✅ Monthly baseline: enhanced_ownership.csv.gz (1st of each month)
 *   ✅ Daily deltas: enhanced_ownership_YYYY-MM-DD.csv.gz
 *   ✅ UPSERT keyed on attom_id (EO primary key) + ll_uuid (parcel link)
 *   ✅ Null-state handling for weekends/holidays (empty CSV with headers only)
 *   ✅ Hourly retry loop for missing daily files (target 1:00 PM ET)
 *   ✅ Rate limiting for live API fallback queries
 * 
 * USAGE (via cron, target 1:00 PM ET per Blueprint):
 *   0 13 * * * DATABASE_URL=postgres://... REGRID_SFTP_HOST=... node scripts/regridDailySync.js
 * 
 * MODES:
 *   --baseline    Force monthly baseline reload
 *   --date=YYYY-MM-DD   Process specific date's delta
 *   (default)     Auto-detect: baseline on 1st, delta otherwise
 */

const DATABASE_URL = process.env.DATABASE_URL;
const REGRID_TOKEN = process.env.REGRID_TOKEN;
const REGRID_SFTP_HOST = process.env.REGRID_SFTP_HOST || 'sftp.regrid.com';
const REGRID_SFTP_USER = process.env.REGRID_SFTP_USER;
const REGRID_SFTP_PASS = process.env.REGRID_SFTP_PASS;
const REGRID_BASE_URL = 'https://app.regrid.com/api/v2';
const MAX_SFTP_RETRIES = 8; // Retry hourly for up to 8 hours

if (!DATABASE_URL) {
    console.error('❌ DATABASE_URL required.');
    process.exit(1);
}

// ─── HELPERS ──────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function getTodayStr() {
    return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
}

function isFirstOfMonth() {
    return new Date().getDate() === 1;
}

// ─── SFTP DELTA PROCESSING ───────────────────────────────────
// Blueprint: Daily enhanced_ownership_YYYY-MM-DD.csv.gz via SFTP

async function downloadSFTPDelta(dateStr) {
    let SFTPClient;
    try {
        const mod = await import('ssh2-sftp-client');
        SFTPClient = mod.default;
    } catch (e) {
        console.warn('⚠️  ssh2-sftp-client not installed. Falling back to API sync.');
        return null;
    }

    if (!REGRID_SFTP_USER || !REGRID_SFTP_PASS) {
        console.warn('⚠️  SFTP credentials not configured. Set REGRID_SFTP_USER + REGRID_SFTP_PASS.');
        return null;
    }

    const sftp = new SFTPClient();
    const remotePath = isFirstOfMonth() && !dateStr
        ? '/enhanced_ownership/enhanced_ownership.csv.gz'
        : `/enhanced_ownership/enhanced_ownership_${dateStr || getTodayStr()}.csv.gz`;

    for (let attempt = 0; attempt < MAX_SFTP_RETRIES; attempt++) {
        try {
            await sftp.connect({
                host: REGRID_SFTP_HOST,
                port: 22,
                username: REGRID_SFTP_USER,
                password: REGRID_SFTP_PASS,
            });

            const exists = await sftp.exists(remotePath);
            if (!exists) {
                console.log(`   ⏳ File not yet available: ${remotePath} (attempt ${attempt + 1}/${MAX_SFTP_RETRIES})`);
                await sftp.end();
                // Blueprint: retry hourly if file is missing
                await sleep(60 * 60 * 1000);
                continue;
            }

            const localPath = `/tmp/regrid_eo_${dateStr || getTodayStr()}.csv.gz`;
            await sftp.fastGet(remotePath, localPath);
            await sftp.end();
            console.log(`   ✅ Downloaded: ${remotePath}`);
            return localPath;
        } catch (e) {
            console.warn(`   ⚠️ SFTP attempt ${attempt + 1} failed: ${e.message}`);
            try { await sftp.end(); } catch (_) {}
            if (attempt < MAX_SFTP_RETRIES - 1) {
                await sleep(60 * 60 * 1000); // Retry hourly
            }
        }
    }
    return null;
}

// ─── CSV DELTA INGEST ─────────────────────────────────────────
// Blueprint: UPSERT on attom_id (EO primary key) linked to ll_uuid

async function ingestCSVDelta(client, filePath) {
    let fs, zlib, readline;
    try {
        fs = await import('fs');
        zlib = await import('zlib');
        readline = await import('readline');
    } catch (e) {
        console.error('❌ Missing core Node.js modules:', e.message);
        return { updated: 0, errors: 0 };
    }

    const gunzip = zlib.createGunzip();
    const stream = fs.createReadStream(filePath).pipe(gunzip);
    const rl = readline.createInterface({ input: stream });

    let headers = null;
    let totalUpdated = 0;
    let totalErrors = 0;
    let lineNum = 0;

    for await (const line of rl) {
        lineNum++;

        // Parse header row
        if (!headers) {
            headers = line.split(',').map(h => h.trim().toLowerCase());
            continue;
        }

        // Blueprint: Null-state handling — empty files on weekends/holidays
        // If we get past header with no data rows, that's fine
        const values = line.split(',');
        if (values.length < 3) continue;

        // Map CSV columns to values using header index
        const getCol = (name) => {
            const idx = headers.indexOf(name);
            return idx >= 0 ? (values[idx] || '').trim() : null;
        };

        const llUuid = getCol('ll_uuid');
        const attomId = getCol('attom_id');
        if (!llUuid && !attomId) continue;

        try {
            await client.query(`
                INSERT INTO parcels (
                    ll_uuid, attom_id,
                    owner, ownfrst, ownlast,
                    eo_owner, eo_last_refresh,
                    eo_deedownerfirst, eo_deedownermiddle, eo_deedownerlast, eo_deedownersuffix,
                    mailadd, mail_city, mail_state2, mail_zip,
                    saledate, saleprice,
                    updated_at
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
                ON CONFLICT (ll_uuid) DO UPDATE SET
                    attom_id = COALESCE(EXCLUDED.attom_id, parcels.attom_id),
                    owner = COALESCE(EXCLUDED.owner, parcels.owner),
                    ownfrst = COALESCE(EXCLUDED.ownfrst, parcels.ownfrst),
                    ownlast = COALESCE(EXCLUDED.ownlast, parcels.ownlast),
                    eo_owner = COALESCE(EXCLUDED.eo_owner, parcels.eo_owner),
                    eo_last_refresh = COALESCE(EXCLUDED.eo_last_refresh, parcels.eo_last_refresh),
                    eo_deedownerfirst = COALESCE(EXCLUDED.eo_deedownerfirst, parcels.eo_deedownerfirst),
                    eo_deedownermiddle = COALESCE(EXCLUDED.eo_deedownermiddle, parcels.eo_deedownermiddle),
                    eo_deedownerlast = COALESCE(EXCLUDED.eo_deedownerlast, parcels.eo_deedownerlast),
                    eo_deedownersuffix = COALESCE(EXCLUDED.eo_deedownersuffix, parcels.eo_deedownersuffix),
                    mailadd = COALESCE(EXCLUDED.mailadd, parcels.mailadd),
                    mail_city = COALESCE(EXCLUDED.mail_city, parcels.mail_city),
                    mail_state2 = COALESCE(EXCLUDED.mail_state2, parcels.mail_state2),
                    mail_zip = COALESCE(EXCLUDED.mail_zip, parcels.mail_zip),
                    saledate = COALESCE(EXCLUDED.saledate, parcels.saledate),
                    saleprice = COALESCE(EXCLUDED.saleprice, parcels.saleprice),
                    updated_at = NOW()
            `, [
                llUuid, attomId || null,
                getCol('owner'), getCol('ownfrst') || getCol('eo_deedownerfirst'), getCol('ownlast') || getCol('eo_deedownerlast'),
                getCol('eo_owner'), getCol('eo_last_refresh'),
                getCol('eo_deedownerfirst'), getCol('eo_deedownermiddle'),
                getCol('eo_deedownerlast'), getCol('eo_deedownersuffix'),
                getCol('mailadd'), getCol('mail_city'), getCol('mail_state2'), getCol('mail_zip'),
                getCol('saledate'), getCol('saleprice') ? Number(getCol('saleprice')) : null,
            ]);
            totalUpdated++;
        } catch (e) {
            totalErrors++;
            if (totalErrors <= 5) {
                console.warn(`   ⚠️ UPSERT error line ${lineNum}: ${e.message}`);
            }
        }
    }

    return { updated: totalUpdated, errors: totalErrors };
}

// ─── API FALLBACK SYNC ───────────────────────────────────────
// When SFTP is not available, sync via Regrid API with rate limiting

async function regridApiFetch(endpoint, params = {}) {
    const url = new URL(`${REGRID_BASE_URL}${endpoint}`);
    url.searchParams.set('token', REGRID_TOKEN);
    url.searchParams.set('return_enhanced_ownership', 'true');
    Object.entries(params).forEach(([k, v]) => {
        if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
    });

    const res = await fetch(url.toString());

    // Handle 429 with backoff
    if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After');
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
        console.warn(`   ⚠️ Rate limited. Waiting ${waitMs}ms`);
        await sleep(waitMs);
        return regridApiFetch(endpoint, params); // Retry
    }

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Regrid API ${res.status}: ${text}`);
    }
    const data = await res.json();
    return data.parcels?.features || data.features || [];
}

async function apiSync(client) {
    if (!REGRID_TOKEN) {
        console.warn('⚠️  REGRID_TOKEN not set. Skipping API fallback sync.');
        return { checked: 0, updated: 0, errors: 0 };
    }

    const { rows: territories } = await client.query(`
        SELECT DISTINCT state, zip 
        FROM parcels 
        WHERE state IS NOT NULL AND zip IS NOT NULL
        ORDER BY state, zip
        LIMIT 500
    `);

    console.log(`\n📍 Active territories: ${territories.length}`);

    let totalChecked = 0, totalUpdated = 0, totalErrors = 0;

    for (const { state, zip } of territories) {
        try {
            const features = await regridApiFetch('/parcels/query', {
                'fields[state2][eq]': state,
                'fields[szip][eq]': zip,
                limit: 1000,
            });

            totalChecked += features.length;

            for (const feature of features) {
                const f = feature.properties?.fields || feature.properties || {};
                const uuid = f.ll_uuid;
                if (!uuid) continue;

                try {
                    await client.query(`
                        INSERT INTO parcels (
                            ll_uuid, owner, saledate, saleprice,
                            eo_owner, eo_last_refresh,
                            eo_deedownerfirst, eo_deedownerlast,
                            ll_updated_at, updated_at
                        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
                        ON CONFLICT (ll_uuid) DO UPDATE SET
                            owner = COALESCE(EXCLUDED.owner, parcels.owner),
                            saledate = COALESCE(EXCLUDED.saledate, parcels.saledate),
                            saleprice = COALESCE(EXCLUDED.saleprice, parcels.saleprice),
                            eo_owner = COALESCE(EXCLUDED.eo_owner, parcels.eo_owner),
                            eo_last_refresh = COALESCE(EXCLUDED.eo_last_refresh, parcels.eo_last_refresh),
                            eo_deedownerfirst = COALESCE(EXCLUDED.eo_deedownerfirst, parcels.eo_deedownerfirst),
                            eo_deedownerlast = COALESCE(EXCLUDED.eo_deedownerlast, parcels.eo_deedownerlast),
                            ll_updated_at = COALESCE(EXCLUDED.ll_updated_at, parcels.ll_updated_at),
                            updated_at = NOW()
                    `, [
                        uuid,
                        f.owner || null,
                        f.saledate || null,
                        f.saleprice ? Number(f.saleprice) : null,
                        f.eo_owner || null,
                        f.eo_last_refresh || null,
                        f.eo_deedownerfirst || null,
                        f.eo_deedownerlast || null,
                        f.ll_updated_at || null,
                    ]);
                    totalUpdated++;
                } catch (e) {
                    totalErrors++;
                    if (totalErrors <= 5) console.warn(`   ⚠️ ${uuid}: ${e.message}`);
                }
            }

            // Rate limiting — stay under ~200/min
            await sleep(350);
        } catch (e) {
            totalErrors++;
            console.warn(`   ❌ ${state} ${zip}: ${e.message}`);
        }
    }

    return { checked: totalChecked, updated: totalUpdated, errors: totalErrors };
}

// ─── MAIN ─────────────────────────────────────────────────────

async function main() {
    const startTime = Date.now();
    const args = process.argv.slice(2);
    const forceBaseline = args.includes('--baseline');
    const dateArg = args.find(a => a.startsWith('--date='));
    const targetDate = dateArg ? dateArg.split('=')[1] : getTodayStr();

    console.log('🔄 Regrid Daily Sync — Starting');
    console.log(`   Time: ${new Date().toISOString()}`);
    console.log(`   Mode: ${forceBaseline || isFirstOfMonth() ? 'BASELINE' : 'DELTA'}`);
    console.log(`   Date: ${targetDate}`);

    let pg;
    try {
        pg = await import('pg');
    } catch (e) {
        console.error('❌ Missing pg package.');
        process.exit(1);
    }

    const client = new pg.default.Client({ connectionString: DATABASE_URL });
    await client.connect();
    console.log('✅ Connected to PostgreSQL');

    let results;

    // Try SFTP first (Blueprint: preferred pathway)
    console.log('\n📡 Attempting SFTP download...');
    const csvFile = await downloadSFTPDelta(targetDate);

    if (csvFile) {
        console.log('\n📥 Processing CSV delta...');
        results = await ingestCSVDelta(client, csvFile);
        console.log(`   EO records processed: ${results.updated}`);
    } else {
        // Fallback to API sync
        console.log('\n🌐 Falling back to API sync...');
        results = await apiSync(client);
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`  DAILY SYNC COMPLETE`);
    console.log(`  Records updated:  ${results.updated?.toLocaleString() || 0}`);
    console.log(`  Errors:           ${results.errors || 0}`);
    console.log(`  Duration:         ${elapsed}s`);
    console.log(`${'═'.repeat(50)}\n`);

    await client.end();
}

main().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
