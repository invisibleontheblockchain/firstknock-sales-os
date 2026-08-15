import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationPath = 'base44/functions/setupCanvasOperationalStore/entry.ts';
const source = readFileSync(resolve(root, migrationPath), 'utf8');

const TABLES = [
  'canvas_deployments',
  'canvas_assignments',
  'canvas_work_unit_ownership',
  'canvas_changes',
  'canvas_house_events',
  'canvas_house_pins',
  'canvas_dnc_suppressions',
  'canvas_zone_progress',
  'canvas_assignment_packages',
  'canvas_package_artifacts',
  'canvas_dnc_manifests',
  'canvas_dnc_manifest_shards',
];

test('Canvas operational migration transpiles as a self-contained Base44 function', () => {
  const transpiled = ts.transpileModule(source, {
    fileName: migrationPath,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  const errors = (transpiled.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, []);
  assert.doesNotMatch(source, /from ['"]\.\.?\//);
});

test('Canvas operational migration is separately authorized and cannot fall back to the Precision database secret', () => {
  assert.match(source, /CANVAS_OPERATIONAL_MIGRATION_SECRET/);
  assert.match(source, /x-canvas-migration-secret/);
  assert.match(source, /constantTimeEqual/);
  assert.match(source, /CANVAS_DATABASE_URL/);
  assert.doesNotMatch(source, /Deno\.env\.get\(["']DATABASE_URL["']\)/);
  assert.doesNotMatch(source, /Deno\.env\.get\(["']NEON_DATABASE_URL["']\)/);
  assert.doesNotMatch(source, /SavedRoute|InteractionLog|MasterProperty|workspace_properties|\bproperties\b/);
  assert.match(source, /precision_database_changed: false/);
});

test('Canvas operational DDL is additive and idempotent', () => {
  assert.match(source, /CREATE EXTENSION IF NOT EXISTS postgis/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS canvas_operational_schema_migrations/);
  assert.match(source, /ON CONFLICT \(version\) DO NOTHING/);
  for (const table of TABLES) {
    assert.match(source, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`), table);
  }
  const indexStatements = source.match(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS/g) || [];
  assert.ok(indexStatements.length >= 20, `expected at least 20 idempotent indexes, received ${indexStatements.length}`);
  assert.match(source, /DROP TRIGGER IF EXISTS/);
  assert.match(source, /CREATE OR REPLACE FUNCTION canvas_reject_manager_id_change/);
});

test('Canvas operational DDL enforces tenant-safe foreign keys and immutable append-only ledgers', () => {
  assert.match(source, /UNIQUE \(campaign_id, manager_id\)/);
  assert.match(source, /FOREIGN KEY \(campaign_id, manager_id\)[\s\S]*?REFERENCES canvas_deployments\(campaign_id, manager_id\)/);
  assert.match(source, /UNIQUE \(assignment_id, manager_id\)/);
  assert.match(source, /UNIQUE \(assignment_id, manager_id, campaign_id, zone_id\)/);
  assert.match(source, /FOREIGN KEY \(assignment_id, manager_id, campaign_id, zone_id\)[\s\S]*?REFERENCES canvas_assignments\(assignment_id, manager_id, campaign_id, zone_id\)/);
  assert.match(source, /UNIQUE \(manager_id, actor_user_id, idempotency_key\)/);
  assert.match(source, /cursor BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY/);
  assert.match(source, /UNIQUE \(cursor, manager_id\)/);
  assert.match(source, /FOREIGN KEY \(change_cursor, manager_id\)[\s\S]*?REFERENCES canvas_changes\(cursor, manager_id\)/);
  assert.match(source, /FOREIGN KEY \(source_event_id, manager_id, source_campaign_id, source_zone_id\)[\s\S]*?REFERENCES canvas_house_events\(event_id, manager_id, campaign_id, zone_id\)/);
  assert.match(source, /CREATE OR REPLACE FUNCTION canvas_reject_append_only_mutation/);
  assert.match(source, /\["canvas_changes", "canvas_house_events"\]/);
  for (const table of TABLES) assert.ok(source.includes(`"${table}"`), `${table} is absent from tenant trigger coverage`);
});

test('Canvas operational DDL supports indexed ownership, viewport pins, ordered deltas, and exact progress', () => {
  assert.match(source, /geometry geometry\(MultiLineString, 4326\) NOT NULL/);
  assert.match(source, /point geometry\(Point, 4326\) NOT NULL/);
  assert.match(source, /idx_canvas_work_units_geometry[\s\S]*?USING GIST\(geometry\)/);
  assert.match(source, /idx_canvas_work_units_geography[\s\S]*?USING GIST\(\(geometry::geography\)\)/);
  assert.match(source, /idx_canvas_pins_viewport[\s\S]*?USING GIST\(point\)/);
  assert.match(source, /idx_canvas_changes_assignment_cursor[\s\S]*?\(assignment_id, cursor\)/);
  assert.match(source, /idx_canvas_changes_campaign_cursor[\s\S]*?\(manager_id, campaign_id, cursor\)/);
  assert.match(source, /distinct_pin_count BIGINT NOT NULL DEFAULT 0/);
  assert.match(source, /outcome_counts JSONB NOT NULL DEFAULT '\{\}'::JSONB/);
  assert.match(source, /last_change_cursor BIGINT NOT NULL DEFAULT 0/);
});

test('DNC is a tenant suppression ledger with audited revocation and no campaign-sized hard cap', () => {
  const dncStart = source.indexOf('CREATE TABLE IF NOT EXISTS canvas_dnc_suppressions');
  const dncEnd = source.indexOf('CREATE TABLE IF NOT EXISTS canvas_zone_progress', dncStart);
  const dnc = source.slice(dncStart, dncEnd);
  assert.match(dnc, /manager_id TEXT NOT NULL/);
  assert.match(dnc, /active BOOLEAN NOT NULL DEFAULT TRUE/);
  assert.match(dnc, /revoked_by_user_id TEXT/);
  assert.match(dnc, /revoked_at TIMESTAMPTZ/);
  assert.match(dnc, /revocation_reason TEXT/);
  assert.match(dnc, /canvas_dnc_revocation_check/);
  assert.doesNotMatch(dnc, /^\s*campaign_id TEXT NOT NULL/m);
  assert.doesNotMatch(source, /MAX_DNC|20000|20_000/);
  assert.match(source, /idx_canvas_dnc_active_house_key[\s\S]*?WHERE active AND house_key IS NOT NULL/);
});

test('assignment packages and DNC manifests are hash-addressed, versioned, and completeness-gated', () => {
  assert.match(source, /manifest_hash ~ '\^\[a-f0-9\]\{64\}\$'/);
  assert.match(source, /manifest_signature/);
  assert.match(source, /signing_key_id/);
  assert.match(source, /status <> 'ready' OR/);
  assert.match(source, /dnc_high_water_cursor BIGINT NOT NULL DEFAULT 0/);
  assert.match(source, /scope_hash ~ '\^\[a-f0-9\]\{64\}\$'/);
  assert.match(source, /root_hash ~ '\^\[a-f0-9\]\{64\}\$'/);
  assert.match(source, /complete BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(source, /NOT complete OR \(shard_count > 0 OR total_count = 0\)/);
  assert.match(source, /FOREIGN KEY \(dnc_manifest_id, manager_id\)/);
});
