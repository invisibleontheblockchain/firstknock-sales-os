import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { fieldRoutesSetupAccess } from '../src/components/fieldroutes/fieldRoutesManagerSetup.js';

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('FieldRoutes browser API uses one sanitized Base44 wrapper and durable acknowledgements', () => {
  const source = read('src/api/fieldRoutes.js');

  assert.match(source, /const FUNCTION_NAME = ['"]fieldRoutesIntegration['"]/);
  assert.match(source, /base44\.functions\.invoke\(FUNCTION_NAME, \{ \.\.\.payload, action \}\)/);
  assert.match(source, /response\?\.data \?\? response/);

  for (const action of [
    'capability',
    'save_connection',
    'test_connection',
    'list_service_types',
    'disconnect',
    'list_activity',
    'retry_request',
    'schedule_inspection',
    'get_statuses',
  ]) {
    assert.match(source, new RegExp(`['"]${action}['"]`), `missing ${action} action`);
  }

  for (const exportName of [
    'invokeFieldRoutes',
    'getFieldRoutesCapability',
    'saveFieldRoutesConnection',
    'testFieldRoutesConnection',
    'listFieldRoutesServiceTypes',
    'disconnectFieldRoutes',
    'listFieldRoutesActivity',
    'retryFieldRoutesRequest',
    'scheduleFieldRoutesInspection',
    'getFieldRoutesStatuses',
  ]) {
    assert.match(source, new RegExp(`export (?:async function|const) ${exportName}`), `missing ${exportName}`);
  }

  assert.match(source, /result\?\.accepted === true/);
  assert.match(source, /result\?\.idempotent === true/);
  assert.match(source, /result\?\.request_id/);
  assert.match(source, /result\?\.request\?\.id/);
  assert.match(source, /return result;/);
  assert.match(source, /error\.status = status/);
  assert.match(source, /error\.retryable = retryable/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\.(?:log|error|warn)/);
});

test('manager Integrations setup is write-only, environment-safe, and capability-gated', () => {
  const source = read('src/pages/Integrations.jsx');

  assert.match(source, /isManagerAccount\(userQuery\.data\)/);
  assert.match(source, /enabled: managerAllowed/);
  assert.match(source, /if \(!managerAllowed\) return <ManagerOnlyMessage \/>/);
  assert.match(source, /value === ['"]staging['"] \|\| value === ['"]legacy_staging['"]/);
  assert.match(source, /environment: environment === ['"]staging['"] \? ['"]legacy_staging['"] : ['"]production['"]/);
  assert.match(source, /const STAGING_HOST = ['"]stagingdemo\.pestroutes\.com['"]/);

  assert.match(source, /id="fieldroutes-api-key"[\s\S]*?type="password"[\s\S]*?autoComplete="new-password"/);
  assert.match(source, /id="fieldroutes-auth-token"[\s\S]*?type="password"[\s\S]*?autoComplete="new-password"/);
  assert.match(source, /setAuthenticationKey\(['"]['"]\)/);
  assert.match(source, /setAuthenticationToken\(['"]['"]\)/);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);

  assert.match(source, /source_id: sourceId\.trim\(\) \|\| null/);
  assert.match(source, /office_id: null/);
  assert.match(source, /Phase 1 uses one FieldRoutes office/);
  assert.doesNotMatch(source, /id="fieldroutes-office-id"/);
  assert.match(source, /service_type_id: serviceTypeId \|\| null/);
  assert.match(source, /default_length: defaultLength \? normalizedLength : null/);
  assert.match(source, /Reload services/);
  assert.match(source, /Save credentials & load services/);
  assert.match(source, /Save service & verify/);
  assert.match(source, /Initial service selected/);
  assert.match(source, /Precision scheduling enabled for reps/);
  assert.match(source, /Canvas scheduling stays hidden until the production Canvas territory and address-verification services are enabled/);
  assert.match(source, /capability\.canvas_enabled === true \|\| capability\.modes\?\.canvas === true/);
  assert.match(source, /Save credentials, choose the loaded service, then select Save service & verify/);
  assert.match(source, /rateBudgetWarning = readsToday > 2500 \|\| writesToday > 2500/);
  assert.match(source, /FieldRoutes API budget is running high/);
  assert.match(source, /<AlertDialog>/);
  assert.match(source, /Disconnect FieldRoutes\?/);
});

test('manager can enter credentials when capability status fails but not while loading or explicitly disabled', () => {
  assert.deepEqual(fieldRoutesSetupAccess({ capabilityLoading: true }), {
    explicitlyDisabled: false,
    controlsDisabled: true,
  });
  assert.deepEqual(fieldRoutesSetupAccess({ capabilitySucceeded: true, capabilityEnabled: false }), {
    explicitlyDisabled: true,
    controlsDisabled: true,
  });
  assert.deepEqual(fieldRoutesSetupAccess({ capabilitySucceeded: true, capabilityEnabled: true }), {
    explicitlyDisabled: false,
    controlsDisabled: false,
  });
  assert.deepEqual(fieldRoutesSetupAccess({ capabilitySucceeded: false, capabilityEnabled: undefined }), {
    explicitlyDisabled: false,
    controlsDisabled: false,
  });
  assert.equal(fieldRoutesSetupAccess({ savePending: true }).controlsDisabled, true);

  const page = read('src/pages/Integrations.jsx');
  const hydrationEffect = page.match(/React\.useEffect\(\(\) => \{[\s\S]*?\}, \[capabilityQuery\.data, serviceSetupDirty\]\);/)?.[0] || '';
  assert.ok(hydrationEffect, 'capability hydration effect is missing');
  assert.doesNotMatch(hydrationEffect, /setAuthenticationKey|setAuthenticationToken/);
  assert.match(page, /You can enter these details while status is unavailable/);
});

test('manager service setup unlocks from the save receipt and keeps provider choices actionable', () => {
  const page = read('src/pages/Integrations.jsx');
  const api = read('src/api/fieldRoutes.js');

  assert.match(page, /queryClient\.setQueryData\(\['fieldRoutesCapability'\]/);
  assert.match(page, /mutationFn: \(\{ connection \}\) => saveFieldRoutesConnection\(connection\)/);
  assert.match(page, /else loadServiceTypesMutation\.mutate\(\)/);
  assert.match(page, /next\.length === 1 && !serviceTypeId/);
  assert.match(page, /setServiceSetupDirty\(true\)/);
  assert.match(page, /if \(!serviceSetupDirty\)/);
  assert.match(page, /No visible initial inspection services were returned/);
  assert.match(page, /Services could not be loaded/);
  assert.match(page, /const integrationBusy = saveMutation\.isPending[\s\S]*?testMutation\.isPending[\s\S]*?loadServiceTypesMutation\.isPending/);
  assert.match(page, /disabled=\{!credentialsSaved \|\| !serviceTypeId \|\| !defaultLengthValid \|\| integrationBusy\}/);
  assert.match(page, /handleSave\(event, \{ finishSetup: true \}\)/);

  for (const code of [
    'fieldroutes_not_configured',
    'fieldroutes_office_scope_required',
    'provider_service_type_invalid',
    'provider_multi_office_not_supported',
  ]) {
    assert.match(api, new RegExp(`${code}:`), `missing safe UI copy for ${code}`);
  }
});

test('FirstKnock storage failures are sanitized and do not blame FieldRoutes', () => {
  const source = read('src/api/fieldRoutes.js');

  assert.match(source, /database_unavailable: ['"]FirstKnock FieldRoutes storage is not configured yet\. No credentials were sent\./);
  assert.match(source, /fieldroutes_unavailable: ['"]FirstKnock FieldRoutes server setup is unavailable\. No credentials were sent\./);
});

test('manager activity presents backend queue states without exposing raw provider records', () => {
  const source = read('src/pages/Integrations.jsx');

  assert.match(source, /const ACTIVITY_LIMIT = 20/);
  for (const state of [
    'retry_wait',
    'processing',
    'review_required',
    'customer_reconcile',
    'appointment_reconcile',
    'superseded',
    'blocked_auth',
    'blocked_config',
    'failed_permanent',
  ]) {
    assert.match(source, new RegExp(`${state}:`), `missing ${state} presentation`);
  }

  assert.match(source, /item\?\.state \|\| item\?\.status/);
  assert.match(source, /item\?\.address_safe_label \|\| item\?\.safe_address_label \|\| item\?\.source_label/);
  assert.doesNotMatch(source, /item\?\.address(?:[^_a-zA-Z]|$)/);
  assert.match(source, /item\?\.retry_allowed === true/);
  assert.match(source, /REVIEW_ACTIVITY_STATES\.has\(activityState\)/);
  assert.match(source, /item\?\.error_label \|\| item\?\.display_error/);
  assert.match(source, /Superseded by corrected request/);
  assert.match(source, /requiresReconciliationConfirmation/);
  assert.match(source, /Retry reconciliation/);
  assert.match(source, /if \(!reconciliationRetry\) \{[\s\S]*?retryMutation\.mutate\(\{ requestId, reconciliation: false \}\)/);
  assert.match(source, /Confirm that you reviewed this request in FieldRoutes/);
  assert.match(source, /PAYLOAD_CORRECTION_REQUIRED_CODES\.has\(errorCode\)/);
});

test('read-only smoke parses documented includeData shapes and never prints provider-controlled failures', () => {
  const source = read('scripts/fieldroutes-readonly-smoke.mjs');
  const packageJson = read('package.json');

  assert.match(packageJson, /"smoke:fieldroutes:readonly": "node scripts\/fieldroutes-readonly-smoke\.mjs"/);
  assert.match(source, /payload\?\.serviceTypeData/);
  assert.match(source, /payload\?\.result\?\.serviceTypeData/);
  assert.match(source, /payload\?\.serviceTypeIDs/);
  assert.match(source, /\['includeData', '1'\]/);
  assert.match(source, /maskKnownSecrets/);
  assert.match(source, /Provider rejected the read-only probe \(HTTP \$\{response\.status\}\)/);
  assert.doesNotMatch(source, /console\.(?:log|error)\([^\n]*(?:raw|payload|errorMessage|authenticationKey|authenticationToken)/);
  assert.doesNotMatch(source, /FIELDROUTES_SMOKE_OFFICE/);

  const smokeUrl = pathToFileURL(path.join(root, 'scripts/fieldroutes-readonly-smoke.mjs')).href;
  const authenticationKey = 'smoke+secret?key';
  const authenticationToken = 'token/with&symbols';
  const runSmoke = (payload) => spawnSync(process.execPath, ['--input-type=module', '--eval', `
    process.env.FIELDROUTES_SMOKE_BASE_URL = 'https://demo.fieldroutes.com/api';
    process.env.FIELDROUTES_SMOKE_AUTH_KEY = ${JSON.stringify(authenticationKey)};
    process.env.FIELDROUTES_SMOKE_AUTH_TOKEN = ${JSON.stringify(authenticationToken)};
    globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(payload))}, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    await import(${JSON.stringify(smokeUrl)});
  `], { cwd: root, encoding: 'utf8' });

  const success = runSmoke({
    success: true,
    serviceTypeIDs: [15],
    serviceTypeData: {
      15: {
        typeID: 15,
        description: `Initial ${authenticationKey} ${encodeURIComponent(authenticationToken)}`,
        officeID: 7,
        defaultLength: 60,
        initial: true,
        visible: true,
      },
    },
  });
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /"typeID": "15"/);
  assert.match(success.stdout, /\[redacted\]/);
  const successOutput = `${success.stdout}\n${success.stderr}`;
  for (const secret of [authenticationKey, authenticationToken, encodeURIComponent(authenticationKey), encodeURIComponent(authenticationToken)]) {
    assert.equal(successOutput.includes(secret), false, 'smoke output must mask raw and encoded credentials');
  }

  const rejected = runSmoke({ success: false, errorMessage: `provider echoed ${authenticationKey} ${authenticationToken}` });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Provider rejected the read-only probe \(HTTP 200\)/);
  assert.doesNotMatch(`${rejected.stdout}\n${rejected.stderr}`, /provider echoed|smoke\+secret\?key|token\/with&symbols/);
});

test('Integrations is linked only from manager account navigation, never bottom nav', () => {
  const source = read('src/Layout.jsx');
  const [accountNavigation, bottomNavigation = ''] = source.split('{/* Bottom Nav */}');

  assert.match(accountNavigation, /hasManagerAccess && <Link to=\{createPageUrl\(['"]Integrations['"]\)\}/);
  assert.match(accountNavigation, /hasManagerAccess && <DropdownMenuItem[\s\S]*?createPageUrl\(['"]Integrations['"]\)/);
  assert.doesNotMatch(bottomNavigation, /createPageUrl\(['"]Integrations['"]\)/);
});
