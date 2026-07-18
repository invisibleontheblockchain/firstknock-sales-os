import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fetchAllCanvasTeamMembers } from '../src/components/canvas/canvasRosterPagination.js';

test('Canvas roster pagination loads every page and deduplicates boundary records', async () => {
  const requestedPages = [];
  const pages = new Map([
    [0, [{ id: 'rep_1' }, { id: 'rep_2' }, { id: 'rep_3' }]],
    [3, { items: [{ id: 'rep_3' }, { id: 'rep_4' }, { id: 'rep_5' }] }],
    [6, [{ id: 'rep_6' }]],
  ]);

  const members = await fetchAllCanvasTeamMembers((limit, skip) => {
    assert.equal(limit, 3);
    requestedPages.push(skip);
    return pages.get(skip) || [];
  }, { pageSize: 3 });

  assert.deepEqual(requestedPages, [0, 3, 6]);
  assert.deepEqual(members.map((member) => member.id), [
    'rep_1',
    'rep_2',
    'rep_3',
    'rep_4',
    'rep_5',
    'rep_6',
  ]);
});

test('Canvas roster pagination fails closed when the API repeats a full page', async () => {
  const repeated = [{ id: 'rep_1' }, { id: 'rep_2' }];
  await assert.rejects(
    fetchAllCanvasTeamMembers(() => repeated, { pageSize: 2, maxPages: 4 }),
    /repeated a page/i,
  );
});

test('Canvas roster pagination has a bounded termination guard', async () => {
  await assert.rejects(
    fetchAllCanvasTeamMembers((_limit, skip) => [
      { id: `rep_${skip + 1}` },
      { id: `rep_${skip + 2}` },
    ], { pageSize: 2, maxPages: 2 }),
    /exceeded 2 pages/i,
  );
});

test('Home wires Base44 limit and skip through the paginated Canvas roster loader', () => {
  const home = readFileSync(new URL('../src/pages/Home.jsx', import.meta.url), 'utf8');
  const routeBuilder = readFileSync(new URL('../src/components/map/RouteBuilderSettings.jsx', import.meta.url), 'utf8');
  assert.match(home, /queryKey: \['teamMembers', user\?\.id\][\s\S]*?TeamMember\.filter\(\{ manager_id: user\.id \}, '-created_date', 250\)/);
  assert.match(home, /queryKey: \['canvasTeamMembers', user\?\.id\]/);
  assert.match(home, /fetchAllCanvasTeamMembers\(\(limit, skip\) => \(/);
  assert.match(home, /TeamMember\.filter\(\{ manager_id: user\.id \}, '-created_date', limit, skip\)/);
  assert.match(home, /refetch: refetchCanvasTeamMembers/);
  assert.match(home, /onRefreshCanvasTeamMembers=\{refreshCanvasTeamMembers\}/);
  assert.match(routeBuilder, /onRefreshTeamMembers=\{onRefreshCanvasTeamMembers\}/);
});

test('Canvas toolbar labels the planner handoff honestly without changing Precision actions', () => {
  const toolbar = readFileSync(new URL('../src/components/map/MapToolbar.jsx', import.meta.url), 'utf8');
  const canvasStart = toolbar.indexOf("routeMode === 'canvas' && mode === 'generate'");
  const precisionStart = toolbar.indexOf("{mode === 'generate' && !activeRoute", canvasStart);
  const canvasActions = toolbar.slice(canvasStart, precisionStart);

  assert.match(canvasActions, /NEW AREA/);
  assert.match(canvasActions, /AREAS/);
  assert.match(toolbar, /fk-canvas-planner-view-requested/);
  assert.doesNotMatch(canvasActions, /FOCUS MODE|LIVE VIEW|REVIEW & SEND|DEPLOY CAMPAIGN/);
  assert.match(toolbar.slice(precisionStart), /fk-open-precision-pull/);
});
