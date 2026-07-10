import test from 'node:test';
import assert from 'node:assert/strict';

import {
    applyJobScopedOwnerObservation,
    exactFetchJobBelongsToTarget,
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
