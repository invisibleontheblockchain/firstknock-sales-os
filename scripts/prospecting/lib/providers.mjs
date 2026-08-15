import { requestJson } from './http.mjs';
import { normalizeDomain, normalizeEmail, rankDecisionMaker } from './pipeline.mjs';

function appendMany(params, key, values = []) {
  for (const value of values) params.append(key, String(value));
}

function apiUrl(baseUrl, path, query = {}) {
  const url = new URL(`${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) appendMany(url.searchParams, key, value);
    else url.searchParams.set(key, String(value));
  }
  return url;
}

function arrayFrom(body, keys) {
  for (const key of keys) {
    if (Array.isArray(body?.[key])) return body[key];
    if (Array.isArray(body?.data?.[key])) return body.data[key];
  }
  return [];
}

function creditsConsumedFrom(body) {
  const values = [
    body?.credits_consumed,
    body?.meta?.credits_consumed,
    body?.usage?.credits_consumed,
  ];
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const credits = Number(value);
    if (Number.isFinite(credits) && credits >= 0) return credits;
  }
  return null;
}

function completeCredits(requestCount, reportedCount, everyResponseReported) {
  if (requestCount === 0) return 0;
  return everyResponseReported ? reportedCount : null;
}

function positiveInteger(value, fallback, name, maximum = Number.MAX_SAFE_INTEGER) {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return resolved;
}

export async function searchApolloOrganizations({
  apiKey,
  baseUrl = 'https://api.apollo.io/api/v1',
  markets,
  employeeRanges,
  keywords,
  maxCompanies,
  fetchImpl,
  onRequest,
}) {
  if (!apiKey) throw new Error('APOLLO_API_KEY is required for direct API discovery. Use Apollo MCP export ingestion when no API key is stored locally.');
  const organizations = [];
  const seen = new Set();
  let requestCount = 0;
  let reportedCreditsConsumed = 0;
  let everyResponseReportedCredits = true;
  for (const market of markets) {
    if (organizations.length >= maxCompanies) break;
    onRequest?.({ provider: 'apollo', operation: 'organization_search', estimatedCredits: 1, market });
    const url = apiUrl(baseUrl, 'mixed_companies/search', {
      'organization_locations[]': [market],
      'organization_num_employees_ranges[]': employeeRanges,
      'q_organization_keyword_tags[]': keywords,
      page: 1,
      per_page: Math.min(100, maxCompanies - organizations.length),
    });
    requestCount += 1;
    const { body } = await requestJson(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'x-api-key': apiKey },
      body: '{}',
    }, {
      fetchImpl,
      retries: 0,
      retryNetworkErrors: false,
    });
    const reportedCredits = creditsConsumedFrom(body);
    if (reportedCredits === null) everyResponseReportedCredits = false;
    else reportedCreditsConsumed += reportedCredits;
    for (const organization of arrayFrom(body, ['organizations', 'accounts'])) {
      const domain = normalizeDomain(organization.primary_domain || organization.domain || organization.website_url);
      const id = organization.id || organization.organization_id;
      const key = domain || id;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      organizations.push(organization);
      if (organizations.length >= maxCompanies) break;
    }
  }
  return {
    organizations,
    usage: {
      reservedCredits: requestCount,
      creditsConsumed: completeCredits(requestCount, reportedCreditsConsumed, everyResponseReportedCredits),
      reportedCreditsConsumed,
      requestCount,
      pageCount: requestCount,
    },
  };
}

export async function searchApolloPeople({
  apiKey,
  organizations,
  baseUrl = 'https://api.apollo.io/api/v1',
  titles,
  seniorities,
  fetchImpl,
  batchSize = 20,
  perPage = 100,
  maxPagesPerBatch = 10,
  minRankScore = 70,
}) {
  if (!apiKey) throw new Error('APOLLO_API_KEY is required for direct API people search.');
  const safeBatchSize = positiveInteger(batchSize, 20, 'batchSize', 100);
  const safePerPage = positiveInteger(perPage, 100, 'perPage', 100);
  const safePageCap = positiveInteger(maxPagesPerBatch, 10, 'maxPagesPerBatch', 100);
  const safeMinRankScore = Number(minRankScore);
  if (!Number.isFinite(safeMinRankScore) || safeMinRankScore < 0 || safeMinRankScore > 100) {
    throw new Error('minRankScore must be a number between 0 and 100.');
  }
  const organizationById = new Map(organizations
    .map((org) => [org.id || org.organization_id, org])
    .filter(([id]) => Boolean(id))
    .map(([id, org]) => [String(id), org]));
  const bestByOrganization = new Map();
  let requestCount = 0;
  let batchCount = 0;
  let pageCapReached = false;
  for (let index = 0; index < organizations.length; index += safeBatchSize) {
    const batch = organizations.slice(index, index + safeBatchSize);
    const ids = batch.map((org) => org.id || org.organization_id).filter(Boolean);
    if (ids.length === 0) continue;
    batchCount += 1;
    const targetIds = new Set(ids.map(String));
    let reachedEnd = false;
    for (let page = 1; page <= safePageCap; page += 1) {
      const url = apiUrl(baseUrl, 'mixed_people/api_search', {
        'organization_ids[]': ids,
        'person_titles[]': titles,
        'person_seniorities[]': seniorities,
        'contact_email_status[]': ['verified'],
        include_similar_titles: true,
        page,
        per_page: safePerPage,
      });
      requestCount += 1;
      const { body } = await requestJson(url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'x-api-key': apiKey },
        body: '{}',
      }, { fetchImpl });
      const people = arrayFrom(body, ['people', 'contacts']);
      for (const person of people) {
        const organizationId = String(person.organization_id || person.organization?.id || '');
        if (!targetIds.has(organizationId)) continue;
        const organization = organizationById.get(organizationId);
        if (!organization) continue;
        const rank = rankDecisionMaker(person.title, organization.estimated_num_employees);
        if (rank.score < safeMinRankScore) continue;
        const current = bestByOrganization.get(organizationId);
        if (!current || rank.score > current.rank.score) bestByOrganization.set(organizationId, { person, organization, rank });
      }
      if ([...targetIds].every((organizationId) => bestByOrganization.has(organizationId))) {
        reachedEnd = true;
        break;
      }
      const totalEntries = Number(body?.total_entries ?? body?.pagination?.total_entries);
      const exhausted = people.length === 0
        || (Number.isFinite(totalEntries)
          ? page * safePerPage >= totalEntries
          : people.length < safePerPage);
      if (exhausted) {
        reachedEnd = true;
        break;
      }
    }
    if (!reachedEnd && [...targetIds].some((organizationId) => !bestByOrganization.has(organizationId))) {
      pageCapReached = true;
    }
  }
  const requestedOrganizationIds = [...organizationById.keys()].filter(Boolean);
  return {
    candidates: [...bestByOrganization.values()],
    search: {
      organizationsRequested: requestedOrganizationIds.length,
      organizationsWithCandidates: bestByOrganization.size,
      organizationsWithoutCandidates: requestedOrganizationIds.filter((id) => !bestByOrganization.has(id)),
      batchCount,
      pageCount: requestCount,
      maxPagesPerBatch: safePageCap,
      pageCapReached,
    },
    usage: {
      reservedCredits: 0,
      creditsConsumed: 0,
      requestCount,
      pageCount: requestCount,
    },
  };
}

export async function enrichApolloPeople({
  apiKey,
  candidates,
  baseUrl = 'https://api.apollo.io/api/v1',
  fetchImpl,
  maxCredits,
}) {
  if (!apiKey) throw new Error('APOLLO_API_KEY is required for direct API enrichment.');
  if (!Number.isInteger(maxCredits) || maxCredits < 0) {
    throw new Error('maxCredits must be an explicit non-negative integer for Apollo enrichment.');
  }
  if (candidates.length > maxCredits) {
    throw new Error(`Refusing to enrich ${candidates.length} people because --max-credits is ${maxCredits}.`);
  }
  const enriched = [];
  let requestCount = 0;
  let reportedCreditsConsumed = 0;
  let everyResponseReportedCredits = true;
  for (let index = 0; index < candidates.length; index += 10) {
    const batch = candidates.slice(index, index + 10);
    const details = batch.map(({ person }) => ({ id: person.id || person.person_id }));
    if (details.some(({ id }) => !id)) throw new Error('Apollo enrichment requires a person id for every candidate.');
    const url = apiUrl(baseUrl, 'people/bulk_match', {
      reveal_personal_emails: false,
      reveal_phone_number: false,
    });
    requestCount += 1;
    const { body } = await requestJson(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ details }),
    }, {
      fetchImpl,
      retries: 0,
      retryNetworkErrors: false,
    });
    const reportedCredits = creditsConsumedFrom(body);
    if (reportedCredits === null) everyResponseReportedCredits = false;
    else reportedCreditsConsumed += reportedCredits;
    enriched.push(...arrayFrom(body, ['matches', 'people']));
  }
  return {
    people: enriched,
    usage: {
      reservedCredits: candidates.length,
      creditsConsumed: completeCredits(requestCount, reportedCreditsConsumed, everyResponseReportedCredits),
      reportedCreditsConsumed,
      requestCount,
      batchCount: requestCount,
    },
  };
}

const HUNTER_RETRYABLE_STATUS = new Set([403, 408, 425, 500, 502, 503, 504]);

function verifierTimestamp() {
  return new Date().toISOString();
}

function hunterClaimedEmail(error) {
  if (error?.status !== 451) return false;
  const body = error?.body || {};
  const errors = Array.isArray(body.errors) ? body.errors : [];
  const identifiers = [
    body.id,
    body.error,
    body.error_code,
    ...errors.flatMap((item) => [item?.id, item?.error, item?.error_code]),
  ].filter(Boolean).map((value) => String(value).toLowerCase());
  return identifiers.length === 0 || identifiers.some((value) => value.includes('claimed_email'));
}

function hunterPollDelay(response, attempt, fallbackMs, maximumMs) {
  const retryAfter = response?.headers?.get?.('retry-after');
  if (retryAfter && /^\d+$/.test(retryAfter)) {
    return Math.min(maximumMs, Number(retryAfter) * 1000);
  }
  return Math.min(maximumMs, fallbackMs * (2 ** attempt));
}

function hunterVerification(data) {
  const status = String(data.status || data.result || '').toLowerCase();
  let verificationStatus = 'unknown';
  if (['valid', 'deliverable'].includes(status)) verificationStatus = 'deliverable';
  else if (['accept_all', 'risky', 'webmail'].includes(status)) verificationStatus = 'risky';
  else if (['invalid', 'undeliverable', 'disposable'].includes(status)) verificationStatus = 'undeliverable';
  return {
    verifier_provider: 'hunter',
    verification_status: verificationStatus,
    verification_reason: data.sub_status || data.reason || status,
    verification_score: data.score ?? '',
    is_accept_all: status === 'accept_all' || Boolean(data.accept_all),
    is_role: Boolean(data.role),
    is_disposable: status === 'disposable' || Boolean(data.disposable),
    is_free_provider: status === 'webmail' || Boolean(data.webmail),
    verified_at: verifierTimestamp(),
  };
}

export async function verifyWithHunter(email, {
  apiKey,
  baseUrl = 'https://api.hunter.io/v2',
  fetchImpl,
  requestRetries = 2,
  maxPolls = 3,
  pollDelayMs = 1_000,
  maxPollDelayMs = 10_000,
  delayImpl,
  sleepImpl,
} = {}) {
  if (!apiKey) return { verifier_provider: 'none', verification_status: 'not_checked', verification_reason: 'HUNTER_API_KEY not configured' };
  const url = apiUrl(baseUrl, 'email-verifier', { email: normalizeEmail(email) });
  const safeRequestRetries = Number.isInteger(requestRetries) && requestRetries >= 0 ? requestRetries : 2;
  const safeMaxPolls = Number.isInteger(maxPolls) && maxPolls >= 0 ? maxPolls : 3;
  const wait = sleepImpl || ((delayMs) => new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs)));
  for (let pollAttempt = 0; ; pollAttempt += 1) {
    let result;
    try {
      result = await requestJson(url, {
        headers: { accept: 'application/json', 'x-api-key': apiKey },
      }, {
        fetchImpl,
        retries: safeRequestRetries,
        retryableStatuses: HUNTER_RETRYABLE_STATUS,
        terminalStatuses: new Set([429]),
        delayImpl,
      });
    } catch (error) {
      if (!hunterClaimedEmail(error)) throw error;
      const suppressedAt = verifierTimestamp();
      return {
        verifier_provider: 'hunter',
        verification_status: 'suppressed',
        verification_reason: 'claimed_email',
        verification_score: '',
        suppression_status: 'suppressed',
        suppression_reason: 'Hunter claimed_email privacy request',
        opted_out_at: suppressedAt,
        ready_to_contact: false,
        verified_at: suppressedAt,
      };
    }
    const { response, body } = result;
    if (response.status === 222) {
      return {
        verifier_provider: 'hunter',
        verification_status: 'unknown',
        verification_reason: 'remote_smtp_unexpected_response',
        verification_score: '',
      };
    }
    if (response.status !== 202) return hunterVerification(body?.data || body || {});
    if (pollAttempt >= safeMaxPolls) {
      return {
        verifier_provider: 'hunter',
        verification_status: 'unknown',
        verification_reason: 'verification_still_in_progress',
        verification_score: '',
      };
    }
    const delayMs = hunterPollDelay(response, pollAttempt, Math.max(0, Number(pollDelayMs)), Math.max(0, Number(maxPollDelayMs)));
    await wait(delayMs);
  }
}

export async function verifyWithMillionVerifier(email, {
  apiKey,
  baseUrl = 'https://api.millionverifier.com/api/v3',
  fetchImpl,
  requestRetries = 0,
} = {}) {
  if (!apiKey) return { verifier_provider: 'none', verification_status: 'not_checked', verification_reason: 'MILLIONVERIFIER_API_KEY not configured' };
  const url = apiUrl(baseUrl, '', { api: apiKey, email: normalizeEmail(email), timeout: 10 });
  const { body } = await requestJson(url, { headers: { accept: 'application/json' } }, {
    fetchImpl,
    retries: Number.isInteger(requestRetries) && requestRetries >= 0 ? requestRetries : 0,
  });
  const result = String(body?.result || '').toLowerCase();
  return {
    verifier_provider: 'millionverifier',
    verification_status: result === 'ok' ? 'deliverable' : result === 'catch_all' ? 'risky' : ['invalid', 'disposable'].includes(result) ? 'undeliverable' : 'unknown',
    verification_reason: body?.subresult || body?.error || result,
    verification_score: body?.quality || '',
    is_accept_all: result === 'catch_all',
    is_role: Boolean(body?.role),
    is_disposable: result === 'disposable',
    is_free_provider: Boolean(body?.free),
    verified_at: new Date().toISOString(),
  };
}

export async function verifyRecords(records, options = {}) {
  const provider = options.provider || 'none';
  const maxCalls = options.maxCalls === undefined ? Number.POSITIVE_INFINITY : Number(options.maxCalls);
  if (maxCalls !== Number.POSITIVE_INFINITY && (!Number.isInteger(maxCalls) || maxCalls < 0)) {
    throw new Error('maxCalls must be a non-negative integer when provided.');
  }
  const providerConfigured = provider === 'hunter'
    ? Boolean(options.hunter?.apiKey)
    : provider === 'millionverifier'
      ? Boolean(options.millionverifier?.apiKey)
      : false;
  const plannedCalls = providerConfigured ? records.filter((record) => Boolean(record.email)).length : 0;
  if (plannedCalls > maxCalls) {
    const error = new Error(`Refusing to submit ${plannedCalls} verification addresses because maxCalls is ${maxCalls}.`);
    error.code = 'VERIFIER_CALL_CAP_EXCEEDED';
    error.plannedCalls = plannedCalls;
    error.maxCalls = maxCalls;
    throw error;
  }
  const verified = [];
  let callsUsed = 0;
  for (const record of records) {
    if (!record.email) {
      verified.push(record);
      continue;
    }
    let verification;
    if (provider === 'hunter') {
      if (providerConfigured && callsUsed >= maxCalls) throw new Error(`Verifier maxCalls limit of ${maxCalls} would be exceeded.`);
      if (providerConfigured) callsUsed += 1;
      verification = await verifyWithHunter(record.email, options.hunter);
    } else if (provider === 'millionverifier') {
      if (providerConfigured && callsUsed >= maxCalls) throw new Error(`Verifier maxCalls limit of ${maxCalls} would be exceeded.`);
      if (providerConfigured) callsUsed += 1;
      verification = await verifyWithMillionVerifier(record.email, options.millionverifier);
    }
    else verification = { verifier_provider: 'none', verification_status: 'not_checked', verification_reason: 'independent verifier disabled' };
    verified.push({ ...record, ...verification });
  }
  return verified;
}
