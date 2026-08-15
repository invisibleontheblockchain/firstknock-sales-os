import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');
const readSource = (path) => readFileSync(resolve(rootDir, path), 'utf8');

test('Canvas field decisions require exact active assignment and canonical road ownership', () => {
  const log = readSource('base44/functions/canvasLogHouseDecision/entry.ts');
  assert.match(log, /resolveAuthenticatedTeamMember\(base44, user\)/);
  assert.match(log, /member\.user_id === user\.id/);
  assert.doesNotMatch(log, /email_fallback/);
  assert.match(log, /verifyCanvasLifecycleSession\(secret, session, ["']active["']\)/);
  assert.match(log, /ensureNotSuperseded\(base44, session, secret\)/);
  assert.match(log, /resolveRoadOwnership\(session, point, zoneId\)/);
  assert.match(log, /ambiguous_pin_territory/);
  assert.match(log, /pin_outside_assigned_zone/);
});

test('Canvas pin writes are bounded, idempotent, append-only, and campaign-serialized', () => {
  const log = readSource('base44/functions/canvasLogHouseDecision/entry.ts');
  assert.match(log, /MAX_TARGETED_PIN_MATCHES = 50/);
  assert.match(log, /lat: \{ \$gte:/);
  assert.doesNotMatch(log, /loadCampaignPins/);
  assert.match(log, /idempotency_key_reused/);
  assert.match(log, /CanvasHouseEvent\.create/);
  assert.match(log, /write_status: ["']pending["']/);
  assert.match(log, /write_status: ["']committed["']/);
  assert.match(log, /canvas_field_write_lock_token/);
  assert.match(log, /\$unset/);
  assert.doesNotMatch(log, /CanvasHouseEvent\.delete|CanvasHousePin\.delete/);
});

test('manager campaign map is tenant-scoped and rep results are zone-filtered', () => {
  const map = readSource('base44/functions/canvasGetCampaignMap/entry.ts');
  assert.match(map, /String\(session\.manager_id \|\| ["']{2}\) !== String\(managerId \|\| ["']{2}\)/);
  assert.match(map, /visibleZones = manager \? allZones : allZones\.filter/);
  assert.match(map, /visibleZoneIds\.has\(String\(pin\.zone_id\)\)/);
  assert.match(map, /write_status: ["']committed["']/);
  assert.match(map, /MAX_PINS = (?:1e4|10000)/);
  assert.match(map, /MAX_EVENTS = (?:2e4|20000)/);
});

test('Canvas campaign index derives immutable superseded predecessors as non-active summaries', () => {
  const list = readSource('base44/functions/canvasListCampaigns/entry.ts');
  assert.match(list, /CanvasSession\.filter\(\s*\{ manager_id: user\.id \}/);
  assert.match(list, /superseded_by_session_id/);
  assert.match(list, /effectiveStatus = supersededBySessionId \? ["']superseded["']/);
  assert.doesNotMatch(list, /doors:\s*session\.doors|stable_door/);
  assert.doesNotMatch(list, /asServiceRole/);
});

test('invalid legacy lifecycle records have an explicit fail-closed quarantine path', () => {
  const quarantine = readSource('base44/functions/canvasQuarantineInvalidCampaigns/entry.ts');
  const list = readSource('base44/functions/canvasListCampaigns/entry.ts');
  const session = JSON.parse(readSource('base44/entities/CanvasSession.jsonc'));
  assert.match(quarantine, /QUARANTINE_INVALID_CANVAS_RECORDS/);
  assert.match(quarantine, /if \(await verifyLifecycle\(secret, candidate\)\)/);
  assert.match(quarantine, /if \(String\(candidate\?\.deployment_signature \|\| ''\)\.trim\(\)\)/);
  assert.match(quarantine, /unresolved_signed_campaign_count/);
  assert.match(quarantine, /manager_id: user\.id,[\s\S]*?status: candidate\.status,[\s\S]*?version: expectedVersion/);
  assert.match(quarantine, /status: 'quarantined'/);
  assert.match(quarantine, /quarantine_reason: 'legacy_lifecycle_verification_failed'/);
  assert.doesNotMatch(quarantine, /CanvasSession\.delete|\.deleteMany/);
  assert.match(list, /\["draft", "quarantined"\]\.includes\(session\.status\)/);
  assert.match(list, /trustedSessions\.filter\(\(session\) => \["deployed", "completed", "recalled"\]\.includes\(session\.status\)\)/);
  assert.match(list, /quarantinable_campaigns: quarantinableCampaigns/);
  assert.ok(session.properties.status.enum.includes('quarantined'));
});

test('large Canvas road verification fails closed on cumulative size and time budgets', () => {
  const deploy = readSource('base44/functions/canvasDeployCampaign/entry.ts');
  assert.match(deploy, /MAX_OSM_TILE_JSON_BYTES/);
  assert.match(deploy, /OVERPASS_TOTAL_TIMEOUT_MS/);
  assert.match(deploy, /cumulativeBytes > MAX_OSM_JSON_BYTES \|\| byIdentity\.size > MAX_OSM_ELEMENTS/);
  assert.match(deploy, /response\.body\.getReader\(\)/);
  assert.match(deploy, /batchController\.abort\(\)/);
  assert.match(deploy, /canvas_topology_source_timeout/);
  assert.doesNotMatch(deploy, /const results = new Array\(tiles\.length\)/);
});

test('Canvas transient conflict codes stay aligned with deploy and field retry handling', () => {
  const deploy = readSource('base44/functions/canvasDeployCampaign/entry.ts');
  const builder = readSource('src/components/map/CanvasBuilderSettings.jsx');
  const log = readSource('base44/functions/canvasLogHouseDecision/entry.ts');
  const field = readSource('src/components/rep/CanvasFieldView.jsx');
  assert.match(deploy, /["']canvas_deployment_overlap["']/);
  assert.match(deploy, /["']canvas_deployment_in_progress["']/);
  assert.match(builder, /["']canvas_deployment_overlap["']/);
  assert.match(log, /["']decision_write_in_progress["']/);
  assert.match(log, /["']pin_version_conflict["']/);
  assert.match(field, /code\.includes\(["']write_in_progress["']\)/);
  assert.match(field, /code === ["']pin_version_conflict["']/);
});

test('rep-editable roster records cannot rewrite Canvas membership identity', () => {
  const teamMember = JSON.parse(readSource('base44/entities/TeamMember.jsonc'));
  const user = JSON.parse(readSource('base44/entities/User.jsonc'));
  const protectedFields = ['email', 'user_id', 'role', 'status', 'manager_id', 'invite_code'];
  const expectedWriteRule = {
    $or: [
      { 'data.manager_id': '{{user.id}}' },
      { user_condition: { role: 'admin' } }
    ]
  };
  for (const field of protectedFields) {
    assert.deepEqual(teamMember.properties[field].rls.write, expectedWriteRule, field);
  }
  const allowsWrite = (record, actor) => record.manager_id === actor.id || actor.role === 'admin';
  assert.equal(allowsWrite({ manager_id: 'manager_1' }, { id: 'auth_rep_1', role: 'user' }), false);
  assert.equal(allowsWrite({ manager_id: 'manager_1' }, { id: 'manager_1', role: 'user' }), true);
  assert.equal(allowsWrite({ manager_id: 'manager_1' }, { id: 'platform_admin', role: 'admin' }), true);
  assert.equal(teamMember.properties.name.rls, undefined);
  assert.equal(teamMember.properties.phone.rls, undefined);
  assert.deepEqual(user.properties.team_manager_id.rls.write, { user_condition: { role: 'admin' } });

  for (const functionName of ['canvasGetMyAssignments', 'canvasGetCampaignMap', 'canvasLogHouseDecision']) {
    const source = readSource(`base44/functions/${functionName}/entry.ts`);
    assert.match(source, /TeamMember\.filter\(\{ user_id: user\.id, status: ["']active["'] \}/);
    assert.match(source, /member\.user_id === user\.id/);
  }
});

test('assignment polling carries lifecycle and street ownership but no embedded pin history', () => {
  const assignments = readSource('base44/functions/canvasGetMyAssignments/entry.ts');
  assert.doesNotMatch(assignments, /CanvasHousePin|loadPinsForZone|returned_pins|pins:\s*pinResult/);
  assert.match(assignments, /work_units: workUnitIds\.map/);
});

test('general map history is bounded while do-not-knock safety is separately complete or fails closed', () => {
  const map = readSource('base44/functions/canvasGetCampaignMap/entry.ts');
  assert.match(map, /MAX_PINS = (?:1e4|10000)/);
  assert.match(map, /MAX_DNC_PINS = (?:2e4|20000)/);
  assert.match(map, /latest_outcome: ["']do_not_knock["']/);
  assert.match(map, /dnc_safety_limit_exceeded/);
  // dnc_safety is now emitted through a delivery ternary (embedded vs operational
  // viewport), so match across the line break and require every branch to report a
  // complete suppression list. An incomplete list must fail closed instead.
  assert.match(map, /dnc_safety:[\s\S]{0,240}?complete: true/);
  assert.doesNotMatch(map, /complete: false/);
});
