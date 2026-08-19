/**
 * WHERE AN ACCOUNT LANDS after sign-in or role selection.
 *
 * RoleSelect compared `app_role === 'manager'` directly, so every other
 * manager-shaped account — app_role 'admin', account role 'admin', and anyone
 * carrying is_owner — was redirected to RepHome. RepHome is Knock Mode: no
 * route builder, no Precision generation. An owner sent there sees a product
 * missing half its features and reasonably reports that their app is not
 * behaving like everyone else's.
 *
 * isManagerAccount already knew every shape a manager can take. The routing
 * has to ask it rather than re-derive a narrower answer, which is the same
 * correction TeamChat already carries a comment about.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isManagerAccount, isRepAccount, landingPageForAccount } from '../src/lib/roles.js';

// The reported account, verbatim from its User record.
const CHRISTIAN = {
    id: '6978c7229935cf40cde25086',
    email: 'christian@nativapest.com',
    role: 'admin',
    app_role: 'admin',
    is_owner: true
};

test('LAND-01 an admin owner lands on Home, not the rep surface', () => {
    assert.equal(landingPageForAccount(CHRISTIAN), 'Home');
    assert.equal(isManagerAccount(CHRISTIAN), true);
    assert.equal(isRepAccount(CHRISTIAN), false);
});

test('LAND-02 every manager-shaped account reaches Home', () => {
    const shapes = [
        { app_role: 'manager' },
        { app_role: 'admin' },
        { role: 'manager' },
        { role: 'admin' },
        { is_owner: true },
        { is_owner: true, app_role: 'rep' }
    ];
    for (const user of shapes) {
        assert.equal(landingPageForAccount(user), 'Home', JSON.stringify(user));
    }
});

test('LAND-03 an actual rep still lands on RepHome', () => {
    assert.equal(landingPageForAccount({ app_role: 'rep', team_manager_id: 'mgr_1' }), 'RepHome');
    assert.equal(landingPageForAccount({ app_role: 'rep', is_owner: false }), 'RepHome');
});

test('LAND-04 an unknown or absent role is not treated as a manager', () => {
    // RoleSelect only redirects once app_role exists, but the helper must not
    // hand Home to an account with no established role.
    assert.equal(landingPageForAccount({}), 'RepHome');
    assert.equal(landingPageForAccount(null), 'RepHome');
    assert.equal(landingPageForAccount({ app_role: '' }), 'RepHome');
});

test('LAND-05 RoleSelect routes through the helper, not a bare role compare', () => {
    const source = readFileSync('src/pages/RoleSelect.jsx', 'utf8');
    assert.match(source, /landingPageForAccount\(user\)/);
    // The regression: the auto-redirect branching on app_role directly.
    assert.doesNotMatch(
        source,
        /if \(user\.app_role === 'manager'\)/,
        'the auto-redirect must not re-derive the destination from app_role'
    );
});
