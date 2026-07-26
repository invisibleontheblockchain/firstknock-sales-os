import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.TZ = 'America/Phoenix';

const {
  activityDayKey,
  buildUserActivityRows,
  getUserActivityRange,
  summarizeUserActivity,
} = await import('../src/lib/userActivityHeatmap.js');
const { buildPlatformAdoptionView } = await import('../src/admin/platformAdoption.js');

const phoenixNow = new Date('2026-07-25T12:00:00-07:00');

test('This Week is Monday through Sunday and compares the same elapsed weekdays', () => {
  const range = getUserActivityRange({ preset: 'this_week', now: phoenixNow });

  assert.equal(range.valid, true);
  assert.deepEqual(range.dates.map(activityDayKey), [
    '2026-07-20',
    '2026-07-21',
    '2026-07-22',
    '2026-07-23',
    '2026-07-24',
    '2026-07-25',
    '2026-07-26',
  ]);
  assert.deepEqual(range.elapsedDates.map(activityDayKey), [
    '2026-07-20',
    '2026-07-21',
    '2026-07-22',
    '2026-07-23',
    '2026-07-24',
    '2026-07-25',
  ]);
  assert.deepEqual(range.comparisonDates.map(activityDayKey), [
    '2026-07-13',
    '2026-07-14',
    '2026-07-15',
    '2026-07-16',
    '2026-07-17',
    '2026-07-18',
  ]);
  assert.equal(range.queryStart.toISOString(), '2026-07-13T07:00:00.000Z');
  assert.equal(range.queryEndExclusive.toISOString(), '2026-07-27T07:00:00.000Z');
});

test('Last Week and Last 30 Days use exact calendar-day windows', () => {
  const lastWeek = getUserActivityRange({ preset: 'last_week', now: phoenixNow });
  assert.deepEqual(lastWeek.dates.map(activityDayKey), [
    '2026-07-13',
    '2026-07-14',
    '2026-07-15',
    '2026-07-16',
    '2026-07-17',
    '2026-07-18',
    '2026-07-19',
  ]);

  const last30 = getUserActivityRange({ preset: 'last_30_days', now: phoenixNow });
  assert.equal(last30.dates.length, 30);
  assert.equal(activityDayKey(last30.dates[0]), '2026-06-26');
  assert.equal(activityDayKey(last30.dates[29]), '2026-07-25');
});

test('Custom ranges are inclusive and reject reversed, future, and oversized input', () => {
  const custom = getUserActivityRange({
    preset: 'custom',
    customStart: '2025-12-30',
    customEnd: '2026-01-02',
    now: new Date('2026-01-10T12:00:00-07:00'),
  });
  assert.equal(custom.valid, true);
  assert.deepEqual(custom.dates.map(activityDayKey), [
    '2025-12-30',
    '2025-12-31',
    '2026-01-01',
    '2026-01-02',
  ]);

  const oneDay = getUserActivityRange({
    preset: 'custom',
    customStart: '2026-07-20',
    customEnd: '2026-07-20',
    now: phoenixNow,
  });
  assert.deepEqual(oneDay.dates.map(activityDayKey), ['2026-07-20']);
  assert.equal(getUserActivityRange({
    preset: 'custom',
    customStart: '',
    customEnd: '2026-07-20',
    now: phoenixNow,
  }).valid, false);
  assert.equal(getUserActivityRange({
    preset: 'custom',
    customStart: 'not-a-date',
    customEnd: '2026-07-20',
    now: phoenixNow,
  }).valid, false);
  assert.equal(getUserActivityRange({
    preset: 'custom',
    customStart: '2026-01-03',
    customEnd: '2026-01-02',
    now: phoenixNow,
  }).valid, false);
  assert.equal(getUserActivityRange({
    preset: 'custom',
    customStart: '2026-07-20',
    customEnd: '2026-07-26',
    now: phoenixNow,
  }).valid, false);
  assert.equal(getUserActivityRange({
    preset: 'custom',
    customStart: '2025-01-01',
    customEnd: '2026-07-25',
    now: phoenixNow,
  }).valid, false);
});

test('Rows merge both ledgers, prefer stable user identity, and preserve inactive users', () => {
  const range = getUserActivityRange({
    preset: 'custom',
    customStart: '2026-07-20',
    customEnd: '2026-07-21',
    now: phoenixNow,
  });
  const members = [
    { id: 'tm-new', user_id: 'u-1', name: 'Nick', email: 'nick@firstknock.test' },
    { id: 'tm-2', user_id: 'u-2', name: 'Sean', email: 'sean@firstknock.test' },
  ];
  const rows = buildUserActivityRows({
    members,
    range,
    now: phoenixNow,
    dailyActivity: [
      {
        date: '2026-07-20',
        actor_user_id: 'u-1',
        actor_team_member_id: 'tm-old',
        logs: 2,
        doors: 2,
        sales: 1,
        callbacks: 0,
        canvas_logs: 2,
        last_activity: '2026-07-20T19:00:00.000Z',
      },
      {
        date: '2026-07-20',
        actor_email: ' NICK@FIRSTKNOCK.TEST ',
        logs: 1,
        doors: 1,
        sales: 0,
        callbacks: 1,
        knock_logs: 1,
        last_activity: '2026-07-20T20:00:00.000Z',
      },
      {
        date: '2026-07-21',
        actor_user_id: 'u-1',
        logs: 1,
        doors: 1,
        sales: 0,
        callbacks: 0,
        knock_logs: 1,
        last_activity: '2026-07-21T18:00:00.000Z',
      },
      {
        date: '2026-07-18',
        actor_user_id: 'u-1',
        logs: 1,
        doors: 1,
        sales: 0,
        callbacks: 0,
        knock_logs: 1,
        last_activity: '2026-07-18T18:00:00.000Z',
      },
    ],
  });

  assert.equal(rows.length, 2);
  assert.equal(rows[0].cells[0].logs, 3);
  assert.equal(rows[0].cells[0].doors, 3);
  assert.equal(rows[0].cells[0].sales, 1);
  assert.equal(rows[0].cells[0].callbacks, 1);
  assert.equal(rows[0].activeDays, 2);
  assert.equal(rows[0].activityPercent, 100);
  assert.equal(rows[0].comparisonActiveDays, 1);
  assert.equal(rows[1].activeDays, 0);

  const summary = summarizeUserActivity(rows);
  assert.deepEqual(summary, {
    totalUsers: 2,
    activeUsers: 1,
    consistentUsers: 1,
    activeUserDays: 2,
    adoptionPercent: 50,
    previousAdoptionPercent: 25,
    change: 25,
    direction: 'up',
  });
});

test('Team keeps its heatmap while HQ redirects before normal app authentication', () => {
  const hq = fs.readFileSync('src/pages/HQ.jsx', 'utf8');
  const app = fs.readFileSync('src/App.jsx', 'utf8');
  const layout = fs.readFileSync('src/Layout.jsx', 'utf8');
  const adminTeam = fs.readFileSync('src/pages/AdminTeam.jsx', 'utf8');

  assert.match(hq, /window\.location\.replace\(PRIVATE_HQ_PATH\)/);
  assert.match(app, /isPrivateHqAlias\(window\.location\.pathname\)/);
  assert.match(app, /\/hq\/index\.html\$\{window\.location\.search\}\$\{window\.location\.hash\}/);
  assert.match(layout, /label="Team".*createPageUrl\('AdminTeam'\)/);
  assert.match(layout, /canViewHQ && <a href="\/hq\/index\.html"/);
  assert.doesNotMatch(layout, /label="HQ".*createPageUrl\('HQ'\)/);
  assert.match(adminTeam, /canManageTeam && \(\s*<UserActivityHeatmap/);
  assert.match(adminTeam, /Team Command Center/);
  assert.doesNotMatch(adminTeam, /FirstKnock HQ/);
  assert.match(adminTeam, /teamLoadFailed && teamMembers\.length === 0/);
  assert.match(adminTeam, /InteractionLog\.filter\(\s*\{ manager_id: managerId \}/);
});

test('Platform adoption adapter feeds the shared grid without exposing raw activity records', () => {
  const view = buildPlatformAdoptionView({
    reps: [{
      key: 'user:rep_1',
      name: 'Rep One',
      email: 'rep@example.com',
      team_name: 'North',
      days: {
        '2026-07-20': {
          logs: 3,
          doors: 2,
          sales: 1,
          callbacks: 1,
          knock_logs: 2,
          canvas_logs: 1,
          last_activity_at: '2026-07-20T20:00:00.000Z',
        },
      },
    }],
  });

  assert.deepEqual(view.members, [{
    id: 'user:rep_1',
    name: 'Rep One',
    email: 'rep@example.com',
    role: 'North',
    team_name: 'North',
  }]);
  assert.equal(view.activity[0].actor_team_member_id, 'user:rep_1');
  assert.equal(view.activity[0].logs, 3);
  assert.equal(view.activity[0].doors, 2);
  assert.equal(view.activity[0].sales, 1);
  assert.equal(view.activity[0].last_activity, '2026-07-20T20:00:00.000Z');
});

test('Backend aggregation is manager-scoped, range-scoped, and returns no raw event PII', () => {
  const source = fs.readFileSync('base44/functions/getTeamActivityHeatmap/entry.ts', 'utf8');

  assert.match(source, /if \(!canManageTeam\(user\)\)/);
  assert.match(source, /user\?\.is_owner === true/);
  assert.match(source, /const managerId = String\(user\.id\)/);
  assert.match(source, /InteractionLog[\s\S]*manager_id: managerId, created_date: range/);
  assert.doesNotMatch(source, /manager_id:\s*null/);
  assert.match(source, /CanvasHouseEvent[\s\S]*write_status: "committed", client_recorded_at: range/);
  assert.match(source, /timeZoneDayKey\(timestamp, timeZone\)/);
  assert.match(source, /source === "csv_history_import"/);

  const successResponse = source.slice(source.indexOf('return Response.json({\n      success: true'));
  assert.doesNotMatch(successResponse, /\b(address|note|lat|lng|actor_email)\b/);
});
