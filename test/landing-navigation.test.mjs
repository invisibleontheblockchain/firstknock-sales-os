import assert from 'node:assert/strict';
import test from 'node:test';
import { getLandingDestinations } from '../src/lib/landingNavigation.js';
import { safeReturnTo } from '../src/lib/authReturnTo.js';

test('sign-in uses the existing same-origin login route and resumes app entry', () => {
  const { appEntry, signInUrl } = getLandingDestinations();
  assert.equal(appEntry, '/RoleSelect');
  for (const origin of ['https://firstknock.online', 'http://localhost:5173']) {
    const login = new URL(signInUrl, origin);
    assert.equal(login.origin, origin);
    assert.equal(login.pathname, '/login');
    assert.equal(login.searchParams.get('returnTo'), appEntry);
  }
});

test('campaign and referral parameters survive sign-in through the actual redirect validator', () => {
  const search = '?ref=TEAM42&utm_source=instagram&utm_campaign=fall';
  const { appEntry, signInUrl } = getLandingDestinations({ search });
  assert.equal(appEntry, '/RoleSelect' + search);
  const previousWindow = global.window;
  try {
    global.window = { location: new URL(signInUrl, 'https://firstknock.online') };
    assert.equal(safeReturnTo(), appEntry);
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});

test('sign-in return parameters cannot carry app-bootstrap overrides into a new session', () => {
  const { signInUrl } = getLandingDestinations({ search: '?ref=TEAM42&app_id=other-app&access_token=untrusted&app_base_url=https%3A%2F%2Fexample.com' });
  const previousWindow = global.window;
  try {
    global.window = { location: new URL(signInUrl, 'https://firstknock.online') };
    assert.equal(safeReturnTo(), '/RoleSelect?ref=TEAM42');
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});
