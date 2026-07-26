import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import {
    PRECISION_PROVIDER_CONTRACT_VERSION,
    buildRequestedPrecisionCriteria,
    comparePrecisionCriteria,
    precisionCriteriaDiagnostic
} from '../base44/functions/_shared/precisionActiveJobCriteria.js';

// include_mls belongs to the retired MLS pipeline. It may survive on the
// FetchJob entity as inert legacy metadata, but it must not influence the
// active Precision request, parser, criteria identity, count, or candidate set.

const POLYGON = [
    { lat: 35.4, lng: -80.1 },
    { lat: 35.6, lng: -80.1 },
    { lat: 35.6, lng: -79.9 },
    { lat: 35.4, lng: -79.9 }
];

function loadProcessor() {
    const source = fs.readFileSync('base44/functions/processFetchChunk/entry.ts', 'utf8')
        .replace(/^import .*;\s*$/gm, '');
    const sandbox = { Deno: { env: { get: () => null }, serve: () => {} }, console, setTimeout, clearTimeout };
    vm.runInNewContext(
        `${source}
        globalThis.__map = mapBatchDataProperty;
        globalThis.__build = buildBatchDataRequest;`,
        sandbox,
        { filename: 'processFetchChunk/entry.ts' }
    );
    return { map: sandbox.__map, build: sandbox.__build };
}

const { map: mapBatchDataProperty, build: buildBatchDataRequest } = loadProcessor();
const plain = value => JSON.parse(JSON.stringify(value));

function precisionJob(overrides = {}) {
    return {
        id: 'job_mls',
        mode_tag: 'PRECISION_TARGET',
        precision_usage_user_id: 'user-1',
        polygon: POLYGON,
        created_date: '2026-07-25T12:00:00.000Z',
        sold_months: 12,
        ...overrides,
        dry_run_metadata: {
            filters: { min_price: 100000, max_price: null },
            ...(overrides.dry_run_metadata || {})
        }
    };
}

function providerRecord(extra = {}) {
    return {
        property: {
            address: { street: '1000 Redacted St', city: 'REDACTED_CITY_001', state: 'NC', zip: '27000', location: { latitude: 35.5, longitude: -80.0 } },
            intel: { lastSoldDate: '2026-06-23T00:00:00.000Z' },
            general: { standardizedLandUseCode: 'R2', propertyTypeDetail: 'Single Family' },
            valuation: { estimatedValue: 325000 },
            ...extra
        }
    };
}

test('include_mls on the job never changes the outbound request', () => {
    const base = plain(buildBatchDataRequest(precisionJob({ include_mls: false }), 0, 100, 'broad_polygon'));
    const enabled = plain(buildBatchDataRequest(precisionJob({ include_mls: true }), 0, 100, 'broad_polygon'));
    const metadataFlag = plain(buildBatchDataRequest(
        precisionJob({ dry_run_metadata: { filters: { min_price: 100000, max_price: null }, include_mls: true } }),
        0, 100, 'broad_polygon'
    ));

    assert.deepEqual(enabled, base);
    assert.deepEqual(metadataFlag, base);
});

test('include_mls on the job never changes the mapped row or its eligibility', () => {
    const withFlag = mapBatchDataProperty(providerRecord(), precisionJob({ include_mls: true }));
    const withoutFlag = mapBatchDataProperty(providerRecord(), precisionJob({ include_mls: false }));

    assert.deepEqual(plain(withFlag), plain(withoutFlag));
    assert.equal(withFlag.route_active, true);
});

test('listing status never rejects or rescues a Precision row', () => {
    // Real captures show Precision polygon rows frequently carry no listing
    // status at all (evidence OBS-06), so listing status cannot be an
    // eligibility input in either direction.
    const job = precisionJob();
    const neutral = mapBatchDataProperty(providerRecord(), job);

    for (const status of ['Active', 'Pending', 'Off Market', 'Withdrawn', 'Sold', '']) {
        const mapped = mapBatchDataProperty(providerRecord({ listing: { status } }), job);
        assert.equal(mapped.route_active, neutral.route_active, `listing status "${status}" changed routability`);
        assert.equal(mapped.exclusion_reason, neutral.exclusion_reason, `listing status "${status}" changed the exclusion reason`);
        assert.equal(mapped.sold_date, neutral.sold_date, `listing status "${status}" changed the sale date`);
        assert.equal(mapped.price, neutral.price, `listing status "${status}" changed the price`);
    }
});

test('include_mls is not part of canonical criteria identity or retry comparison', () => {
    const withFlag = buildRequestedPrecisionCriteria({ polygon_hash: 'abc', sold_months: 12, include_mls: true });
    const withoutFlag = buildRequestedPrecisionCriteria({ polygon_hash: 'abc', sold_months: 12, include_mls: false });

    assert.deepEqual(withFlag, withoutFlag, 'include_mls must not alter canonical criteria');
    assert.ok(!('include_mls' in withFlag), 'include_mls must not be a canonical criteria field');

    const comparison = comparePrecisionCriteria(withFlag, withoutFlag);
    assert.equal(comparison.matches, true);
    assert.deepEqual(comparison.mismatched_fields, []);

    assert.ok(!('include_mls' in precisionCriteriaDiagnostic(withFlag)), 'attempt provenance must not expose include_mls');
});

test('the browser retry payload no longer replays include_mls', () => {
    const source = fs.readFileSync('src/components/map/TerritoryPrompt.jsx', 'utf8');
    const assignment = /include_mls\s*:/.test(source);
    assert.equal(assignment, false, 'TerritoryPrompt must not put include_mls into a retry payload');
});

test('the current provider contract version is recorded and supported', () => {
    assert.equal(PRECISION_PROVIDER_CONTRACT_VERSION, 1);
});
