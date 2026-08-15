export const GROWTH_DECISION_POLICY_ID = "growth-decision-sufficiency.v1";
export const GROWTH_REVIEW_SCHEMA_VERSION = "growth-review.v3";
export const GROWTH_DECISION_OVERRIDE_MIN_CHARACTERS = 24;
export const GROWTH_DECISION_OVERRIDE_MIN_WORDS = 5;

export const GROWTH_DECISION_POLICY_REASON_CODES = Object.freeze({
  FIXED_AGE_SNAPSHOT_REQUIRED: "fixed_age_snapshot_required",
  CANONICAL_SOCIAL_EVIDENCE_REQUIRED: "canonical_social_evidence_required",
  PLATFORM_NATIVE_EXPOSURE_REQUIRED: "platform_native_exposure_required",
  BASE_SOCIAL_EVIDENCE_SUPPORTED: "base_social_evidence_supported",
  ITERATE_SUPPORTED: "iterate_supported_by_social_evidence",
  REPEAT_EXACT_ACTIVATION_SUPPORTED: "repeat_supported_by_exact_activation",
  REPEAT_MATURE_RETENTION_SUPPORTED: "repeat_supported_by_mature_retention",
  REPEAT_PAID_OUTCOME_SUPPORTED: "repeat_supported_by_paid_outcome",
  REPEAT_SOCIAL_OVERRIDE_REQUIRED: "repeat_social_only_override_required",
  REPEAT_SOCIAL_OVERRIDE_SUPPORTED: "repeat_supported_by_social_only_override",
  REPEAT_EXACT_OUTCOME_REQUIRED: "repeat_positive_exact_outcome_required",
  REPEAT_ELIGIBLE_EVIDENCE_REQUIRED: "repeat_eligible_evidence_required",
  HOLD_THREE_SNAPSHOTS_REQUIRED: "hold_three_comparable_snapshots_required",
  HOLD_THREE_SNAPSHOTS_SUPPORTED: "hold_supported_by_three_comparable_snapshots",
  INVALID_DECISION: "invalid_growth_decision",
});

const DECISIONS = new Set(["repeat", "iterate", "hold"]);
const PLATFORM_NATIVE_EXPOSURE_FIELDS = ["reach", "views"];
const SHA256 = /^[a-f0-9]{64}$/;

function normalized(value) {
  return String(value || "").trim().toLowerCase();
}

function exactCounter(value) {
  return typeof value === "number"
      && Number.isSafeInteger(value)
      && value >= 0
    ? value
    : null;
}

function exactRate(value) {
  return typeof value === "number"
      && Number.isFinite(value)
      && value >= 0
      && value <= 1
    ? value
    : null;
}

function exactSha256(value) {
  const result = normalized(value);
  return SHA256.test(result) ? result : "";
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function normalizeGrowthDecisionOverrideNote(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 500);
}

export function isNontrivialGrowthDecisionOverride(value) {
  const note = normalizeGrowthDecisionOverrideNote(value);
  const words = note.toLowerCase().match(/[a-z0-9]+/g) || [];
  return note.length >= GROWTH_DECISION_OVERRIDE_MIN_CHARACTERS
    && words.length >= GROWTH_DECISION_OVERRIDE_MIN_WORDS
    && new Set(words).size >= 4;
}

function normalizedExposure(input) {
  const declared = Array.isArray(input?.observed_platform_native_exposure_fields)
    ? input.observed_platform_native_exposure_fields.map(normalized)
    : [];
  const fields = PLATFORM_NATIVE_EXPOSURE_FIELDS.filter((field) => (
    declared.includes(field)
    && exactCounter(input?.platform_native_exposure?.[field]) !== null
  ));
  return {
    fields,
    values: Object.fromEntries(PLATFORM_NATIVE_EXPOSURE_FIELDS.map((field) => [
      field,
      fields.includes(field)
        ? exactCounter(input?.platform_native_exposure?.[field])
        : null,
    ])),
  };
}

function normalizedConversion(value) {
  const conversion = value && typeof value === "object" ? value : {};
  return {
    schema_version: normalized(conversion?.schema_version) || null,
    post_conversion_eligible: conversion?.post_conversion_eligible === true,
    conversion_counters_available:
      conversion?.conversion_counters_available === true,
    attribution_method: normalized(conversion?.attribution_method) || null,
    conversion_conclusion: normalized(conversion?.conversion_conclusion) || null,
    activated_workspaces: exactCounter(conversion?.activated_workspaces),
    activated_users: exactCounter(conversion?.activated_users),
    activated_reps: exactCounter(conversion?.activated_reps),
    paid_users: exactCounter(conversion?.paid_users),
    activation_timing_complete: conversion?.activation_timing_complete === true,
    paid_timing_complete: conversion?.paid_timing_complete === true,
    retention_mature: conversion?.retention_mature === true,
    retention_eligible_users: exactCounter(conversion?.retention_eligible_users),
    retained_users: exactCounter(conversion?.retained_users),
    retention_rate: exactRate(conversion?.retention_rate),
  };
}

function isExactConversion(conversion) {
  return conversion.schema_version === "growth-conversion-evidence.v2"
    && conversion.post_conversion_eligible === true
    && conversion.conversion_counters_available === true
    && conversion.attribution_method === "declared_content_link"
    && conversion.conversion_conclusion === "exact_declared_link"
    && conversion.activation_timing_complete === true
    && conversion.paid_timing_complete === true;
}

function isSocialOnlyConversion(conversion) {
  return conversion.schema_version === "growth-conversion-evidence.v2"
    && conversion.post_conversion_eligible === false
    && conversion.conversion_counters_available === false
    && conversion.attribution_method === "social_evidence_only"
    && conversion.conversion_conclusion === "inconclusive_no_declared_link"
    && conversion.activation_timing_complete === false
    && conversion.paid_timing_complete === false
    && conversion.activated_workspaces === null
    && conversion.activated_users === null
    && conversion.activated_reps === null
    && conversion.paid_users === null
    && conversion.retention_eligible_users === null
    && conversion.retained_users === null
    && conversion.retention_rate === null;
}

export function evaluateGrowthDecisionSufficiency(input = {}) {
  const decision = normalized(input?.decision);
  const socialEvidenceHash = exactSha256(input?.social_evidence_hash);
  const snapshotCapturedAt = String(input?.snapshot_captured_at || "").trim();
  const snapshotDays = Number(input?.snapshot_days);
  const exposure = normalizedExposure(input);
  const conversion = normalizedConversion(input?.conversion_evidence);
  const comparableSnapshots = Number.isSafeInteger(
    input?.comparable_fixed_age_snapshots,
  ) && input.comparable_fixed_age_snapshots >= 0
    ? input.comparable_fixed_age_snapshots
    : 0;
  const overrideNote = normalizeGrowthDecisionOverrideNote(input?.override_note);
  const overrideHash = exactSha256(input?.override_hash);
  const overrideValid = isNontrivialGrowthDecisionOverride(overrideNote)
    && Boolean(overrideHash);
  const reasonCodes = [];

  if (input?.fixed_age_snapshot_valid !== true || !snapshotCapturedAt) {
    reasonCodes.push(
      GROWTH_DECISION_POLICY_REASON_CODES.FIXED_AGE_SNAPSHOT_REQUIRED,
    );
  }
  if (!socialEvidenceHash) {
    reasonCodes.push(
      GROWTH_DECISION_POLICY_REASON_CODES.CANONICAL_SOCIAL_EVIDENCE_REQUIRED,
    );
  }
  if (!exposure.fields.length) {
    reasonCodes.push(
      GROWTH_DECISION_POLICY_REASON_CODES.PLATFORM_NATIVE_EXPOSURE_REQUIRED,
    );
  }
  const baseSupported = reasonCodes.length === 0;
  if (baseSupported) {
    reasonCodes.push(
      GROWTH_DECISION_POLICY_REASON_CODES.BASE_SOCIAL_EVIDENCE_SUPPORTED,
    );
  }

  let supported = false;
  if (!DECISIONS.has(decision)) {
    reasonCodes.push(GROWTH_DECISION_POLICY_REASON_CODES.INVALID_DECISION);
  } else if (baseSupported && decision === "iterate") {
    supported = true;
    reasonCodes.push(GROWTH_DECISION_POLICY_REASON_CODES.ITERATE_SUPPORTED);
  } else if (baseSupported && decision === "hold") {
    if (comparableSnapshots >= 3) {
      supported = true;
      reasonCodes.push(
        GROWTH_DECISION_POLICY_REASON_CODES.HOLD_THREE_SNAPSHOTS_SUPPORTED,
      );
    } else {
      reasonCodes.push(
        GROWTH_DECISION_POLICY_REASON_CODES.HOLD_THREE_SNAPSHOTS_REQUIRED,
      );
    }
  } else if (baseSupported && decision === "repeat") {
    if (isExactConversion(conversion)) {
      const activationSupported = [
        conversion.activated_workspaces,
        conversion.activated_users,
        conversion.activated_reps,
      ].some((value) => value !== null && value > 0);
      const retentionSupported = conversion.retention_mature === true
        && conversion.retention_eligible_users !== null
        && conversion.retention_eligible_users > 0
        && conversion.retained_users !== null
        && conversion.retained_users > 0
        && conversion.retained_users <= conversion.retention_eligible_users
        && conversion.retention_rate !== null
        && conversion.retention_rate > 0;
      const paidSupported = conversion.paid_users !== null
        && conversion.paid_users > 0;
      if (activationSupported) {
        reasonCodes.push(
          GROWTH_DECISION_POLICY_REASON_CODES.REPEAT_EXACT_ACTIVATION_SUPPORTED,
        );
      }
      if (retentionSupported) {
        reasonCodes.push(
          GROWTH_DECISION_POLICY_REASON_CODES.REPEAT_MATURE_RETENTION_SUPPORTED,
        );
      }
      if (paidSupported) {
        reasonCodes.push(
          GROWTH_DECISION_POLICY_REASON_CODES.REPEAT_PAID_OUTCOME_SUPPORTED,
        );
      }
      supported = activationSupported || retentionSupported || paidSupported;
      if (!supported) {
        reasonCodes.push(
          GROWTH_DECISION_POLICY_REASON_CODES.REPEAT_EXACT_OUTCOME_REQUIRED,
        );
      }
    } else if (isSocialOnlyConversion(conversion)) {
      supported = overrideValid;
      reasonCodes.push(
        supported
          ? GROWTH_DECISION_POLICY_REASON_CODES.REPEAT_SOCIAL_OVERRIDE_SUPPORTED
          : GROWTH_DECISION_POLICY_REASON_CODES.REPEAT_SOCIAL_OVERRIDE_REQUIRED,
      );
    } else {
      reasonCodes.push(
        GROWTH_DECISION_POLICY_REASON_CODES.REPEAT_ELIGIBLE_EVIDENCE_REQUIRED,
      );
    }
  }

  const canonicalReasonCodes = uniqueSorted(reasonCodes);
  const overrideUsed = decision === "repeat"
    && isSocialOnlyConversion(conversion)
    && supported
    && overrideValid;
  return {
    policy_id: GROWTH_DECISION_POLICY_ID,
    supported,
    reason_codes: canonicalReasonCodes,
    override_note: overrideUsed ? overrideNote : "",
    override_hash: overrideUsed ? overrideHash : "",
    evidence: {
      policy_id: GROWTH_DECISION_POLICY_ID,
      decision,
      fixed_age_snapshot_valid: input?.fixed_age_snapshot_valid === true,
      social_evidence_hash: socialEvidenceHash || null,
      snapshot_days: Number.isSafeInteger(snapshotDays) ? snapshotDays : null,
      snapshot_captured_at: snapshotCapturedAt || null,
      observed_platform_native_exposure_fields: exposure.fields,
      platform_native_exposure: exposure.values,
      conversion_evidence: conversion,
      comparable_fixed_age_snapshots: comparableSnapshots,
      override_hash: overrideUsed ? overrideHash : null,
      supported,
      reason_codes: canonicalReasonCodes,
    },
  };
}
