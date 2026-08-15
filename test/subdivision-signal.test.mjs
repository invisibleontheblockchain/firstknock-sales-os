import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadBatchDataMapper() {
    const source = fs.readFileSync('base44/functions/processFetchChunk/entry.ts', 'utf8')
        .replace(/^import[\s\S]*?;\r?\n/gm, '');
    const sandbox = {
        Deno: {
            env: { get: () => null },
            serve: () => {},
        },
        console,
        precisionCriteriaReferenceMs: () => null,
        setTimeout,
        clearTimeout,
    };
    vm.runInNewContext(
        `${source}\nglobalThis.__mapBatchDataProperty = mapBatchDataProperty;`,
        sandbox,
        { filename: 'processFetchChunk/entry.ts' }
    );
    return sandbox.__mapBatchDataProperty;
}

function validProperty(overrides = {}) {
    return {
        address: {
            street: '100 Test Ave',
            city: 'Phoenix',
            state: 'AZ',
            zip: '85001',
            location: { latitude: 33.4484, longitude: -112.074 },
        },
        intel: { lastSoldDate: '2026-07-01' },
        general: {
            standardizedLandUseCode: 'R2',
            propertyTypeDetail: 'Single Family',
        },
        ...overrides,
    };
}

const job = {
    sold_months: 12,
    polygon: [
        { lat: 33.4, lng: -112.2 },
        { lat: 33.6, lng: -112.2 },
        { lat: 33.6, lng: -112.0 },
        { lat: 33.4, lng: -112.0 },
    ],
    dry_run_metadata: { filters: {} },
};

test('retains a bounded BatchData subdivision label in the canonical and minimized shapes', () => {
    const mapBatchDataProperty = loadBatchDataMapper();
    const mapped = mapBatchDataProperty({
        property: validProperty({ subdivisionName: '  Desert   Ridge  ' }),
    }, job);

    assert.equal(mapped.subdivision_name, 'Desert Ridge');
    const raw = JSON.parse(mapped.raw_payload);
    assert.equal(raw.property.subdivision_name, 'Desert Ridge');
    assert.deepEqual(Object.keys(raw).sort(), ['address', 'owner', 'property', 'property_id', 'provider', 'sale', 'schema_version']);
});

test('accepts explicit subdivision objects but rejects placeholder or oversized labels', () => {
    const mapBatchDataProperty = loadBatchDataMapper();
    const nested = mapBatchDataProperty({
        property: validProperty({ subdivision: { name: 'Pintail Point' } }),
    }, job);
    const placeholder = mapBatchDataProperty({
        property: validProperty({ subdivisionName: 'No Subdivision' }),
    }, job);
    const oversized = mapBatchDataProperty({
        property: validProperty({ subdivisionName: 'x'.repeat(161) }),
    }, job);

    assert.equal(nested.subdivision_name, 'Pintail Point');
    assert.equal(placeholder.subdivision_name, null);
    assert.equal(oversized.subdivision_name, null);
});

test('wires subdivision through JSON persistence and both candidate payload shapes', () => {
    const ingestion = fs.readFileSync('base44/functions/processFetchChunk/entry.ts', 'utf8');
    const candidates = fs.readFileSync('base44/functions/getRouteCandidatesFromNeon/entry.ts', 'utf8');
    const setup = fs.readFileSync('base44/functions/setupNeonPropertyTables/entry.ts', 'utf8');
    const entity = fs.readFileSync('base44/entities/MasterProperty.jsonc', 'utf8');

    assert.match(ingestion, /withSubdivisionInRawPayload\([\s\S]*p\.subdivision_name \|\| existingSubdivisionName/);
    assert.match(ingestion, /p\.raw_payload -> 'property' ->> 'subdivision_name'/);
    assert.match(candidates, /MAP_FIELDS[\s\S]*'subdivision_name'/);
    assert.doesNotMatch(setup, /\['subdivision_name', 'TEXT'\]/);
    assert.doesNotMatch(setup, /idx_properties_subdivision_name/);
    assert.equal(JSON.parse(entity).properties.subdivision_name.maxLength, 160);
});

test('keeps rollout schema-independent and preserves subdivision across other writers', () => {
    const ingestion = fs.readFileSync('base44/functions/processFetchChunk/entry.ts', 'utf8');
    const candidates = fs.readFileSync('base44/functions/getRouteCandidatesFromNeon/entry.ts', 'utf8');
    const zipWriter = fs.readFileSync('base44/functions/fetchZipProperties/entry.ts', 'utf8');
    const backfillWriter = fs.readFileSync('base44/functions/backfillMasterPropertyToNeon/entry.ts', 'utf8');
    const territoryWriter = fs.readFileSync('base44/functions/fixChristianTerritoryPolygon/entry.ts', 'utf8');

    assert.doesNotMatch(ingestion, /ALTER TABLE properties[\s\S]*subdivision_name/);
    assert.doesNotMatch(ingestion, /INSERT INTO properties \([\s\S]{0,180}\bstreet_name,\s*subdivision_name\b/);
    assert.doesNotMatch(ingestion, /UPDATE properties SET[\s\S]{0,500}\bsubdivision_name\s*=/);
    assert.ok((candidates.match(/to_jsonb\(p\) ->> 'subdivision_name'/g) || []).length >= 2);
    assert.ok((candidates.match(/p\.raw_payload -> 'property' ->> 'subdivision_name'/g) || []).length >= 2);
    assert.match(zipWriter, /raw_payload = CASE[\s\S]*properties\.raw_payload -> 'property' ->> 'subdivision_name'/);
    assert.match(backfillWriter, /raw_payload = CASE[\s\S]*properties\.raw_payload -> 'property' ->> 'subdivision_name'/);
    assert.match(territoryWriter, /raw_payload = CASE[\s\S]*properties\.raw_payload -> 'property' ->> 'subdivision_name'/);
});

test('legacy RentCast territory repair rejects Precision jobs before provider work or mutation', () => {
    const source = fs.readFileSync('base44/functions/fixChristianTerritoryPolygon/entry.ts', 'utf8');
    const precisionGuard = source.indexOf(
        'if (isActualPrecisionJob(job) || hasPrecisionJobMarkers(job))'
    );
    const rentcastConfigCheck = source.indexOf('if (!RENTCAST_API_KEY)', precisionGuard);
    const databaseConfigCheck = source.indexOf('if (!DATABASE_URL)', precisionGuard);
    const providerLoop = source.indexOf('await fetchCircleRecords(circle, saleDateRange)');
    const polygonMutation = source.indexOf('FetchJob.update(job.id, { polygon: correctedPolygon })');

    assert.ok(precisionGuard > 0);
    assert.ok(rentcastConfigCheck > precisionGuard);
    assert.ok(databaseConfigCheck > precisionGuard);
    assert.ok(providerLoop > precisionGuard);
    assert.ok(polygonMutation > providerLoop);
    assert.match(
        source.slice(precisionGuard, rentcastConfigCheck),
        /isActualPrecisionJob\(job\) \|\| hasPrecisionJobMarkers\(job\)/
    );
    assert.match(source.slice(precisionGuard, providerLoop), /precision_job_mutation_forbidden/);
});
