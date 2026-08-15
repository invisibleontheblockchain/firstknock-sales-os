import {
  findSuppressionMatch,
  hasSourceEvidence,
  isCompanyDomainEmail,
  normalizeEmail,
} from './pipeline.mjs';

const VERIFIED_PROVIDER_STATUSES = new Set(['verified', 'valid', 'likely_to_engage']);

function canonical(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function suppressionMatch(record, suppression) {
  if (!(suppression?.emails instanceof Map) || !(suppression?.domains instanceof Map)) {
    throw new Error('A loaded suppression index is required before provider calls.');
  }
  if (record.opted_out_at || canonical(record.suppression_status)) {
    return { source: 'imported', reason: record.suppression_reason || 'imported opt-out or suppression' };
  }
  if (canonical(record.verification_status) === 'suppressed') {
    return { source: 'verifier', reason: record.verification_reason || 'verifier privacy suppression' };
  }
  const external = findSuppressionMatch(record, suppression);
  if (external) return { source: external.source, reason: external.reason || 'suppression list match' };
  return null;
}

export function isEligibleForVerification(record, suppression) {
  if (suppressionMatch(record, suppression)) return false;
  const email = normalizeEmail(record.email);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
  if (!record.company_domain || !isCompanyDomainEmail(email, record.company_domain)) return false;
  if (!record.current_employer_confirmed) return false;
  if (!hasSourceEvidence(record.residential_evidence, record.residential_evidence_url)) return false;
  if (!hasSourceEvidence(record.d2d_evidence, record.d2d_evidence_url)) return false;
  if (record.is_role || record.is_free_provider || record.is_disposable) return false;
  if (Number(record.contact_rank_score) < 70) return false;
  return VERIFIED_PROVIDER_STATUSES.has(canonical(record.provider_email_status));
}

export function createVerificationPlan(records, suppression, {
  provider = 'none',
  maxCalls = 0,
  confirmedCalls = -1,
} = {}) {
  if (provider === 'none') {
    return { selectedIndexes: [], eligibleCount: 0, deferredCount: 0, maxCalls: 0 };
  }
  const eligibleIndexes = records
    .map((record, index) => (isEligibleForVerification(record, suppression) ? index : -1))
    .filter((index) => index >= 0);
  if (!eligibleIndexes.length) {
    return { selectedIndexes: [], eligibleCount: 0, deferredCount: 0, maxCalls };
  }
  if (!Number.isInteger(maxCalls) || maxCalls <= 0 || confirmedCalls !== maxCalls) {
    throw new Error(
      `Paid ${provider} verification is locked for ${eligibleIndexes.length} eligible addresses. `
      + 'Set --max-verifications N and --confirm-verification-spend N to the same positive number.',
    );
  }
  const selectedIndexes = eligibleIndexes.slice(0, maxCalls);
  return {
    selectedIndexes,
    eligibleCount: eligibleIndexes.length,
    deferredCount: Math.max(0, eligibleIndexes.length - selectedIndexes.length),
    maxCalls,
  };
}

export function mergeVerifiedRecords(records, selectedIndexes, verifiedRecords) {
  if (selectedIndexes.length !== verifiedRecords.length) {
    throw new Error('Verifier returned a different number of records than the approved verification plan.');
  }
  const merged = [...records];
  selectedIndexes.forEach((recordIndex, verifiedIndex) => {
    merged[recordIndex] = verifiedRecords[verifiedIndex];
  });
  return merged;
}
