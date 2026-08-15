import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const paths = {
  sync: 'base44/functions/canvasSyncDecisions/entry.ts',
  changes: 'base44/functions/canvasGetChanges/entry.ts',
  summary: 'base44/functions/canvasGetCampaignSummary/entry.ts',
};
const sources = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, readFileSync(resolve(root, path), 'utf8')]));

test('Canvas operational APIs transpile as self-contained Base44 functions', () => {
  for (const [name, source] of Object.entries(sources)) {
    const transpiled = ts.transpileModule(source, {
      fileName: paths[name],
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    });
    const errors = (transpiled.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
    assert.deepEqual(errors, [], `${name} has TypeScript syntax errors`);
    assert.doesNotMatch(source, /from ['"]\.\.?\//, `${name} must remain a self-contained Base44 isolate`);
  }
});

test('all operational APIs use only the isolated Canvas database secret', () => {
  for (const [name, source] of Object.entries(sources)) {
    assert.match(source, /Deno\.env\.get\("CANVAS_DATABASE_URL"\)/, `${name} does not use the Canvas database boundary`);
    assert.doesNotMatch(source, /Deno\.env\.get\(["'](?:DATABASE_URL|NEON_DATABASE_URL)["']\)/, `${name} falls back to a Precision database secret`);
    assert.doesNotMatch(source, /SavedRoute|InteractionLog|MasterProperty|workspace_properties|recordKnockOutcome/, `${name} imports or references Precision state`);
  }
});

test('decision sync is bounded and exactly bound to the live user, tenant, assignment, and signed package record', () => {
  const source = sources.sync;
  assert.match(source, /const MAX_DECISIONS = 100/);
  assert.match(source, /const MAX_BODY_BYTES = 256_000/);
  assert.match(source, /body\.decisions\.length > MAX_DECISIONS/);
  assert.match(source, /TeamMember\.filter\([\s\S]*?user_id: user\.id, status: "active"/);
  assert.match(source, /String\(row\.assignee_user_id\) !== String\(user\.id\)/);
  assert.match(source, /String\(row\.team_member_id\) !== actor\.teamMemberId/);
  assert.match(source, /WHERE a\.assignment_id = \$1 AND a\.manager_id = \$2/);
  assert.match(source, /LEFT JOIN canvas_assignment_packages p/);
  assert.match(source, /p\.package_version = a\.package_version/);
  assert.match(source, /package_version_mismatch/);
  assert.match(source, /package_record_status\) !== "ready"/);
  assert.match(source, /campaign_recalled/);
  assert.match(source, /assignment_revoked/);
  assert.match(source, /assignment_expired/);
  assert.match(source, /FROM canvas_assignment_packages[\s\S]*?FOR SHARE/);
});

test('each decision is idempotent and its complete projection commits atomically', () => {
  const source = sources.sync;
  assert.match(source, /BEGIN ISOLATION LEVEL SERIALIZABLE/);
  assert.match(source, /pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)/);
  assert.match(source, /manager_id = \$1 AND e\.actor_user_id = \$2 AND e\.idempotency_key = \$3/);
  assert.match(source, /request_hash/);
  assert.match(source, /idempotency_key_reused/);
  assert.match(source, /INSERT INTO canvas_changes/);
  assert.match(source, /INSERT INTO canvas_house_events/);
  assert.match(source, /INSERT INTO canvas_house_pins/);
  assert.match(source, /UPDATE canvas_house_pins SET/);
  assert.match(source, /INSERT INTO canvas_dnc_suppressions/);
  assert.match(source, /INSERT INTO canvas_zone_progress/);
  assert.match(source, /ON CONFLICT \(manager_id, campaign_id, zone_id\) DO UPDATE/);
  assert.match(source, /await client\.query\("COMMIT"\)/);
  assert.match(source, /await client\.query\("ROLLBACK"\)/);
  assert.match(source, /\["40001", "40P01"\]/);
});

test('ownership is a PostGIS street lookup with exclusive and ambiguous-edge rejection', () => {
  const source = sources.sync;
  assert.match(source, /FROM canvas_work_unit_ownership w/);
  assert.match(source, /ST_DWithin\(w\.geometry::geography, target\.geom::geography, \$5\)/);
  assert.match(source, /ST_Distance\(w\.geometry::geography, target\.geom::geography\)/);
  assert.match(source, /decision_owned_by_another_assignment/);
  assert.match(source, /ambiguous_street_ownership/);
  assert.match(source, /pin_identity_mismatch/);
  assert.match(source, /ROAD_AMBIGUITY_METERS = 12/);
  assert.match(source, /ROAD_AMBIGUITY_RATIO = 1\.5/);
});

test('DNC is sticky and tenant-wide while ordinary outcomes cannot clear it', () => {
  const source = sources.sync;
  assert.match(source, /WHERE manager_id = \$1 AND house_key = \$2 AND active/);
  assert.match(source, /decision\.outcome === "do_not_knock" && !existingDnc/);
  assert.match(source, /type: "dnc_upsert"/);
  assert.match(source, /ordinary outcomes never clear a DNC/);
  assert.match(source, /DNC_HOUSE_MATCH_METERS = 12/);
  assert.match(source, /dnc_house_protected/);
  assert.match(source, /ST_DWithin\([\s\S]*?DNC_HOUSE_MATCH_METERS/);
  assert.doesNotMatch(source, /DELETE FROM canvas_dnc_suppressions/i);
  assert.doesNotMatch(source, /UPDATE canvas_dnc_suppressions SET[\s\S]{0,300}active\s*=\s*(?:FALSE|\$)/i);
});

test('delta sync is cursor ordered, capped at 500, and spatially includes tenant DNC changes', () => {
  const source = sources.changes;
  assert.match(source, /const MAX_CHANGE_PAGE = 500/);
  assert.match(source, /Math\.min\(requestedLimit, MAX_CHANGE_PAGE\)/);
  assert.match(source, /c\.cursor > \$2/);
  assert.match(source, /c\.cursor <= \$6/);
  assert.match(source, /ORDER BY c\.cursor ASC/);
  assert.match(source, /LIMIT \$5/);
  assert.match(source, /limit \+ 1/);
  assert.match(source, /change_type IN \('dnc_upsert', 'dnc_revoke'\)/);
  assert.match(source, /FROM canvas_work_unit_ownership w/);
  assert.match(source, /ST_DWithin\(/);
  assert.match(source, /next_cursor/);
  assert.match(source, /high_water_cursor/);
  assert.match(source, /const nextCursor = hasMore \? page\[page\.length - 1\]\.cursor : highWaterCursor/);
});

test('campaign summaries are manager-only and use exact transactional projections rather than capped pin scans', () => {
  const source = sources.summary;
  assert.match(source, /if \(!canManageCanvas\(user\)\)/);
  assert.match(source, /WHERE campaign_id = \$1 AND manager_id = \$2/);
  assert.match(source, /FROM canvas_zone_progress/);
  assert.match(source, /FROM canvas_assignments/);
  assert.match(source, /FROM canvas_dnc_suppressions/);
  assert.doesNotMatch(source, /FROM canvas_house_pins/);
  assert.doesNotMatch(source, /FROM canvas_house_events/);
  assert.doesNotMatch(source, /10000|10_000|20000|20_000/);
});
