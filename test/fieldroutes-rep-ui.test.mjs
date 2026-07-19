import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  FIELDROUTES_COPY,
  findFieldRoutesStatus,
  fieldRoutesAppointmentId,
  fieldRoutesServerAcknowledged,
  fieldRoutesStatusPresentation,
  isFieldRoutesCapabilityReady,
  isFieldRoutesTerminalStatus,
  preferFieldRoutesStatus,
} from '../src/components/fieldroutes/fieldRoutesPresentation.js';

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('rep presentation requires a durable request identity and uses the approved delivery copy', () => {
  assert.deepEqual(FIELDROUTES_COPY, {
    synced: 'Inspection sent to FieldRoutes — office scheduling pending',
    serverPending: 'Saved to FirstKnock — FieldRoutes sync pending',
    devicePending: 'Saved on this device — not visible to the office yet.',
  });

  assert.equal(fieldRoutesServerAcknowledged({ success: true }), false);
  assert.equal(fieldRoutesServerAcknowledged({ accepted: true }), false);
  assert.equal(fieldRoutesServerAcknowledged({ state: 'queued' }), false);
  assert.equal(fieldRoutesServerAcknowledged({ request_id: 'request_1' }), true);
  assert.equal(fieldRoutesServerAcknowledged({ request: { id: 'request_2' } }), true);
  assert.equal(fieldRoutesServerAcknowledged({ inspection: { id: 'request_3' } }), true);

  assert.equal(isFieldRoutesCapabilityReady({ configured: true, config_ready: true }), true);
  assert.equal(isFieldRoutesCapabilityReady({ capability: { configured: true, config_ready: true } }), true);
  assert.equal(isFieldRoutesCapabilityReady({ configured: true, config_ready: false }), false);
  assert.equal(fieldRoutesStatusPresentation({ kind: 'device_pending' }).label, FIELDROUTES_COPY.devicePending);
  assert.equal(fieldRoutesStatusPresentation({ state: 'queued' }).label, FIELDROUTES_COPY.serverPending);
  assert.equal(fieldRoutesStatusPresentation({ state: 'synced' }).label, FIELDROUTES_COPY.synced);
  assert.equal(fieldRoutesAppointmentId({ appointment_id: 112233 }), '112233');
  assert.equal(fieldRoutesAppointmentId({ result: { request: { appointment_id: '445566' } } }), '445566');
  assert.equal(fieldRoutesAppointmentId({ appointment_id: 'not-an-id' }), null);
  assert.equal(preferFieldRoutesStatus({ kind: 'device_pending' }, { state: 'processing', id: 'server_1' }).id, 'server_1');
  assert.equal(preferFieldRoutesStatus({ state: 'queued' }, { state: 'synced', id: 'server_2' }).id, 'server_2');
  assert.equal(isFieldRoutesTerminalStatus({ state: 'superseded' }), true);
  assert.equal(fieldRoutesStatusPresentation({ state: 'superseded' }).tone, 'superseded');
  assert.equal(findFieldRoutesStatus({ statuses: [
    { source_key: 'house_1', state: 'superseded', id: 'old' },
    { source_key: 'house_1', state: 'queued', id: 'corrected' },
  ] }, (row) => row.source_key === 'house_1').id, 'corrected');
});

test('Schedule Inspection is an explicit full-width action with confirmation and duplicate prevention', () => {
  const action = read('src/components/fieldroutes/ScheduleInspectionAction.jsx');

  assert.match(action, /> Schedule Inspection\s*</);
  assert.match(action, /w-full[\s\S]*?Schedule Inspection/);
  assert.match(action, /existingStatus \? \(/);
  assert.match(action, /Inspection request already pending/);
  assert.match(action, /status\?\.local_only === true && status\?\.kind === 'device_attention'/);
  assert.match(action, /Discard this unsent device copy so you can correct it\?/);
  assert.match(action, /Discard device copy and correct/);
  assert.match(action, /FieldRoutes scheduling appears after your manager finishes the integration setup/);
  assert.match(action, /Confirm the customer’s first and last name/);
  assert.match(action, /Add at least a phone number or email address/);
  assert.match(action, /phoneDigits\.length === 10/);
  assert.match(action, /phoneDigits\.length === 11 && phoneDigits\.startsWith\('1'\)/);
  assert.match(action, /phoneFormatValid/);
  assert.match(action, /valid 10-digit US phone number/);
  assert.match(action, /Canvas inspections require street address, city, state, and ZIP/);
  assert.match(action, /\^\[A-Za-z\]\{2\}\$/);
  assert.match(action, /\\d\{5\}/);
  assert.match(action, /Send unassigned inspection/);
  assert.match(action, /role="dialog"/);
  assert.match(action, /aria-modal="true"/);
  assert.match(action, /aria-labelledby="fieldroutes-schedule-title"/);
  assert.match(action, /aria-label="Close Schedule Inspection"/);
  assert.match(action, /aria-label="Customer first name"/);
  assert.match(action, /handleDialogKeyDown/);
  assert.match(action, /firstNameRef\.current\?\.focus/);
  assert.match(action, /Appointment #\{appointmentId\}/);
  assert.match(action, /first_name: form\.firstName\.trim\(\)/);
  assert.match(action, /last_name: form\.lastName\.trim\(\)/);
  assert.match(action, /phone: form\.phone\.trim\(\) \|\| null/);
  assert.match(action, /email: form\.email\.trim\(\) \|\| null/);
  assert.match(action, /street_address: form\.streetAddress\.trim\(\)/);
  assert.match(action, /unit: form\.unit\.trim\(\) \|\| null/);
  assert.match(action, /notes: form\.notes\.trim\(\) \|\| null/);
  assert.match(action, /formIdentity[\s\S]*?eslint-disable-next-line react-hooks\/exhaustive-deps/);
});

test('Precision scheduling stays independent while Canvas scheduling appears only after a synced house outcome', () => {
  const precision = read('src/components/rep/PropertyDetailSheet.jsx');
  const canvas = read('src/components/rep/CanvasFieldView.jsx');
  const precisionMap = read('src/components/rep/RepMapView.jsx');
  const outcomes = read('src/components/canvas/canvasOutcomeUtils.js');

  assert.ok(precision.indexOf('<ScheduleInspectionAction') < precision.indexOf('Quick Outcome - unchanged local decision grid'));
  assert.match(precision, /mode="precision"/);
  assert.match(precision, /ownerName: property\.owner_full_name/);
  assert.match(precision, /streetAddress: property\.full_address/);
  assert.match(precision, /<div className="flex-1 overflow-y-auto">/);

  assert.ok(canvas.indexOf('<ScheduleInspectionAction') > canvas.indexOf('>Log outcome<'));
  assert.match(canvas, /mode="canvas"/);
  assert.match(canvas, /kind: 'canvas'/);
  assert.match(canvas, /!pinDraft\?\.pinId[\s\S]*?Sync this Canvas house decision before scheduling/);
  assert.match(canvas, /pin_id: pinDraft\.pinId/);
  assert.doesNotMatch(canvas, /pin_id: null/);
  assert.match(canvas, /Log and sync this house first; then you can schedule an inspection/);
  assert.match(canvas, /\{pinDraft\.pinId && !pinDraft\.pendingDecision && \([\s\S]*?<ScheduleInspectionAction/);
  assert.match(canvas, /address: \{[\s\S]*?\.\.\.property,[\s\S]*?lat:/);
  assert.match(canvas, /`canvas:\$\{assignment\.campaign_id\}:\$\{zone\.zone_id\}:\$\{Number\(pinDraft\.point\.lat\)\.toFixed\(6\)\}:\$\{Number\(pinDraft\.point\.lng\)\.toFixed\(6\)\}`/);
  assert.match(canvas, /fieldRoutesOnlyMarkers/);
  assert.ok(canvas.indexOf('const pendingPins') < canvas.indexOf('const fieldRoutesOnlyMarkers'),
    'Canvas FieldRoutes markers must not read pendingPins before it is initialized');
  assert.match(canvas, /tap to log the Canvas house outcome/);
  assert.match(canvas, /fieldRoutesStyleForPin/);
  assert.match(canvas, /source_reference/);
  assert.match(precisionMap, /getFieldRoutesPinStyle/);
  assert.match(precisionMap, /FieldRoutes sync pending/);
  assert.match(precisionMap, /fillOpacity: 0/);
  assert.match(outcomes, /value: 'appointment'/);

  const saveDecision = canvas.slice(canvas.indexOf('const saveDecision'), canvas.indexOf('const discardPendingDecision'));
  assert.doesNotMatch(saveDecision, /scheduleCanvasInspection|onScheduleFieldRoutesInspection/,
    'logging an ordinary Canvas outcome must never automatically schedule FieldRoutes');
});

test('rep queue persists before sending and retries only within the same actor and manager scope', () => {
  const queue = read('src/components/fieldroutes/fieldRoutesInspectionQueue.js');
  const hook = read('src/components/fieldroutes/useFieldRoutesInspectionQueue.js');
  const submit = hook.slice(hook.indexOf('const submitInspection'));

  assert.match(queue, /localforage\.createInstance/);
  assert.match(queue, /inspection_request_queue_v1/);
  assert.match(queue, /actor_user_id/);
  assert.match(queue, /manager_id/);
  assert.match(queue, /source\.kind \|\| source\.mode \|\| source\.source_mode/);
  assert.match(queue, /MAX_QUEUE_ITEMS = 200/);
  assert.match(queue, /AUTO_RETRY_WINDOW_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(queue, /HARD_RETENTION_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(queue, /export async function activateFieldRoutesQueueScope/);
  assert.match(queue, /recordScope\(value\) !== scope/);
  assert.match(queue, /export async function clearFieldRoutesInspectionQueue/);
  assert.match(queue, /await inspectionQueue\.clear\(\)/);
  assert.match(queue, /immutable_fingerprint/);
  assert.match(queue, /if \(!includeAttention && syncState === 'needs_attention'\) return/);
  assert.match(queue, /export async function discardFieldRoutesAttentionBySource/);
  assert.match(queue, /String\(value\.intent\?\.source\?\.source_key \|\| ''\) !== source/);
  assert.match(queue, /value\.sync_state === 'needs_attention'/);
  assert.match(queue, /if \(!isAcknowledged\(result\)\) throw new Error/);
  assert.match(queue, /await acknowledgeFieldRoutesInspection\(record\)/);

  assert.ok(submit.indexOf('queueFieldRoutesInspection(intent)') < submit.indexOf('scheduleFieldRoutesInspection(intent)'),
    'the immutable device copy must exist before the network request starts');
  assert.match(hook, /window\.addEventListener\('online', flush\)/);
  assert.match(hook, /window\.addEventListener\('focus', flush\)/);
  assert.match(hook, /document\.addEventListener\('visibilitychange', onVisible\)/);
  assert.match(hook, /DEVICE_RETRY_INTERVAL_MS = 60_000/);
  assert.match(hook, /window\.setInterval\(\(\) => \{[\s\S]*?refreshPendingCount\(\);[\s\S]*?flush\(\);[\s\S]*?DEVICE_RETRY_INTERVAL_MS/);
  assert.match(hook, /activeScopeRef\.current !== requestedScope/);
  assert.match(hook, /kind: 'device_attention'/);
  assert.match(hook, /local_only: true/);
  assert.match(hook, /discardFieldRoutesAttentionBySource\(\{/);
  assert.match(hook, /FIELDROUTES_COPY\.devicePending/);
  assert.doesNotMatch(queue, /api[_-]?key|authentication[_-]?token|credential/i);

  const layout = read('src/Layout.jsx');
  const deleteAccount = read('src/pages/DeleteAccount.jsx');
  assert.match(layout, /await clearFieldRoutesInspectionQueue\(\)\.catch/);
  assert.ok(layout.indexOf('clearFieldRoutesInspectionQueue') < layout.indexOf('base44.auth.logout(window.location.origin)'));
  assert.ok(deleteAccount.indexOf('await clearFieldRoutesInspectionQueue()') < deleteAccount.indexOf('await base44.auth.logout()'));
});

test('RepHome wires one scoped queue into both Precision and Canvas without changing Precision outcomes', () => {
  const home = read('src/pages/RepHome.jsx');

  assert.match(home, /useFieldRoutesInspectionQueue\(\{/);
  assert.match(home, /actorUserId: user\?\.id/);
  assert.match(home, /managerId: repManagerId/);
  assert.match(home, /kind: 'precision'/);
  assert.match(home, /route_id: activeRoute\.id/);
  assert.match(home, /address_hash: target\.address_hash/);
  assert.match(home, /onScheduleFieldRoutesInspection=\{submitFieldRoutesInspection\}/);
  assert.match(home, /onScheduleInspection=\{handleScheduleInspection\}/);
  assert.match(home, /refetchInterval: \(query\) => shouldPollPrecisionFieldRoutes/);
  assert.match(home, /preferFieldRoutesStatus\(localStatus, serverStatus\)/);
  assert.match(home, /createLogMutation\.mutate\(\{/);
  assert.match(home, /onLog=\{handleLog\}/);
});
