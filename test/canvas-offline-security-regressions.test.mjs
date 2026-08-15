import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { isCanvasDncProtected } from '../src/components/canvas/canvasDncSafety.js';
import { isCanvasFieldTapSafe, nearestCanvasStreetDistanceMeters } from '../src/components/canvas/canvasFieldSafety.js';
import { getCanvasPackageTrustConfig } from '../src/components/canvas/canvasPackageTrust.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('DNC protection matches stable house identity and a tight same-house spatial fallback', () => {
  const entries = [{ suppression_id: 'dnc-1', house_key: 'address:1 main st:unit:_', point: { lat: 33, lng: -112 }, active: true }];
  assert.equal(isCanvasDncProtected({ house_key: 'ADDRESS:1 MAIN ST:UNIT:_', point: { lat: 34, lng: -113 } }, entries), true);
  assert.equal(isCanvasDncProtected({ point: { lat: 33.00005, lng: -112 } }, entries), true);
  assert.equal(isCanvasDncProtected({ point: { lat: 33.0003, lng: -112 } }, entries), false);
  assert.equal(isCanvasDncProtected({ dnc_active: true }, []), true);
  assert.equal(isCanvasDncProtected({ latest_outcome: 'do_not_knock' }, []), true);
});

test('offline house taps are locally rejected before the backend 150-meter street snap ceiling', () => {
  const segments = [{ start: { lat: 33, lng: -112 }, end: { lat: 33.001, lng: -112 } }];
  assert.equal(isCanvasFieldTapSafe({ lat: 33.0005, lng: -111.9999 }, segments), true);
  assert.equal(isCanvasFieldTapSafe({ lat: 33.0005, lng: -111.998 }, segments), false);
  assert.ok(nearestCanvasStreetDistanceMeters({ lat: 33.0005, lng: -111.998 }, segments) > 150);
});

test('web trust configuration is fail-closed and independent from API response data', () => {
  assert.throws(
    () => getCanvasPackageTrustConfig({}),
    (error) => error.code === 'CANVAS_PACKAGE_TRUST_NOT_CONFIGURED',
  );
  const trust = getCanvasPackageTrustConfig({
    VITE_CANVAS_PACKAGE_SIGNING_PUBLIC_KEY: 'AQIDBA',
    VITE_CANVAS_PACKAGE_SIGNING_PUBLIC_KEY_FORMAT: 'raw',
    VITE_CANVAS_PACKAGE_SIGNING_KEY_ID: 'canvas-field-2026-08',
  });
  assert.equal(trust.keyId, 'canvas-field-2026-08');
  assert.equal(trust.keyData, 'AQIDBA');
  assert.equal(Object.hasOwn(trust, 'response'), false);
});

test('rep and manager maps keep tenant DNC visible above ordinary campaign pins', () => {
  const field = readFileSync(resolve(root, 'src/components/rep/CanvasResidentialFieldView.jsx'), 'utf8');
  const manager = readFileSync(resolve(root, 'src/components/map/CanvasCampaignMapLayers.jsx'), 'utf8');
  assert.match(field, /isCanvasDncProtected\(pin, dncEntries\)/);
  assert.match(field, /windowed\.dnc\.map[\s\S]*radius=\{11\}/);
  assert.doesNotMatch(field, /dncEntries\.map\(dncAsPin\)\.filter\([^\n]*pinHouseKeys/);
  assert.match(manager, /const protectedDnc = isCanvasDncProtected\(pin\)/);
  assert.match(manager, /dncPins\.map/);
  assert.doesNotMatch(manager, /filter\(\(entry\) => !entry\?\.house_key/);
});

test('assignment-index identity is stable and multi-package hydration is concurrency bounded', () => {
  const field = readFileSync(resolve(root, 'src/components/rep/CanvasResidentialFieldView.jsx'), 'utf8');
  const runtime = readFileSync(resolve(root, 'src/components/canvas/canvasOfflinePackageRuntime.js'), 'utf8');
  assert.match(field, /stableAssignmentsRef/);
  assert.match(field, /loadCanvasOfflineAssignments/);
  assert.doesNotMatch(field, /Promise\.all\(assignments\.map/);
  assert.match(runtime, /Math\.min\(4, Number\.isSafeInteger\(concurrency\)/);
  assert.match(field, /MAX_FIELD_VIEWPORT_MARKERS = 1_500/);
  assert.match(field, /nextRetryAt/);
  assert.match(field, /syncRunRef/);
});

test('rep discovery pages the operational index while preserving legacy Canvas access', () => {
  const repHome = readFileSync(resolve(root, 'src/pages/RepHome.jsx'), 'utf8');
  const client = readFileSync(resolve(root, 'src/components/canvas/canvasProductionClient.js'), 'utf8');
  assert.match(repHome, /getAllCanvasAssignmentIndex\(\{ maxPages: 100 \}\)/);
  assert.match(repHome, /authoritativeComplete: result\.complete === true/);
  assert.match(repHome, /queryKey: \['myLegacyCanvasAssignments'/);
  assert.match(repHome, /staleTime: Infinity/);
  assert.match(repHome, /hasResidentialCanvas && hasLegacyCanvas && !canvasFieldMode/);
  assert.match(repHome, /<CanvasResidentialFieldView/);
  assert.match(repHome, /<CanvasFieldView/);
  assert.match(client, /for \(let page = 0; page < pageLimit; page \+= 1\)/);
  assert.match(client, /if \(!result\.has_more\)/);
  assert.match(client, /CANVAS_ASSIGNMENT_INDEX_TOO_LARGE/);
});
