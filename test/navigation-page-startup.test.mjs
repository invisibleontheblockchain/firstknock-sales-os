import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { getNavigationPageNames, matchNavigationPage } from '../src/lib/navigationPageNames.js';

test('navigation inventory reads route names without downloading or evaluating page components', () => {
    let loaded = 0;
    const modules = {
        '../pages/Home.jsx': () => { loaded += 1; throw new Error('Page must stay lazy'); },
        '../pages/AdminTeam.jsx': () => { loaded += 1; throw new Error('Page must stay lazy'); },
        '../pages/NewPage.js': () => { loaded += 1; throw new Error('Page must stay lazy'); },
    };
    const names = getNavigationPageNames(modules);
    assert.deepEqual(names, ['Home', 'AdminTeam', 'NewPage']);
    assert.equal(matchNavigationPage('/newpage', names), 'NewPage');
    assert.equal(loaded, 0);
});

test('activity matching preserves canonical names, case-insensitive routes, nested paths and root suppression', () => {
    const names = ['Home', 'List', 'RepHome', 'AdminTeam'];
    assert.equal(matchNavigationPage('/Home', names), 'Home');
    assert.equal(matchNavigationPage('/repHOME', names), 'RepHome');
    assert.equal(matchNavigationPage('/adminteam/member', names), 'AdminTeam');
    assert.equal(matchNavigationPage('/unknown', names), null);
    assert.equal(matchNavigationPage('/', names), null);
    assert.equal(matchNavigationPage('', names), null);
});

test('startup never imports the generated eager page registry and the tracker keeps authentication gating', () => {
    const tracker = readFileSync(new URL('../src/lib/NavigationTracker.jsx', import.meta.url), 'utf8');
    assert.match(tracker, /import\.meta\.glob\('\.\.\/pages\/\*\.\{jsx,js\}'\)/);
    assert.doesNotMatch(tracker, /eager:\s*true/);
    assert.match(tracker, /if \(isAuthenticated && pageName\)/);
    assert.match(tracker, /base44\.appLogs\.logUserInApp\(pageName\)/);
    const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? walk(path) : /\.(jsx?|tsx?)$/.test(entry.name) ? [path] : [];
    });
    for (const file of walk(fileURLToPath(new URL('../src', import.meta.url)))) {
        const source = readFileSync(file, 'utf8');
        assert.doesNotMatch(source, /(?:from\s*|import\s*\()['"][^'"]*pages\.config(?:\.(?:js|jsx))?['"]/, file);
    }
});
