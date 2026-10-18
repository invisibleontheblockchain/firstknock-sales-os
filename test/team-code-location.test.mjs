import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../src/pages/AdminTeam.jsx', import.meta.url), 'utf8');
const header = page.slice(page.indexOf('{/* Header Section */}'), page.indexOf('<Tabs '));
const codesTab = page.slice(page.indexOf('<TabsContent value="access"'), page.indexOf('</TabsContent>', page.indexOf('<TabsContent value="access"')));

test('the Team header shows no team-code banner, for any role', () => {
    assert.ok(header.length > 0);
    assert.doesNotMatch(header, /Team Code:/);
    assert.doesNotMatch(header, /Team code copied/);
    // The header still has its team filter, Switch Role and Add Rep.
    assert.match(header, /All Teams/);
    assert.match(header, /Switch Role/);
    assert.match(header, /Add Rep/);
});

test('team codes stay reachable, with copy, under the Codes tab for everyone who had the banner', () => {
    // The banner showed only when canManageTeam; the Codes tab shows on the same condition.
    assert.match(page, /<TabsTrigger value="access" className=\{`\$\{canManageTeam \? 'flex' : 'hidden'\}/);
    assert.match(codesTab, /inviteCodes\.filter\(c => c\.linked_user_id === user\?\.id\)\.map/);
    assert.match(codesTab, /navigator\.clipboard\.writeText\(code\.code\)/);
    assert.match(codesTab, /Copy Code/);
});
