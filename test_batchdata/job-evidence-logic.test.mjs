import test from 'node:test';
import assert from 'node:assert/strict';

import {
    applyJobScopedOwnerObservation,
    candidateQualificationEvidence,
    exactFetchJobBelongsToTarget,
    jobScopedListingEvidence,
    jobScopedOwnerObservation
} from '../base44/functions/getRouteCandidatesFromNeon/jobEvidenceLogic.js';

test('an omitted job owner clears a canonical prior owner without claiming verification', () => {
    const payload = {
        _firstknock: {
            mapped_evidence: { owner_name_observed: false },
            mapped_values: { owner_full_name: null }
        }
    };

    const resolved = applyJobScopedOwnerObservation('Prior Owner', payload);
    assert.deepEqual(resolved, {
        owner_full_name: null,
        provider_owner_name_observed: false,
        owner_full_name_source: 'batchdata_job_observation'
    });
    assert.equal('sale_verified' in resolved, false);
});

test('an observed job owner overrides canonical data with observation provenance', () => {
    const observation = jobScopedOwnerObservation(JSON.stringify({
        _firstknock: {
            mapped_evidence: { owner_name_observed: true },
            mapped_values: { owner_full_name: '  Current Owner  ' }
        }
    }));

    assert.deepEqual(observation, {
        available: true,
        owner_name_observed: true,
        owner_full_name: 'Current Owner',
        source: 'batchdata_job_observation'
    });
});

test('legacy evidence without an owner observation retains the canonical owner', () => {
    const resolved = applyJobScopedOwnerObservation('Canonical Owner', { _firstknock: {} });
    assert.deepEqual(resolved, {
        owner_full_name: 'Canonical Owner',
        provider_owner_name_observed: null,
        owner_full_name_source: 'canonical'
    });
});

test('exact FetchJob evidence is readable only for its target workspace owner', () => {
    const job = { id: 'job-1', user_email: 'Manager@Example.com' };
    assert.equal(exactFetchJobBelongsToTarget(job, 'manager@example.com'), true);
    assert.equal(exactFetchJobBelongsToTarget(job, 'other@example.com'), false);
    assert.equal(exactFetchJobBelongsToTarget(null, 'manager@example.com'), false);
    assert.equal(exactFetchJobBelongsToTarget({ id: 'job-1' }, 'manager@example.com'), false);
});

test('job-scoped listing evidence carries its observed value instead of a global status', () => {
    const evidence = jobScopedListingEvidence({
        _firstknock: {
            search_evidence: { listing_status_categories_excluded: ['Active', 'Pending'] },
            mapped_evidence: { listing_status_observed: true },
            mapped_values: { listing_status: 'Sold' }
        }
    });
    assert.equal(evidence.provider_listing_status_observed, true);
    assert.equal(evidence.provider_listing_status_value, 'Sold');
    assert.equal(evidence.provider_listing_safety_source, 'job_scoped_observation');
});

test('a completed exact job may restore missing row-level listing predicate proof', () => {
    const evidence = jobScopedListingEvidence({ _firstknock: {} }, {
        status: 'completed',
        provider: 'batchdata',
        dry_run_metadata: {
            job_membership_contract: 'property_sources_v1',
            batchdata_summary: {
                filters: { listing_status_categories_excluded: ['Active', 'Pending'] }
            }
        }
    });
    assert.deepEqual(evidence.provider_listing_status_categories_excluded, ['Active', 'Pending']);
    assert.equal(evidence.provider_listing_safety_source, 'completed_job_predicate');
});

test('legacy or incomplete job metadata cannot manufacture listing proof', () => {
    const legacy = jobScopedListingEvidence({ _firstknock: {} }, {
        status: 'completed',
        provider: 'batchdata',
        dry_run_metadata: {
            batchdata_summary: {
                filters: { listing_status_categories_excluded: ['Active', 'Pending'] }
            }
        }
    });
    const incomplete = jobScopedListingEvidence({ _firstknock: {} }, {
        status: 'completed',
        provider: 'batchdata',
        dry_run_metadata: {
            job_membership_contract: 'property_sources_v1',
            batchdata_summary: {
                filters: { listing_status_categories_excluded: ['Active'] }
            }
        }
    });
    assert.deepEqual(legacy.provider_listing_status_categories_excluded, []);
    assert.deepEqual(incomplete.provider_listing_status_categories_excluded, []);
    assert.equal(legacy.provider_listing_safety_source, 'missing');
    assert.equal(incomplete.provider_listing_safety_source, 'missing');
});

test('exact-job qualification ignores mutable global evidence when its source row is absent', () => {
    const globalPayload = {
        _firstknock: {
            search_evidence: { listing_status_categories_excluded: ['Active', 'Pending'] },
            mapped_evidence: { listing_status_observed: true },
            mapped_values: { listing_status: 'Sold' }
        }
    };
    const exactEvidence = candidateQualificationEvidence(globalPayload, null, true);
    const accountEvidence = candidateQualificationEvidence(globalPayload, null, false);
    assert.deepEqual(exactEvidence, {});
    assert.deepEqual(accountEvidence, globalPayload);
    assert.equal(jobScopedListingEvidence(exactEvidence).provider_listing_safety_source, 'missing');
});
