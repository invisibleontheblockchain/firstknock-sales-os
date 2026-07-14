import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ALL_TIME_ANALYTICS_DAYS,
  fetchAllAnalyticsPages,
  filterAnalyticsRecords,
  getAnalyticsDateWindow,
  isWithinAnalyticsDateWindow,
  summarizeAnalyticsAppointments,
} from '../src/lib/analyticsDateFilter.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');
const readSource = (path) => readFileSync(resolve(rootDir, path), 'utf8');

test('a selected calendar day uses an inclusive local start and exclusive next-day boundary', () => {
  const selectedDate = new Date(2026, 6, 10, 12, 0, 0);
  const window = getAnalyticsDateWindow({ selectedDate });

  assert.equal(window.isSingleDay, true);
  assert.equal(window.label, 'Jul 10, 2026');
  assert.equal(isWithinAnalyticsDateWindow(new Date(2026, 6, 10, 0, 0, 0), window), true);
  assert.equal(isWithinAnalyticsDateWindow(new Date(2026, 6, 10, 23, 59, 59), window), true);
  assert.equal(isWithinAnalyticsDateWindow(new Date(2026, 6, 9, 23, 59, 59), window), false);
  assert.equal(isWithinAnalyticsDateWindow(new Date(2026, 6, 11, 0, 0, 0), window), false);
});

test('ISO timestamps and date-only appointment values stay on the intended local day', () => {
  const selectedDate = new Date(2026, 6, 10);
  const window = getAnalyticsDateWindow({ selectedDate });
  const localEveningAsIso = new Date(2026, 6, 10, 22, 30).toISOString();

  assert.equal(isWithinAnalyticsDateWindow(localEveningAsIso, window), true);
  assert.equal(isWithinAnalyticsDateWindow('2026-07-10', window), true);
  assert.equal(isWithinAnalyticsDateWindow('not-a-date', window), false);
});

test('Today and rolling presets cover exactly the advertised calendar dates', () => {
  const now = new Date(2026, 6, 14, 15, 30);
  const today = getAnalyticsDateWindow({ dateDays: 1, now });
  const sevenDays = getAnalyticsDateWindow({ dateDays: 7, now });

  assert.equal(isWithinAnalyticsDateWindow(new Date(2026, 6, 13, 23, 59), today), false);
  assert.equal(isWithinAnalyticsDateWindow(new Date(2026, 6, 14, 0, 0), today), true);
  assert.equal(isWithinAnalyticsDateWindow(new Date(2026, 6, 8, 0, 0), sevenDays), true);
  assert.equal(isWithinAnalyticsDateWindow(new Date(2026, 6, 7, 23, 59), sevenDays), false);
  assert.equal(isWithinAnalyticsDateWindow(new Date(2026, 6, 15, 0, 0), sevenDays), false);
});

test('the same selected day filters interaction logs and scheduled appointments', () => {
  const window = getAnalyticsDateWindow({ selectedDate: new Date(2026, 6, 10) });
  const logs = [
    { id: 'in', created_date: new Date(2026, 6, 10, 9).toISOString() },
    { id: 'out', created_date: new Date(2026, 6, 11, 9).toISOString() },
  ];
  const appointments = [
    { id: 'in', scheduled_date: '2026-07-10' },
    { id: 'out', scheduled_date: '2026-07-09' },
  ];

  assert.deepEqual(filterAnalyticsRecords(logs, 'created_date', window).map((record) => record.id), ['in']);
  assert.deepEqual(filterAnalyticsRecords(appointments, 'scheduled_date', window).map((record) => record.id), ['in']);
});

test('All Time keeps every valid dated record while excluding missing dates', () => {
  const window = getAnalyticsDateWindow({ dateDays: ALL_TIME_ANALYTICS_DAYS });
  const records = [
    { id: 'old', created_date: '2020-01-01T00:00:00Z' },
    { id: 'new', created_date: '2026-07-14T00:00:00Z' },
    { id: 'missing', created_date: null },
  ];

  assert.equal(window.isAllTime, true);
  assert.deepEqual(filterAnalyticsRecords(records, 'created_date', window).map((record) => record.id), ['old', 'new']);
});

test('historical record loading continues past the API page limit', async () => {
  const requestedSkips = [];
  const pages = new Map([
    [0, [{ id: '1' }, { id: '2' }]],
    [2, [{ id: '3' }, { id: '4' }]],
    [4, [{ id: '5' }]],
  ]);

  const records = await fetchAllAnalyticsPages((limit, skip) => {
    assert.equal(limit, 2);
    requestedSkips.push(skip);
    return pages.get(skip) || [];
  }, { pageSize: 2 });

  assert.deepEqual(requestedSkips, [0, 2, 4]);
  assert.deepEqual(records.map((record) => record.id), ['1', '2', '3', '4', '5']);
});

test('a historical day counts completed and no-show appointments, but not canceled ones', () => {
  const appointments = [
    { status: 'scheduled' },
    { status: 'completed' },
    { status: 'no_show' },
    { status: 'canceled' },
    { status: 'cancelled' },
  ];

  const historical = summarizeAnalyticsAppointments(appointments, { selectedDay: true });
  const preset = summarizeAnalyticsAppointments(appointments);

  assert.equal(historical.appointmentCount, 3);
  assert.equal(historical.noShowRate, 33);
  assert.equal(preset.appointmentCount, 1);
  assert.equal(preset.noShowRate, 20);
});

test('Analytics UI wires the historical day through every date-anchored panel', () => {
  const listSource = readSource('src/pages/List.jsx');
  const headerSource = readSource('src/components/analytics/rep/RepAnalyticsHeader.jsx');
  const revenueSource = readSource('src/components/analytics/rep/RevenueMetrics.jsx');
  const advancedSource = readSource('src/components/analytics/rep/RepAdvancedAnalytics.jsx');
  const appointmentSource = readSource('src/components/analytics/AppointmentTimeline.jsx');
  const timeOfDaySource = readSource('src/components/analytics/TimeOfDayEffectiveness.jsx');

  assert.match(headerSource, /mode="single"/);
  assert.match(headerSource, /disabled=\{\{ after: startOfDay\(new Date\(\)\) \}\}/);
  assert.match(headerSource, /onSelect=\{selectDate\}/);
  assert.match(headerSource, /aria-pressed=\{!selectedDate && dateDays === r\.value\}/);
  assert.match(headerSource, /format\(selectedDate, 'MMM d, yyyy'\)/);
  assert.equal((listSource.match(/selectedDate=\{selectedDate\}/g) || []).length, 5);
  assert.match(listSource, /if \(day > startOfDay\(new Date\(\)\)\) return/);
  assert.match(listSource, /fetchAllAnalyticsPages/);
  assert.match(listSource, /hasAnalyticsError/);
  assert.match(listSource, /aria-busy=\{isLoading\}/);
  assert.match(listSource, /The data request failed, so this is not being shown as a zero-activity day/);
  assert.match(listSource, /: 'N\/A'/);
  assert.match(listSource, /StatusBreakdown properties=\{selectedDate \? periodOutcomeProperties : analyticsProperties\}/);
  assert.match(revenueSource, /selectedDate \? format\(selectedDate, 'EEEE, MMM d, yyyy'\)/);
  assert.match(advancedSource, /const anchorDate = selectedDate \|\| new Date\(\)/);
  assert.match(appointmentSource, /const anchorDate = startOfDay\(selectedDate \|\| new Date\(\)\)/);
  assert.match(appointmentSource, /No appointments were recorded on this day/);
  assert.match(timeOfDaySource, /No time-of-day activity was recorded for this period/);
});
