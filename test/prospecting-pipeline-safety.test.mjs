import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  dedupeProspects,
  evaluateProspect,
  loadSuppression,
  normalizeProspect,
  readInput,
  writeCsv,
} from '../scripts/prospecting/lib/pipeline.mjs';

const emptySuppression = { emails: new Map(), domains: new Map() };

function contact(overrides = {}) {
  return {
    first_name: 'Jordan',
    last_name: 'Example',
    title: 'Owner',
    email: 'jordan@desertpest.example',
    email_status: 'verified',
    verification_status: 'deliverable',
    current_employer_confirmed: true,
    organization: {
      name: 'Desert Pest Example',
      primary_domain: 'desertpest.example',
      estimated_num_employees: 18,
    },
    ...overrides,
  };
}

async function temporaryPath(t, name, contents) {
  const directory = await mkdtemp(join(tmpdir(), 'firstknock-prospect-safety-'));
  const filePath = join(directory, name);
  if (contents !== undefined) await writeFile(filePath, contents, 'utf8');
  t.after(async () => {
    await rm(filePath, { force: true });
    await rmdir(directory).catch(() => {});
  });
  return filePath;
}

test('imported opt-outs remain sticky through normalization, dedupe, and evaluation', () => {
  const optedOut = contact({
    title: 'Sales Manager',
    suppression_status: 'opted out',
    suppression_reason: 'recipient request',
    opted_out_at: '2026-07-31T00:00:00Z',
  });
  const preferredUnsuppressedDuplicate = contact({ title: 'Owner' });
  const [deduped] = dedupeProspects([optedOut, preferredUnsuppressedDuplicate]);

  assert.equal(deduped.contact_title, 'Owner');
  assert.equal(deduped.suppression_status, 'opted_out');
  assert.equal(deduped.suppression_reason, 'recipient request');
  assert.equal(deduped.opted_out_at, '2026-07-31T00:00:00Z');

  const evaluated = evaluateProspect(deduped, emptySuppression);
  assert.equal(evaluated.status, 'rejected');
  assert.equal(evaluated.ready_to_contact, false);
  assert.match(evaluated.review_notes, /imported opt-out or suppression/);
});

test('boolean do-not-contact imports are normalized into suppression', () => {
  const prospect = normalizeProspect(contact({ do_not_contact: true }));
  assert.equal(prospect.suppression_status, 'suppressed');
  assert.equal(evaluateProspect(prospect, emptySuppression).status, 'rejected');
});

test('missing suppression fails closed unless explicitly allowed for a dry run', async (t) => {
  const missingPath = await temporaryPath(t, 'does-not-exist.csv');
  await assert.rejects(loadSuppression(missingPath), /Suppression file not found/);
  const allowed = await loadSuppression(missingPath, { allowMissing: true });
  assert.equal(allowed.emails.size, 0);
  assert.equal(allowed.domains.size, 0);
  await assert.rejects(loadSuppression(), /Suppression file path is required/);
});

test('malformed suppression JSON and invalid JSON schemas fail closed', async (t) => {
  const malformed = await temporaryPath(t, 'malformed.json', '{"records": [}');
  await assert.rejects(loadSuppression(malformed), /Malformed suppression JSON/);

  const wrongSchema = await temporaryPath(t, 'wrong-schema.json', '{"contacts":[]}');
  await assert.rejects(loadSuppression(wrongSchema), /array or a supported records envelope/);

  const invalidRow = await temporaryPath(t, 'invalid-row.json', '[{"reason":"opted out"}]');
  await assert.rejects(loadSuppression(invalidRow), /needs an email or domain/);
});

test('suppression CSV parser and schema errors fail closed', async (t) => {
  const malformed = await temporaryPath(t, 'malformed.csv', 'email,reason\n"broken@example.com,opted out\n');
  await assert.rejects(loadSuppression(malformed), /Malformed suppression CSV/);

  const wrongSchema = await temporaryPath(t, 'wrong-schema.csv', 'reason,date\nopted out,2026-07-31\n');
  await assert.rejects(loadSuppression(wrongSchema), /expected an email/);

  const invalidEmail = await temporaryPath(t, 'invalid-email.csv', 'email,reason\nnot-an-email,opted out\n');
  await assert.rejects(loadSuppression(invalidEmail), /invalid email/);
});

test('employer confirmation compares explicit target and person evidence', () => {
  const tautological = normalizeProspect(contact({
    current_employer_confirmed: false,
    organization_id: 'person-org-1',
    organization: {
      id: 'person-org-1',
      name: 'Desert Pest Example',
      primary_domain: 'desertpest.example',
    },
  }));
  assert.equal(tautological.current_employer_confirmed, false);

  const ambiguousFlattenedDomain = normalizeProspect(contact({
    current_employer_confirmed: undefined,
    company_domain: 'desertpest.example',
    person_organization_domain: 'desertpest.example',
  }));
  assert.equal(ambiguousFlattenedDomain.current_employer_confirmed, false);

  const explicitlyRejected = normalizeProspect(contact({
    source_company_id: 'target-org-1',
    person_organization_id: 'target-org-1',
    current_employer_confirmed: false,
  }));
  assert.equal(explicitlyRejected.current_employer_confirmed, false);

  const idConfirmed = normalizeProspect(contact({
    current_employer_confirmed: undefined,
    source_company_id: 'target-org-1',
    person_organization_id: 'target-org-1',
  }));
  assert.equal(idConfirmed.current_employer_confirmed, true);

  const domainConfirmed = normalizeProspect(contact({
    current_employer_confirmed: undefined,
    company_domain: 'target.example',
    target_company_domain: 'target.example',
    person_organization_domain: 'target.example',
  }));
  assert.equal(domainConfirmed.current_employer_confirmed, true);
});

test('prospect CSV export escapes spreadsheet formula cells', async (t) => {
  const filePath = await temporaryPath(t, 'prospects.csv');
  const prospect = normalizeProspect(contact({ company_name: '=HYPERLINK("https://bad.example")' }));
  await writeCsv(filePath, [prospect]);
  const csv = await readFile(filePath, 'utf8');
  assert.match(csv, /'=HYPERLINK/);
});

test('malformed prospect CSV and missing identity columns fail closed', async (t) => {
  const malformed = await temporaryPath(t, 'prospects-malformed.csv', 'company_domain,email\n"broken.example,owner@broken.example\n');
  await assert.rejects(readInput(malformed), /Malformed prospect CSV/);

  const wrongSchema = await temporaryPath(t, 'prospects-wrong-schema.csv', 'title,status\nOwner,verified\n');
  await assert.rejects(readInput(wrongSchema), /company identity column and one contact identity/);
});
