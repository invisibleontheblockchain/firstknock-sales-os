#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import {
  loadSuppression,
  normalizeProspect,
  readInput,
  selectOneContactPerCompany,
  splitProspects,
  writeCsv,
  writeJson,
} from './lib/pipeline.mjs';
import {
  enrichApolloPeople,
  searchApolloOrganizations,
  searchApolloPeople,
  verifyRecords,
} from './lib/providers.mjs';
import {
  createVerificationPlan,
  mergeVerifiedRecords,
} from './lib/run-safety.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = resolve(scriptDir, 'config/default.json');
const defaultEnvPath = resolve(scriptDir, '.env.prospecting');
const defaultOutputRoot = resolve(scriptDir, 'output');

function usage() {
  return `
FirstKnock compliant prospecting pipeline

Usage:
  npm run prospects -- ingest --input <apollo-export.json|csv> [options]
  npm run prospects -- discover --enrich --max-credits <N> --confirm-credit-spend <N> [options]
  npm run prospects -- dry-run

Commands:
  ingest    Normalize an Apollo MCP/API export, verify it, apply suppression, and export CSVs.
  discover  Use Apollo's official REST API for unattended company/contact discovery.
  dry-run   Exercise the pipeline with local fixtures and no vendor calls.

Options:
  --input <path>                  Input JSON/CSV for ingest.
  --config <path>                 Search configuration JSON.
  --env <path>                    Dedicated env file (default scripts/prospecting/.env.prospecting).
  --output-dir <path>             Private output directory.
  --suppression <path>            Global suppression CSV/JSON.
  --verifier <none|hunter|millionverifier>
  --max-companies <N>             Hard company cap.
  --max-credits <N>               Hard Apollo credit cap for discover.
  --confirm-credit-spend <N>      Must exactly match --max-credits before paid API calls.
  --max-verifications <N>         Hard cap on distinct addresses submitted to a verifier.
  --confirm-verification-spend <N> Must exactly match --max-verifications.
  --enrich                        Reveal one ranked work email per selected company.
  --help                          Show this message.

This tool never sends email. PCT, NPMA, LinkedIn, and Google Maps scraping are intentionally absent.
`;
}

function numeric(value, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`Expected a non-negative number, received: ${value}`);
  return Math.floor(number);
}

function runId() {
  const timestamp = new Date().toISOString().replace(/[-:.]/g, '');
  return `${timestamp}-${randomUUID()}`;
}

async function createRunDirectory(outputRoot, command) {
  await mkdir(outputRoot, { recursive: true });
  const outputDir = resolve(outputRoot, `${command}-${runId()}`);
  await mkdir(outputDir, { recursive: false });
  return outputDir;
}

async function loadConfig(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function attachOrganization(enriched, rankedCandidates) {
  const candidateByPersonId = new Map(rankedCandidates.map((candidate) => [
    String(candidate.person.id || candidate.person.person_id || ''),
    candidate,
  ]));
  return enriched.map((person) => {
    const candidate = candidateByPersonId.get(String(person.id || person.person_id || ''));
    const personOrganizationId = String(
      person.organization_id
      || person.organization?.id
      || '',
    );
    const targetOrganization = candidate?.organization || {};
    const targetOrganizationId = String(
      targetOrganization.id
      || targetOrganization.organization_id
      || '',
    );
    return {
      ...person,
      company_name: targetOrganization.name || '',
      company_domain: targetOrganization.primary_domain || targetOrganization.domain || '',
      company_website: targetOrganization.website_url || targetOrganization.website || '',
      organization: targetOrganization,
      source_company_id: targetOrganizationId,
      target_company_id: targetOrganizationId,
      target_company_domain: targetOrganization.primary_domain || targetOrganization.domain || '',
      person_organization_id: personOrganizationId,
      person_organization_domain: person.organization_primary_domain
        || person.organization?.primary_domain
        || person.organization?.domain
        || '',
      company_source_provider: 'apollo',
      email_source_provider: 'apollo',
      company_fetched_at: new Date().toISOString(),
    };
  });
}

async function writeRunOutputs(records, { outputDir, suppression, metadata }) {
  const split = splitProspects(selectOneContactPerCompany(records), suppression);
  await Promise.all([
    writeCsv(resolve(outputDir, 'prospects.all.csv'), split.all),
    writeCsv(resolve(outputDir, 'prospects.ready.csv'), split.ready),
    writeCsv(resolve(outputDir, 'prospects.review.csv'), split.review),
    writeCsv(resolve(outputDir, 'prospects.rejected.csv'), split.rejected),
    writeJson(resolve(outputDir, 'run-report.json'), {
      generated_at: new Date().toISOString(),
      counts: {
        input: records.length,
        unique: split.all.length,
        ready: split.ready.length,
        review: split.review.length,
        rejected: split.rejected.length,
      },
      ...metadata,
    }),
  ]);
  return split;
}

function verifierSettings(provider) {
  if (provider === 'hunter') {
    return {
      apiKey: process.env.HUNTER_API_KEY,
      baseUrl: process.env.HUNTER_BASE_URL,
    };
  }
  if (provider === 'millionverifier') {
    return {
      apiKey: process.env.MILLIONVERIFIER_API_KEY,
      baseUrl: process.env.MILLIONVERIFIER_BASE_URL,
    };
  }
  return {};
}

async function verifyApprovedRecords(records, {
  provider,
  suppression,
  maxCalls,
  confirmedCalls,
}) {
  const plan = createVerificationPlan(records, suppression, {
    provider,
    maxCalls,
    confirmedCalls,
  });
  if (!plan.selectedIndexes.length) {
    return {
      records,
      verification: {
        provider,
        eligible: plan.eligibleCount,
        approved: 0,
        deferred: plan.deferredCount,
        addresses_submitted: 0,
        interlock_unit: 'distinct_email_address',
      },
    };
  }

  const settings = verifierSettings(provider);
  if (!settings.apiKey) {
    const variable = provider === 'hunter' ? 'HUNTER_API_KEY' : 'MILLIONVERIFIER_API_KEY';
    throw new Error(`${variable} is required when --verifier ${provider} is enabled.`);
  }
  const selected = plan.selectedIndexes.map((index) => records[index]);
  const verified = await verifyRecords(selected, {
    provider,
    maxCalls: selected.length,
    hunter: provider === 'hunter' ? settings : undefined,
    millionverifier: provider === 'millionverifier' ? settings : undefined,
  });
  return {
    records: mergeVerifiedRecords(records, plan.selectedIndexes, verified),
    verification: {
      provider,
      eligible: plan.eligibleCount,
      approved: selected.length,
      deferred: plan.deferredCount,
      addresses_submitted: selected.length,
      interlock_unit: 'distinct_email_address',
    },
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      input: { type: 'string' },
      config: { type: 'string', default: defaultConfigPath },
      env: { type: 'string', default: defaultEnvPath },
      'output-dir': { type: 'string' },
      suppression: { type: 'string' },
      verifier: { type: 'string' },
      'max-companies': { type: 'string' },
      'max-credits': { type: 'string' },
      'confirm-credit-spend': { type: 'string' },
      'max-verifications': { type: 'string' },
      'confirm-verification-spend': { type: 'string' },
      enrich: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(usage());
    return;
  }

  const command = positionals[0] || 'dry-run';
  const config = await loadConfig(resolve(values.config));
  dotenv.config({ path: resolve(values.env), override: false, quiet: true });
  const outputRoot = resolve(values['output-dir'] || defaultOutputRoot);
  const suppressionPath = resolve(values.suppression || config.suppressionFile || resolve(defaultOutputRoot, 'suppression.csv'));
  const verifier = values.verifier || process.env.EMAIL_VERIFIER || config.verifier || 'none';
  if (!['none', 'hunter', 'millionverifier'].includes(verifier)) throw new Error(`Unsupported verifier: ${verifier}`);
  const maxVerifications = numeric(values['max-verifications'], 0);
  const confirmedVerifications = numeric(values['confirm-verification-spend'], -1);

  if (command === 'dry-run') {
    const suppression = await loadSuppression(suppressionPath, { allowMissing: true });
    const fixture = resolve(scriptDir, 'fixtures/apollo-enriched-sample.json');
    const raw = await readInput(fixture);
    const normalized = raw.map((record) => normalizeProspect(record, { verifierProvider: 'fixture' }));
    const outputDir = await createRunDirectory(outputRoot, command);
    const split = await writeRunOutputs(normalized, {
      outputDir,
      suppression,
      metadata: { mode: 'dry-run', vendor_addresses_submitted: 0, source: fixture },
    });
    process.stdout.write(`Dry run complete: ${split.ready.length} ready, ${split.review.length} review, ${split.rejected.length} rejected.\n${outputDir}\n`);
    return;
  }

  if (command === 'ingest') {
    if (!values.input) throw new Error('--input is required for ingest.');
    const suppression = await loadSuppression(suppressionPath);
    const raw = await readInput(resolve(values.input));
    const normalized = selectOneContactPerCompany(raw);
    const verified = await verifyApprovedRecords(normalized, {
      provider: verifier,
      suppression,
      maxCalls: maxVerifications,
      confirmedCalls: confirmedVerifications,
    });
    const outputDir = await createRunDirectory(outputRoot, command);
    const split = await writeRunOutputs(verified.records, {
      outputDir,
      suppression,
      metadata: {
        mode: 'ingest',
        vendor_addresses_submitted: verified.verification.addresses_submitted,
        verification: verified.verification,
        source: resolve(values.input),
      },
    });
    process.stdout.write(`Ingest complete: ${split.ready.length} ready, ${split.review.length} review, ${split.rejected.length} rejected.\n${outputDir}\n`);
    return;
  }

  if (command !== 'discover') throw new Error(`Unknown command: ${command}`);
  const suppression = await loadSuppression(suppressionPath);

  const maxCompanies = numeric(values['max-companies'], config.maxCompanies);
  const maxCredits = numeric(values['max-credits'], 0);
  const confirmedCredits = numeric(values['confirm-credit-spend'], -1);
  if (maxCredits <= 0 || confirmedCredits !== maxCredits) {
    throw new Error('Paid Apollo discovery is locked. Set --max-credits N and --confirm-credit-spend N to the same positive number.');
  }
  const requiredSearchCredits = config.markets.length;
  if (maxCredits < requiredSearchCredits) {
    throw new Error(`The configured ${config.markets.length} market searches require up to ${requiredSearchCredits} credits.`);
  }

  let reservedApolloCredits = 0;
  const organizationResult = await searchApolloOrganizations({
    apiKey: process.env.APOLLO_API_KEY,
    baseUrl: process.env.APOLLO_BASE_URL,
    markets: config.markets,
    employeeRanges: config.employeeRanges,
    keywords: config.companyKeywords,
    maxCompanies,
    onRequest: ({ estimatedCredits: credits }) => {
      if (reservedApolloCredits + credits > maxCredits) {
        throw new Error(`Apollo credit cap of ${maxCredits} would be exceeded before organization search.`);
      }
      reservedApolloCredits += credits;
    },
  });
  const organizationCreditsAgainstCap = organizationResult.usage.creditsConsumed
    ?? organizationResult.usage.reservedCredits;
  if (organizationCreditsAgainstCap > maxCredits) {
    throw new Error(`Apollo reported ${organizationCreditsAgainstCap} organization-search credits against a confirmed cap of ${maxCredits}; no further provider calls will be made.`);
  }
  let apolloCreditsAgainstCap = organizationCreditsAgainstCap;
  const organizations = organizationResult.organizations;
  const peopleResult = await searchApolloPeople({
    apiKey: process.env.APOLLO_API_KEY,
    baseUrl: process.env.APOLLO_BASE_URL,
    organizations,
    titles: config.decisionMakerTitles,
    seniorities: config.decisionMakerSeniorities,
  });
  const rankedCandidates = peopleResult.candidates;

  let normalized;
  let enrichmentUsage = {
    reservedCredits: 0,
    creditsConsumed: 0,
    reportedCreditsConsumed: 0,
    requestCount: 0,
  };
  let enrichmentDeferred = 0;
  if (values.enrich) {
    const enrichmentBudget = maxCredits - apolloCreditsAgainstCap;
    const selected = rankedCandidates.slice(0, Math.max(0, enrichmentBudget));
    enrichmentDeferred = Math.max(0, rankedCandidates.length - selected.length);
    const enrichmentResult = await enrichApolloPeople({
      apiKey: process.env.APOLLO_API_KEY,
      baseUrl: process.env.APOLLO_BASE_URL,
      candidates: selected,
      maxCredits: enrichmentBudget,
    });
    reservedApolloCredits += enrichmentResult.usage.reservedCredits;
    enrichmentUsage = enrichmentResult.usage;
    apolloCreditsAgainstCap += enrichmentUsage.creditsConsumed ?? enrichmentUsage.reservedCredits;
    if (apolloCreditsAgainstCap > maxCredits) {
      throw new Error(`Apollo reported ${apolloCreditsAgainstCap} total credits against a confirmed cap of ${maxCredits}; no verifier calls will be made.`);
    }
    normalized = attachOrganization(enrichmentResult.people, selected)
      .map((record) => normalizeProspect(record));
  } else {
    normalized = rankedCandidates.map(({ person, organization }) => normalizeProspect({
      ...person,
      organization,
      source_company_id: organization.id || organization.organization_id,
      target_company_id: organization.id || organization.organization_id,
      target_company_domain: organization.primary_domain || organization.domain,
      person_organization_id: person.organization_id || person.organization?.id,
      person_organization_domain: person.organization_primary_domain
        || person.organization?.primary_domain
        || person.organization?.domain,
      company_source_provider: 'apollo',
      company_fetched_at: new Date().toISOString(),
    }));
  }

  const verified = await verifyApprovedRecords(normalized, {
    provider: verifier,
    suppression,
    maxCalls: maxVerifications,
    confirmedCalls: confirmedVerifications,
  });
  const organizationCredits = organizationResult.usage.creditsConsumed;
  const enrichmentCredits = enrichmentUsage.creditsConsumed;
  const authoritativeCredits = organizationCredits === null || enrichmentCredits === null
    ? null
    : organizationCredits + enrichmentCredits;
  const outputDir = await createRunDirectory(outputRoot, command);
  const split = await writeRunOutputs(verified.records, {
    outputDir,
    suppression,
    metadata: {
      mode: values.enrich ? 'discover-and-enrich' : 'discover-only',
      companies_found: organizations.length,
      candidates_found: rankedCandidates.length,
      reserved_apollo_credits: reservedApolloCredits,
      apollo_credits_counted_against_cap: apolloCreditsAgainstCap,
      authoritative_apollo_credits_consumed: authoritativeCredits,
      apollo_organization_usage: organizationResult.usage,
      apollo_people_search: peopleResult.search,
      apollo_enrichment_usage: enrichmentUsage,
      enrichment_deferred_by_credit_cap: enrichmentDeferred,
      configured_credit_cap: maxCredits,
      vendor_addresses_submitted: verified.verification.addresses_submitted,
      verification: verified.verification,
    },
  });
  process.stdout.write(`Discovery complete: ${organizations.length} companies, ${rankedCandidates.length} ranked contacts, ${split.ready.length} ready.\n${outputDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`Prospecting pipeline stopped: ${error.message}\n`);
  process.exitCode = 1;
});
