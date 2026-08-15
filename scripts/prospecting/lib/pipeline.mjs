import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import Papa from 'papaparse';

export const OUTPUT_COLUMNS = [
  'company_name',
  'company_domain',
  'company_website',
  'market_city',
  'market_state',
  'country',
  'estimated_employees',
  'size_cohort',
  'industry',
  'residential_evidence',
  'residential_evidence_url',
  'd2d_evidence',
  'd2d_evidence_url',
  'fieldroutes_evidence',
  'fieldroutes_evidence_url',
  'company_source_provider',
  'source_company_id',
  'target_company_id',
  'target_company_domain',
  'company_fetched_at',
  'contact_first_name',
  'contact_last_name',
  'contact_full_name',
  'contact_title',
  'contact_seniority',
  'source_person_id',
  'person_organization_id',
  'person_organization_domain',
  'current_employer_confirmed',
  'contact_rank_score',
  'contact_rank_reason',
  'email',
  'email_type',
  'email_source_provider',
  'email_source_url',
  'provider_email_status',
  'verifier_provider',
  'verification_status',
  'verification_reason',
  'verification_score',
  'is_accept_all',
  'is_role',
  'is_disposable',
  'is_free_provider',
  'verified_at',
  'suppression_status',
  'suppression_reason',
  'opted_out_at',
  'ready_to_contact',
  'status',
  'review_notes',
];

const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'outlook.com',
  'hotmail.com', 'live.com', 'icloud.com', 'aol.com', 'proton.me', 'protonmail.com',
]);

const ROLE_LOCAL_PARTS = new Set([
  'admin', 'billing', 'careers', 'contact', 'hello', 'help', 'info', 'jobs',
  'marketing', 'office', 'sales', 'service', 'support', 'team',
]);

const SUPPRESSION_EMAIL_FIELDS = ['email', 'contact_email', 'value'];
const SUPPRESSION_DOMAIN_FIELDS = ['domain', 'company_domain'];
const SUPPRESSION_IDENTITY_FIELDS = new Set([
  ...SUPPRESSION_EMAIL_FIELDS,
  ...SUPPRESSION_DOMAIN_FIELDS,
]);
const SUPPRESSED_STATUSES = new Set([
  'blocked', 'do_not_contact', 'opted_out', 'suppressed', 'unsubscribed',
]);

const TITLE_RULES = {
  small: [
    [/\bowner(?:\s*\/\s*operator)?\b/i, 100, 'owner'],
    [/\bfounder\b/i, 97, 'founder'],
    [/\bpresident\b/i, 94, 'president'],
    [/\bchief executive officer\b|\bceo\b/i, 91, 'chief executive'],
    [/\bgeneral manager\b/i, 88, 'general manager'],
    [/\b(?:vp|vice president|head)\b.*\bsales\b/i, 84, 'sales executive'],
    [/\bdirector\b.*\bsales\b/i, 80, 'sales director'],
    [/\bfield operations\b/i, 76, 'field operations'],
    [/\bcanvass(?:ing)? manager\b/i, 74, 'canvassing manager'],
    [/\bsales manager\b/i, 70, 'sales manager'],
  ],
  larger: [
    [/\b(?:vp|vice president|head)\b.*\bsales\b/i, 100, 'sales executive'],
    [/\bdirector\b.*\bsales\b/i, 96, 'sales director'],
    [/\b(?:vp|vice president|head|director)\b.*\bfield operations\b/i, 93, 'field operations executive'],
    [/\bcanvass(?:ing)? manager\b/i, 90, 'canvassing manager'],
    [/\b(?:vp|vice president|director|head)\b.*\boperations\b/i, 86, 'operations executive'],
    [/\bpresident\b/i, 82, 'president'],
    [/\bowner\b|\bfounder\b/i, 76, 'owner or founder'],
    [/\bgeneral manager\b/i, 72, 'general manager'],
    [/\bsales manager\b/i, 70, 'sales manager'],
  ],
};

const NEGATIVE_TITLE = /\b(former|advisor|consultant|assistant|recruiter|intern|student|technician)\b/i;

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '');
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  return /^(true|yes|y|1)$/i.test(String(value ?? '').trim());
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function canonicalStatus(value) {
  return cleanText(value).toLowerCase().replace(/[\s-]+/g, '_');
}

function hasSuppressionStatus(value) {
  return SUPPRESSED_STATUSES.has(canonicalStatus(value));
}

export function normalizeDomain(value) {
  const raw = cleanText(value).toLowerCase();
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./, '').replace(/\.$/, '');
  } catch {
    return raw
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0]
      .split(':')[0]
      .replace(/\.$/, '');
  }
}

export function normalizeEmail(value) {
  return cleanText(value).toLowerCase();
}

export function emailDomain(email) {
  const normalized = normalizeEmail(email);
  const at = normalized.lastIndexOf('@');
  return at > 0 ? normalizeDomain(normalized.slice(at + 1)) : '';
}

export function isCompanyDomainEmail(email, companyDomain) {
  const actual = emailDomain(email);
  const expected = normalizeDomain(companyDomain);
  return Boolean(actual && expected && (actual === expected || actual.endsWith(`.${expected}`)));
}

export function isRoleEmail(email) {
  const local = normalizeEmail(email).split('@')[0] || '';
  return ROLE_LOCAL_PARTS.has(local) || /^(info|sales|contact|hello|support)[+._-]/i.test(local);
}

export function isFreeProvider(email) {
  return FREE_EMAIL_DOMAINS.has(emailDomain(email));
}

export function hasSourceEvidence(value, sourceUrl) {
  const evidence = cleanText(value);
  const status = canonicalStatus(evidence);
  if (!evidence || ['unknown', 'none', 'not_confirmed', 'false', 'no'].includes(status)) return false;
  try {
    const url = new URL(cleanText(sourceUrl));
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

export function sizeCohort(employeeCount) {
  const count = Number(employeeCount);
  if (!Number.isFinite(count) || count <= 0) return 'unknown';
  return count <= 25 ? 'small' : 'larger';
}

export function rankDecisionMaker(title, employeeCount) {
  const normalizedTitle = cleanText(title);
  if (!normalizedTitle) return { score: 0, reason: 'missing title' };
  const cohort = sizeCohort(employeeCount) === 'larger' ? 'larger' : 'small';
  for (const [pattern, score, reason] of TITLE_RULES[cohort]) {
    if (!pattern.test(normalizedTitle)) continue;
    const penalty = NEGATIVE_TITLE.test(normalizedTitle) ? 45 : 0;
    return {
      score: Math.max(0, score - penalty),
      reason: penalty ? `${reason}; penalized unrelated/advisory title` : reason,
    };
  }
  return {
    score: NEGATIVE_TITLE.test(normalizedTitle) ? 0 : 20,
    reason: NEGATIVE_TITLE.test(normalizedTitle) ? 'unrelated/advisory title' : 'unrecognized title',
  };
}

function nestedArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['matches', 'people', 'contacts', 'items', 'results', 'organizations', 'records']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  if (payload.data) {
    const nested = nestedArray(payload.data);
    if (nested.length) return nested;
  }
  if (payload.structuredContent) {
    const nested = nestedArray(payload.structuredContent);
    if (nested.length) return nested;
  }
  if (Array.isArray(payload.content)) {
    for (const block of payload.content) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue;
      try {
        const parsed = JSON.parse(block.text);
        const nested = nestedArray(parsed);
        if (nested.length) return nested;
      } catch {
        // Non-JSON connector narration is intentionally ignored.
      }
    }
  }
  if (payload.email || payload.work_email || payload.contact_email || payload.person_id) return [payload];
  return [];
}

export function extractRecords(payload) {
  return nestedArray(payload);
}

function normalizeVerificationStatus(value) {
  const status = canonicalStatus(value);
  if (['deliverable', 'valid', 'ok', 'verified'].includes(status)) return 'deliverable';
  if (['catch_all', 'accept_all', 'risky', 'full_mailbox'].includes(status)) return 'risky';
  if (['invalid', 'undeliverable', 'disposable', 'blocked'].includes(status)) return 'undeliverable';
  if (['suppressed', 'opted_out', 'do_not_contact'].includes(status)) return 'suppressed';
  if (!status || ['not_checked', 'unverified'].includes(status)) return 'not_checked';
  return 'unknown';
}

export function normalizeProspect(raw, defaults = {}) {
  const organization = raw.organization || raw.company || raw.account || {};
  const location = organization.primary_location || organization.location || raw.location || {};
  const website = firstValue(
    raw.company_website,
    raw.website_url,
    organization.website_url,
    organization.website,
  );
  const companyDomain = normalizeDomain(firstValue(
    raw.company_domain,
    raw.domain,
    raw.organization_primary_domain,
    organization.primary_domain,
    organization.domain,
    website,
  ));
  const employeeCount = Number(firstValue(
    raw.estimated_employees,
    raw.organization_num_employees,
    organization.estimated_num_employees,
    organization.num_employees,
  )) || '';
  const title = cleanText(firstValue(raw.contact_title, raw.title, raw.person_title));
  const rank = rankDecisionMaker(title, employeeCount);
  const email = normalizeEmail(firstValue(raw.email, raw.work_email, raw.contact_email));
  const firstName = cleanText(firstValue(raw.contact_first_name, raw.first_name));
  const lastName = cleanText(firstValue(raw.contact_last_name, raw.last_name));
  const fullName = cleanText(firstValue(raw.contact_full_name, raw.name, `${firstName} ${lastName}`));
  const sourceProvider = cleanText(firstValue(
    raw.company_source_provider,
    defaults.sourceProvider,
    raw.provider,
    'apollo',
  )).toLowerCase();
  const providerEmailStatus = cleanText(firstValue(raw.provider_email_status, raw.email_status));
  const verificationStatus = normalizeVerificationStatus(firstValue(
    raw.verification_status,
    raw.verdict,
    raw.independent_verification_status,
  ));
  const role = toBoolean(firstValue(raw.is_role, raw.role_account)) || isRoleEmail(email);
  const free = toBoolean(firstValue(raw.is_free_provider, raw.free)) || isFreeProvider(email);
  const disposable = toBoolean(firstValue(raw.is_disposable, raw.disposable));
  const acceptAll = toBoolean(firstValue(raw.is_accept_all, raw.accept_all)) || verificationStatus === 'risky';
  const targetCompanyId = cleanText(firstValue(
    raw.target_company_id,
    raw.source_company_id,
    defaults.targetCompanyId,
  ));
  const personOrganizationId = cleanText(firstValue(
    raw.person_organization_id,
    raw.organization_id,
    organization.person_organization_id,
  ));
  const providerCompanyId = targetCompanyId || personOrganizationId
    || cleanText(firstValue(organization.id, organization.organization_id));
  const targetCompanyDomain = normalizeDomain(firstValue(
    raw.target_company_domain,
    defaults.targetCompanyDomain,
  ));
  const personOrganizationDomain = normalizeDomain(firstValue(
    raw.person_organization_domain,
    raw.organization_primary_domain,
    organization.primary_domain,
    organization.domain,
  ));
  const hasExplicitEmployerConfirmation = raw.current_employer_confirmed !== undefined
    && raw.current_employer_confirmed !== null
    && String(raw.current_employer_confirmed).trim() !== '';
  const employerIdComparable = Boolean(targetCompanyId && personOrganizationId);
  const employerDomainComparable = Boolean(targetCompanyDomain && personOrganizationDomain);
  const employerEvidenceConflict = (employerIdComparable && targetCompanyId !== personOrganizationId)
    || (employerDomainComparable && targetCompanyDomain !== personOrganizationDomain);
  const employerEvidenceMatch = (employerIdComparable && targetCompanyId === personOrganizationId)
    || (employerDomainComparable && targetCompanyDomain === personOrganizationDomain);
  const explicitEmployerRejection = hasExplicitEmployerConfirmation
    && !toBoolean(raw.current_employer_confirmed);
  const currentEmployerConfirmed = !explicitEmployerRejection
    && !employerEvidenceConflict
    && employerEvidenceMatch;
  const optedOutAt = cleanText(firstValue(raw.opted_out_at, raw.unsubscribe_date));
  const importedSuppressionStatus = canonicalStatus(firstValue(
    raw.suppression_status,
    raw.email_suppression_status,
  ));
  const importedOptOut = hasSuppressionStatus(importedSuppressionStatus)
    || toBoolean(firstValue(raw.opted_out, raw.unsubscribed, raw.do_not_contact))
    || Boolean(optedOutAt);
  const suppressionStatus = importedSuppressionStatus
    || (importedOptOut ? (optedOutAt ? 'opted_out' : 'suppressed') : '');

  return {
    company_name: cleanText(firstValue(raw.company_name, raw.organization_name, organization.name)),
    company_domain: companyDomain,
    company_website: cleanText(website || (companyDomain ? `https://${companyDomain}` : '')),
    market_city: cleanText(firstValue(raw.market_city, raw.city, organization.city, location.city)),
    market_state: cleanText(firstValue(raw.market_state, raw.state, organization.state, location.state)),
    country: cleanText(firstValue(raw.country, organization.country, location.country, defaults.country, 'United States')),
    estimated_employees: employeeCount,
    size_cohort: cleanText(firstValue(raw.size_cohort, sizeCohort(employeeCount))),
    industry: cleanText(firstValue(raw.industry, organization.industry, defaults.industry, 'pest control')),
    residential_evidence: cleanText(firstValue(raw.residential_evidence, defaults.residentialEvidence)),
    residential_evidence_url: cleanText(firstValue(raw.residential_evidence_url, defaults.residentialEvidenceUrl)),
    d2d_evidence: cleanText(firstValue(raw.d2d_evidence, defaults.d2dEvidence)),
    d2d_evidence_url: cleanText(firstValue(raw.d2d_evidence_url, defaults.d2dEvidenceUrl)),
    fieldroutes_evidence: cleanText(firstValue(raw.fieldroutes_evidence, defaults.fieldroutesEvidence, 'unknown')),
    fieldroutes_evidence_url: cleanText(firstValue(raw.fieldroutes_evidence_url, defaults.fieldroutesEvidenceUrl)),
    company_source_provider: sourceProvider,
    source_company_id: providerCompanyId,
    target_company_id: targetCompanyId,
    target_company_domain: targetCompanyDomain,
    company_fetched_at: cleanText(firstValue(raw.company_fetched_at, raw.fetched_at, defaults.fetchedAt, new Date().toISOString())),
    contact_first_name: firstName,
    contact_last_name: lastName,
    contact_full_name: fullName,
    contact_title: title,
    contact_seniority: cleanText(firstValue(raw.contact_seniority, raw.seniority)),
    source_person_id: cleanText(firstValue(raw.source_person_id, raw.person_id, raw.id)),
    person_organization_id: personOrganizationId,
    person_organization_domain: personOrganizationDomain,
    current_employer_confirmed: currentEmployerConfirmed,
    contact_rank_score: rank.score,
    contact_rank_reason: rank.reason,
    email,
    email_type: email ? (role ? 'generic' : 'named_business') : 'unknown',
    email_source_provider: cleanText(firstValue(raw.email_source_provider, raw.email_provider, sourceProvider)),
    email_source_url: cleanText(firstValue(raw.email_source_url, raw.source_url)),
    provider_email_status: providerEmailStatus,
    verifier_provider: cleanText(firstValue(raw.verifier_provider, defaults.verifierProvider, 'none')),
    verification_status: verificationStatus,
    verification_reason: cleanText(firstValue(raw.verification_reason, raw.reason)),
    verification_score: firstValue(raw.verification_score, raw.score, ''),
    is_accept_all: acceptAll,
    is_role: role,
    is_disposable: disposable,
    is_free_provider: free,
    verified_at: cleanText(firstValue(raw.verified_at, raw.verification_date)),
    suppression_status: suppressionStatus,
    suppression_reason: cleanText(firstValue(raw.suppression_reason, raw.opt_out_reason, raw.unsubscribe_reason)),
    opted_out_at: optedOutAt,
    ready_to_contact: false,
    status: 'review',
    review_notes: '',
  };
}

export function dedupeProspects(records) {
  const byKey = new Map();
  for (const record of records) {
    const normalized = normalizeProspect(record);
    const key = normalized.email
      ? `email:${normalized.email}`
      : normalized.source_person_id
        ? `person:${normalized.source_person_id}`
        : `company:${normalized.company_domain}:${normalized.contact_full_name}:${normalized.contact_title}`.toLowerCase();
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, normalized);
      continue;
    }
    const preferred = Number(normalized.contact_rank_score) > Number(current.contact_rank_score)
      ? normalized
      : current;
    const suppressedRecord = [current, normalized].find((candidate) => (
      hasSuppressionStatus(candidate.suppression_status) || Boolean(candidate.opted_out_at)
    ));
    byKey.set(key, suppressedRecord ? {
      ...preferred,
      suppression_status: suppressedRecord.suppression_status || 'suppressed',
      suppression_reason: suppressedRecord.suppression_reason || preferred.suppression_reason,
      opted_out_at: suppressedRecord.opted_out_at || preferred.opted_out_at,
    } : preferred);
  }
  return [...byKey.values()];
}

export function selectOneContactPerCompany(records) {
  const byCompany = new Map();
  dedupeProspects(records).forEach((prospect, index) => {
    const providerCompanyId = prospect.target_company_id || prospect.source_company_id;
    const companyKey = prospect.company_domain
      ? `domain:${prospect.company_domain}`
      : providerCompanyId
        ? `provider:${prospect.company_source_provider || 'unknown'}:${providerCompanyId}`
        : `unresolved:${prospect.source_person_id || prospect.email || index}`;
    const current = byCompany.get(companyKey);
    if (!current || Number(prospect.contact_rank_score) > Number(current.contact_rank_score)) {
      byCompany.set(companyKey, prospect);
    }
  });
  return [...byCompany.values()];
}

function normalizeSuppressionRow(row) {
  const email = normalizeEmail(firstValue(row.email, row.contact_email, row.value));
  const domain = normalizeDomain(firstValue(row.domain, row.company_domain));
  return {
    email,
    domain,
    reason: cleanText(firstValue(row.reason, row.suppression_reason, row.status, 'suppressed')),
    optedOutAt: cleanText(firstValue(row.opted_out_at, row.created_at, row.date)),
  };
}

function suppressionJsonRows(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Suppression JSON must contain an array of suppression records.');
  }
  if ([...SUPPRESSION_IDENTITY_FIELDS].some((field) => Object.hasOwn(parsed, field))) return [parsed];
  for (const key of ['suppressions', 'records', 'items', 'results']) {
    if (Array.isArray(parsed[key])) return parsed[key];
  }
  if (parsed.data !== undefined) return suppressionJsonRows(parsed.data);
  throw new Error('Suppression JSON must be an array or a supported records envelope.');
}

function isValidSuppressionEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

function isValidSuppressionDomain(value) {
  const domain = normalizeDomain(value);
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/i.test(domain);
}

function validateSuppressionRows(rows, sourceLabel) {
  if (!Array.isArray(rows)) throw new Error(`Malformed suppression ${sourceLabel}: records must be an array.`);
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`Malformed suppression ${sourceLabel}: row ${index + 1} must be an object.`);
    }
    const emailValue = firstValue(...SUPPRESSION_EMAIL_FIELDS.map((field) => row[field]));
    const domainValue = firstValue(...SUPPRESSION_DOMAIN_FIELDS.map((field) => row[field]));
    if (!emailValue && !domainValue) {
      throw new Error(`Malformed suppression ${sourceLabel}: row ${index + 1} needs an email or domain.`);
    }
    if (emailValue && !isValidSuppressionEmail(emailValue)) {
      throw new Error(`Malformed suppression ${sourceLabel}: row ${index + 1} has an invalid email.`);
    }
    if (domainValue && !isValidSuppressionDomain(domainValue)) {
      throw new Error(`Malformed suppression ${sourceLabel}: row ${index + 1} has an invalid domain.`);
    }
    return row;
  });
}

export async function loadSuppression(filePath, { allowMissing = false } = {}) {
  if (!filePath) {
    if (allowMissing) return { emails: new Map(), domains: new Map() };
    throw new Error('Suppression file path is required. Pass allowMissing only for an intentional dry run.');
  }
  let contents;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' && allowMissing) return { emails: new Map(), domains: new Map() };
    if (error?.code === 'ENOENT') {
      throw new Error(`Suppression file not found: ${filePath}. Pass allowMissing only for an intentional dry run.`, { cause: error });
    }
    throw error;
  }
  const extension = extname(filePath).toLowerCase();
  let rows;
  if (extension === '.json') {
    let parsed;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error(`Malformed suppression JSON: ${error.message}`, { cause: error });
    }
    rows = validateSuppressionRows(suppressionJsonRows(parsed), 'JSON');
  } else {
    const parsed = Papa.parse(contents, {
      delimiter: ',',
      header: true,
      skipEmptyLines: true,
      transformHeader: (header) => cleanText(header).replace(/^\uFEFF/, '').toLowerCase(),
    });
    if (parsed.errors.length) {
      const details = parsed.errors.map((error) => `${error.code}: ${error.message}`).join('; ');
      throw new Error(`Malformed suppression CSV: ${details}`);
    }
    if (parsed.meta.renamedHeaders && Object.keys(parsed.meta.renamedHeaders).length) {
      throw new Error('Malformed suppression CSV: duplicate headers are not allowed.');
    }
    const fields = parsed.meta.fields || [];
    if (!fields.some((field) => SUPPRESSION_IDENTITY_FIELDS.has(field))) {
      throw new Error('Malformed suppression CSV: expected an email/contact_email/value or domain/company_domain column.');
    }
    rows = validateSuppressionRows(parsed.data, 'CSV');
  }
  const emails = new Map();
  const domains = new Map();
  for (const raw of rows) {
    const row = normalizeSuppressionRow(raw);
    if (row.email) emails.set(row.email, row);
    if (row.domain) domains.set(row.domain, row);
  }
  return { emails, domains };
}

function findSuppressedDomain(domain, domainSuppressions) {
  const normalized = normalizeDomain(domain);
  if (!normalized) return undefined;
  const labels = normalized.split('.');
  for (let index = 0; index < labels.length - 1; index += 1) {
    const match = domainSuppressions.get(labels.slice(index).join('.'));
    if (match) return match;
  }
  return undefined;
}

export function findSuppressionMatch(record, suppression) {
  if (!(suppression?.emails instanceof Map) || !(suppression?.domains instanceof Map)) {
    throw new Error('A loaded suppression index is required before prospect evaluation.');
  }
  const email = normalizeEmail(record.email);
  const exact = email ? suppression.emails.get(email) : undefined;
  if (exact) return { ...exact, source: 'email' };
  const companyDomain = normalizeDomain(record.company_domain);
  const messageDomain = emailDomain(email);
  const companyMatch = findSuppressedDomain(companyDomain, suppression.domains);
  if (companyMatch) return { ...companyMatch, source: 'company_domain' };
  const emailDomainMatch = findSuppressedDomain(messageDomain, suppression.domains);
  if (emailDomainMatch) return { ...emailDomainMatch, source: 'email_domain' };
  return null;
}

export function evaluateProspect(record, suppression) {
  if (!(suppression?.emails instanceof Map) || !(suppression?.domains instanceof Map)) {
    throw new Error('A loaded suppression index is required before prospect evaluation.');
  }
  const prospect = { ...record };
  const review = [];
  const rejection = [];
  const suppressed = findSuppressionMatch(prospect, suppression);

  if (hasSuppressionStatus(prospect.suppression_status) || prospect.opted_out_at) {
    prospect.suppression_status = prospect.suppression_status || 'suppressed';
    prospect.suppression_reason = prospect.suppression_reason || 'imported opt-out or suppression';
    rejection.push('imported opt-out or suppression');
  }

  if (suppressed) {
    prospect.suppression_status = 'suppressed';
    prospect.suppression_reason = prospect.suppression_reason || suppressed.reason;
    prospect.opted_out_at = prospect.opted_out_at || suppressed.optedOutAt;
    rejection.push('suppression list match');
  }
  if (!prospect.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(prospect.email)) review.push('missing or malformed email');
  if (!prospect.company_domain) review.push('missing company domain');
  if (prospect.email && prospect.company_domain && !isCompanyDomainEmail(prospect.email, prospect.company_domain)) {
    review.push('email domain does not match current employer');
  }
  if (!prospect.current_employer_confirmed) review.push('current employer not confirmed');
  if (!hasSourceEvidence(prospect.residential_evidence, prospect.residential_evidence_url)) {
    review.push('residential service evidence required');
  }
  if (!hasSourceEvidence(prospect.d2d_evidence, prospect.d2d_evidence_url)) {
    review.push('D2D/canvassing evidence required');
  }
  if (prospect.is_role) review.push('generic role mailbox');
  if (prospect.is_free_provider) rejection.push('personal/free mailbox provider');
  if (prospect.is_disposable) rejection.push('disposable mailbox');
  if (prospect.is_accept_all) review.push('accept-all/catch-all mailbox');
  if (Number(prospect.contact_rank_score) < 70) review.push('contact title below decision-maker threshold');
  const providerStatus = cleanText(prospect.provider_email_status).toLowerCase().replace(/[\s-]+/g, '_');
  if (!['verified', 'valid', 'likely_to_engage'].includes(providerStatus)) {
    review.push('Apollo/Hunter provider status is not verified');
  }

  const verification = normalizeVerificationStatus(prospect.verification_status);
  prospect.verification_status = verification;
  if (verification === 'undeliverable') rejection.push('independent verifier rejected address');
  else if (verification === 'suppressed') rejection.push('verifier suppression');
  else if (verification !== 'deliverable') review.push('independent verification required');

  if (rejection.length) {
    prospect.status = 'rejected';
    prospect.ready_to_contact = false;
    prospect.review_notes = [...new Set([...rejection, ...review])].join('; ');
  } else if (review.length) {
    prospect.status = 'review';
    prospect.ready_to_contact = false;
    prospect.review_notes = [...new Set(review)].join('; ');
  } else {
    prospect.status = 'ready';
    prospect.ready_to_contact = true;
    prospect.review_notes = '';
  }
  return prospect;
}

export function splitProspects(records, suppression) {
  const evaluated = records.map((record) => evaluateProspect(record, suppression));
  return {
    all: evaluated,
    ready: evaluated.filter((record) => record.status === 'ready'),
    review: evaluated.filter((record) => record.status === 'review'),
    rejected: evaluated.filter((record) => record.status === 'rejected'),
  };
}

export async function readInput(filePath) {
  const contents = await readFile(filePath, 'utf8');
  if (extname(filePath).toLowerCase() === '.json') return extractRecords(JSON.parse(contents));
  const parsed = Papa.parse(contents, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => cleanText(header).replace(/^\uFEFF/, '').toLowerCase(),
  });
  if (parsed.errors.length) {
    const details = parsed.errors.map((error) => `${error.code}: ${error.message}`).join('; ');
    throw new Error(`Malformed prospect CSV: ${details}`);
  }
  if (parsed.meta.renamedHeaders && Object.keys(parsed.meta.renamedHeaders).length) {
    throw new Error('Malformed prospect CSV: duplicate headers are not allowed.');
  }
  const fields = new Set(parsed.meta.fields || []);
  const companyFields = ['company_domain', 'domain', 'company_name', 'organization_name', 'source_company_id', 'target_company_id'];
  const contactFields = ['email', 'work_email', 'contact_email', 'source_person_id', 'person_id', 'id'];
  if (!companyFields.some((field) => fields.has(field)) || !contactFields.some((field) => fields.has(field))) {
    throw new Error('Malformed prospect CSV: expected at least one company identity column and one contact identity/email column.');
  }
  return parsed.data;
}

export async function writeCsv(filePath, rows) {
  await mkdir(dirname(filePath), { recursive: true });
  const normalizedRows = rows.map((row) => Object.fromEntries(
    OUTPUT_COLUMNS.map((column) => [column, row[column] ?? '']),
  ));
  await writeFile(filePath, Papa.unparse(normalizedRows, {
    columns: OUTPUT_COLUMNS,
    escapeFormulae: true,
    newline: '\n',
  }) + '\n', 'utf8');
}

export async function writeJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function resolveOutputPath(baseDir, fileName) {
  return resolve(baseDir, fileName);
}
