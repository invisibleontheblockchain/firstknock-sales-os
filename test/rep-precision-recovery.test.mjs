import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isUnsavedRoute } from '../src/lib/routeSaveState.js';
import { getManagerIdForAccount } from '../src/lib/roles.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('a route that never reached the account is discarded on the device, not deleted on the server', () => {
  assert.equal(isUnsavedRoute({ id: 'route_1', isSaved: false }), true, 'the reported route_1 case');
  assert.equal(isUnsavedRoute({ id: 'local_123_abc' }), true);
  assert.equal(isUnsavedRoute({ id: '' }), true);
  assert.equal(isUnsavedRoute({ id: 'saved-route-9', isSaved: true }), false);
  assert.equal(isUnsavedRoute({ id: 'saved-route-9' }), false, 'a saved route is never discarded by mistake');
  assert.equal(isUnsavedRoute(null), false);
  assert.equal(isUnsavedRoute({ id: 'route_1' }, new Set(['saved-route-9'])), true);
  assert.equal(isUnsavedRoute({ id: 'saved-route-9' }, new Set(['saved-route-9'])), false);
});

test('a rep saves into the team workspace and a manager into their own', () => {
  assert.equal(getManagerIdForAccount({ id: 'rep-1', app_role: 'rep', team_manager_id: 'manager-1' }), 'manager-1');
  assert.equal(getManagerIdForAccount({ id: 'manager-1', app_role: 'manager' }), 'manager-1');
  const home = read('src/pages/Home.jsx');
  assert.match(home, /manager_id: getManagerIdForAccount\(user\) \|\| user\.id,/);
  assert.doesNotMatch(home, /SavedRoute\.filter\(\{ manager_id: user\.id, 'metadata\.precision_area\.job_id'/);
});

test('both delete buttons discard unsaved routes locally', () => {
  const home = read('src/pages/Home.jsx');
  const calls = home.match(/deleteSavedRoute\(\{[^\n]*onDiscardUnsaved: \(unsaved\) => setRoutes\(current => current\.filter\(candidate => candidate\.id !== unsaved\.id\)\)/g) || [];
  assert.equal(calls.length, 2);
  const action = read('src/lib/deleteRouteAction.js');
  assert.match(action, /if \(unsaved\) \{[\s\S]*?onDiscardUnsaved\?\.\(route\);[\s\S]*?return true;\s*\}/);
  // The server delete only runs after the unsaved branch has returned.
  assert.ok(action.indexOf('if (unsaved) {') < action.indexOf('SavedRoute.delete'));
});

test('opening the app offers a finished import with build and dismiss, and keeps resuming running ones', () => {
  const prompt = read('src/components/map/TerritoryPrompt.jsx');
  assert.match(prompt, /if \(shouldOfferRecoveryInsteadOfResuming\(job\)\) \{\s*\n\s*setPendingRecovery\(job\);\s*\n\s*return;/);
  assert.match(prompt, /if \(!pulling\) await resumePrecisionJob\(job, \(\) => cancelled\);/);
  assert.match(prompt, /invoke\('getPrecisionRecovery', \{ action: 'dismiss', job_id: job\.id \}\)/);
  assert.match(prompt, />Build routes</);
  assert.match(prompt, /onClick=\{dismissPendingRecovery\}/);
});
