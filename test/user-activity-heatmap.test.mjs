import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.TZ = 'America/Phoenix';

const {
  activityDayKey,
  buildUserActivityRows,
  getUserActivityRange,
  sortUserActivityRowsByActivity,
  sortUserActivityRowsByPerformance,
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

test('All Time spans complete available history without inventing a prior period', () => {
  const allTime = getUserActivityRange({
    preset: 'all_time',
    minimumDate: '2024-01-15',
    now: phoenixNow,
  });

  assert.equal(allTime.valid, true);
  assert.equal(allTime.aggregateOnly, true);
  assert.equal(activityDayKey(allTime.dates[0]), '2024-01-15');
  assert.equal(activityDayKey(allTime.dates.at(-1)), '2026-07-25');
  assert.deepEqual(allTime.comparisonDates, []);
  assert.equal(allTime.queryStart.toISOString(), '2024-01-15T07:00:00.000Z');
  assert.equal(allTime.queryEndExclusive.toISOString(), '2026-07-26T07:00:00.000Z');
  assert.match(allTime.label, /^All Time · Jan 15, 2024 - Jul 25, 2026$/);
  assert.equal(getUserActivityRange({ preset: 'all_time', now: phoenixNow }).valid, false);
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

test('Sales and revenue totals follow every HQ date constraint including All Time', () => {
  const members = [{ id: 'rep', name: 'Range Rep' }];
  const dailyActivity = [
    { actor_team_member_id: 'rep', date: '2026-07-20', logs: 1, sales: 1, recorded_sales_volume: 100 },
    { actor_team_member_id: 'rep', date: '2026-07-15', logs: 1, sales: 2, recorded_sales_volume: 200 },
    { actor_team_member_id: 'rep', date: '2026-07-01', logs: 1, sales: 3, recorded_sales_volume: 300 },
    { actor_team_member_id: 'rep', date: '2026-05-01', logs: 1, sales: 4, recorded_sales_volume: 400 },
  ];
  const scenarios = [
    { preset: 'this_week', expectedSales: 1, expectedRevenue: 100 },
    { preset: 'last_week', expectedSales: 2, expectedRevenue: 200 },
    { preset: 'last_30_days', expectedSales: 6, expectedRevenue: 600 },
    {
      preset: 'custom',
      customStart: '2026-07-14',
      customEnd: '2026-07-21',
      expectedSales: 3,
      expectedRevenue: 300,
    },
    {
      preset: 'all_time',
      minimumDate: '2026-05-01',
      expectedSales: 10,
      expectedRevenue: 1000,
    },
  ];

  for (const scenario of scenarios) {
    const range = getUserActivityRange({ ...scenario, now: phoenixNow });
    const [row] = buildUserActivityRows({ members, dailyActivity, range, now: phoenixNow });
    assert.equal(row.totalSales, scenario.expectedSales, `${scenario.preset} sales`);
    assert.equal(row.recordedSalesVolume, scenario.expectedRevenue, `${scenario.preset} revenue`);
  }

  const allTimeRange = getUserActivityRange({
    preset: 'all_time',
    minimumDate: '2026-05-01',
    now: phoenixNow,
  });
  const allTimeRows = buildUserActivityRows({
    members,
    dailyActivity,
    range: allTimeRange,
    now: phoenixNow,
  });
  const allTimeSummary = summarizeUserActivity(allTimeRows, { hasComparison: false });
  assert.equal(allTimeSummary.hasComparison, false);
  assert.equal(allTimeSummary.previousAdoptionPercent, null);
  assert.equal(allTimeSummary.change, null);
  assert.equal(allTimeSummary.direction, 'none');
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
        recorded_sales_volume: 120.25,
        callbacks: 0,
        canvas_logs: 2,
        last_activity: '2026-07-20T19:00:00.000Z',
      },
      {
        date: '2026-07-20',
        actor_email: ' NICK@FIRSTKNOCK.TEST ',
        logs: 1,
        doors: 1,
        sales: 1,
        recorded_sales_volume: 30.25,
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
        recorded_sales_volume: 999,
        callbacks: 0,
        knock_logs: 1,
        last_activity: '2026-07-18T18:00:00.000Z',
      },
    ],
  });

  assert.equal(rows.length, 2);
  assert.equal(rows[0].cells[0].logs, 3);
  assert.equal(rows[0].cells[0].doors, 3);
  assert.equal(rows[0].cells[0].sales, 2);
  assert.equal(rows[0].cells[0].recordedSalesVolume, 150.5);
  assert.equal(rows[0].cells[0].callbacks, 1);
  assert.equal(rows[0].totalSales, 2);
  assert.equal(rows[0].recordedSalesVolume, 150.5);
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
    totalLogs: 4,
    totalSales: 2,
    recordedSalesVolume: 150.5,
    hasComparison: true,
    previousAdoptionPercent: 25,
    change: 25,
    direction: 'up',
  });
});

test('Team keeps its heatmap while HQ redirects before normal app authentication', () => {
  const hq = fs.readFileSync('src/pages/HQ.jsx', 'utf8');
  const app = fs.readFileSync('src/App.jsx', 'utf8');
  const adminDashboard = fs.readFileSync('src/admin/AdminDashboard.jsx', 'utf8');
  const heatmap = fs.readFileSync('src/components/analytics/team/UserActivityHeatmap.jsx', 'utf8');
  const layout = fs.readFileSync('src/Layout.jsx', 'utf8');
  const adminTeam = fs.readFileSync('src/pages/AdminTeam.jsx', 'utf8');

  assert.match(hq, /window\.location\.replace\(PRIVATE_HQ_PATH\)/);
  assert.match(app, /isPrivateHqAlias\(window\.location\.pathname\)/);
  assert.match(app, /\/hq\/index\.html\$\{window\.location\.search\}\$\{window\.location\.hash\}/);
  assert.match(layout, /label="Team".*createPageUrl\('AdminTeam'\)/);
  assert.doesNotMatch(layout, /canViewHQ|canViewPlatformDashboard|\/hq\/index\.html|FirstKnock HQ/);
  assert.doesNotMatch(layout, /label="HQ".*createPageUrl\('HQ'\)/);
  assert.match(adminTeam, /canManageTeam && \(\s*<UserActivityHeatmap/);
  assert.doesNotMatch(adminTeam, /rankByActivity/);
  assert.doesNotMatch(adminTeam, /allowAllTime|mobileCardLayout|rankByPerformance/);
  assert.doesNotMatch(adminTeam, /showProductionTotals/);
  assert.match(adminDashboard, /<UserActivityHeatmap[\s\S]*allowAllTime[\s\S]*mobileCardLayout[\s\S]*rankByPerformance[\s\S]*showProductionTotals[\s\S]*scopeLabel="Platform"/);
  assert.match(heatmap, /option\.id !== 'all_time' \|\| allowAllTime/);
  assert.match(heatmap, /Rows rank by sales, recorded revenue, active days, logs, and recent activity/);
  assert.match(heatmap, /grid w-full min-w-0 grid-cols-\[minmax\(0,1fr\)_auto\]/);
  assert.match(heatmap, /<select[\s\S]*aria-label="Activity date range"[\s\S]*sm:hidden/);
  assert.match(heatmap, /overflow-x-auto rounded-xl[\s\S]*\[scrollbar-width:none\]/);
  assert.match(heatmap, /className="flex h-11 w-11[\s\S]*sm:h-10 sm:w-10"/);
  const mobileViewStart = heatmap.indexOf('data-activity-view="mobile"');
  const desktopViewStart = heatmap.indexOf('data-activity-view="desktop"');
  assert.ok(mobileViewStart > -1 && desktopViewStart > mobileViewStart);
  const mobileView = heatmap.slice(mobileViewStart, desktopViewStart);
  assert.match(mobileView, /className="grid gap-2 p-2 md:grid-cols-2 md:gap-3 md:p-4 lg:hidden"/);
  assert.match(mobileView, /data-activity-card="user"/);
  assert.match(mobileView, /row\.totalSales/);
  assert.match(mobileView, /recordedRevenueFormatter\.format\(row\.recordedSalesVolume\)/);
  assert.match(mobileView, /range\.aggregateOnly \? row\.activeDays : `\$\{row\.activeDays\}\/\$\{row\.eligibleDays\}`/);
  assert.match(mobileView, /\{!range\.aggregateOnly && \(/);
  assert.match(mobileView, /row\.cells\.slice\(-31\)/);
  assert.match(mobileView, /<ActivityCell[\s\S]*compact/);
  assert.doesNotMatch(mobileView, /<table|minWidth/);
  const desktopView = heatmap.slice(desktopViewStart);
  assert.match(desktopView, /mobileCardLayout \? 'hidden overflow-x-auto lg:block' : 'overflow-x-auto'/);
  assert.match(desktopView, /<table/);
  assert.match(desktopView, /Math\.max\(tableMinWidth, 720\)/);
  const tableHead = heatmap.slice(heatmap.indexOf('<thead>'), heatmap.indexOf('</thead>'));
  const tableBody = heatmap.slice(heatmap.indexOf('<tbody>'), heatmap.indexOf('</tbody>'));
  assert.ok(
    tableHead.indexOf('{!performanceFirst && visibleDates.map') < tableHead.indexOf('{showProductionTotals && ('),
    'Team date headers must remain before optional production totals'
  );
  assert.ok(
    tableBody.indexOf('{!performanceFirst && !range.aggregateOnly && row.cells.map') < tableBody.indexOf('{showProductionTotals && ('),
    'Team activity cells must remain before optional production totals'
  );
  assert.match(tableHead, /performanceFirst \? '' : 'sticky right-0 z-20'/);
  assert.match(tableBody, /performanceFirst \? '' : 'sticky right-0 z-10'/);
  assert.ok(
    tableHead.indexOf('{performanceFirst && visibleDates.map') > tableHead.indexOf('Usage days'),
    'HQ date headers must remain after sales, revenue, and usage'
  );
  assert.ok(
    tableBody.indexOf('{performanceFirst && !range.aggregateOnly && row.cells.map') > tableBody.indexOf('row.activityPercent'),
    'HQ activity cells must remain after sales, revenue, and usage'
  );
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
          recorded_sales_volume: 275.5,
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
  assert.equal(view.activity[0].recorded_sales_volume, 275.5);
  assert.equal(view.activity[0].last_activity, '2026-07-20T20:00:00.000Z');
});

test('Platform adoption removes internal duplicate accounts by normalized display name', () => {
  const view = buildPlatformAdoptionView({
    reps: [
      { key: 'user:keep', name: 'Visible Rep', days: {} },
      { key: 'user:irobot-1', name: 'Irobot v2', days: {} },
      { key: 'user:irobot-2', name: '  IROBOT   V2 ', days: {} },
      { key: 'user:nick-1', name: 'Nick Cohen', days: {} },
      { key: 'user:nick-2', name: 'Nicholas Cohen', days: {} },
      { key: 'user:cory', name: 'Cory Larson', days: {} },
    ],
  });

  assert.deepEqual(view.members.map((member) => member.name), ['Visible Rep']);
});

test('HQ activity ranking uses selected-range active days, then logs, with inactive users last', () => {
  const range = getUserActivityRange({ preset: 'this_week', now: phoenixNow });
  const members = [
    { id: 'inactive', name: 'Inactive Rep' },
    { id: 'burst', name: 'Burst Rep' },
    { id: 'steady', name: 'Steady Rep' },
    { id: 'quiet', name: 'Quiet Rep' },
  ];
  const dailyActivity = [
    { actor_team_member_id: 'steady', date: '2026-07-20', logs: 1 },
    { actor_team_member_id: 'steady', date: '2026-07-21', logs: 1 },
    { actor_team_member_id: 'burst', date: '2026-07-20', logs: 10 },
    { actor_team_member_id: 'quiet', date: '2026-07-20', logs: 1 },
  ];
  const rows = buildUserActivityRows({ members, dailyActivity, range, now: phoenixNow });
  const ranked = sortUserActivityRowsByActivity(rows);

  assert.deepEqual(ranked.map((row) => row.member.name), [
    'Steady Rep',
    'Burst Rep',
    'Quiet Rep',
    'Inactive Rep',
  ]);
  assert.deepEqual(rows.map((row) => row.member.name), members.map((member) => member.name));
});

test('HQ performance ranking prioritizes sales, revenue, then usage from top to bottom', () => {
  const range = getUserActivityRange({ preset: 'this_week', now: phoenixNow });
  const members = [
    { id: 'inactive', name: 'Inactive Rep' },
    { id: 'usage', name: 'Usage Leader' },
    { id: 'revenue', name: 'Revenue Leader' },
    { id: 'sales', name: 'Sales Leader' },
    { id: 'logs', name: 'Log Leader' },
  ];
  const dailyActivity = [
    { actor_team_member_id: 'sales', date: '2026-07-20', logs: 1, sales: 3, recorded_sales_volume: 100 },
    { actor_team_member_id: 'revenue', date: '2026-07-20', logs: 1, sales: 2, recorded_sales_volume: 1000 },
    { actor_team_member_id: 'usage', date: '2026-07-20', logs: 1, sales: 2, recorded_sales_volume: 500 },
    { actor_team_member_id: 'usage', date: '2026-07-21', logs: 1 },
    { actor_team_member_id: 'logs', date: '2026-07-20', logs: 10, sales: 2, recorded_sales_volume: 500 },
  ];
  const rows = buildUserActivityRows({ members, dailyActivity, range, now: phoenixNow });
  const ranked = sortUserActivityRowsByPerformance(rows);

  assert.deepEqual(ranked.map((row) => row.member.name), [
    'Sales Leader',
    'Revenue Leader',
    'Usage Leader',
    'Log Leader',
    'Inactive Rep',
  ]);
  assert.deepEqual(rows.map((row) => row.member.name), members.map((member) => member.name));
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
