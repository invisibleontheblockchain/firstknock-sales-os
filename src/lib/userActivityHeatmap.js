import {
  addDays,
  differenceInCalendarDays,
  eachDayOfInterval,
  format,
  isAfter,
  isValid,
  parseISO,
  startOfDay,
  startOfWeek,
  subDays,
  subWeeks,
} from 'date-fns';

export const ACTIVITY_RANGE_PRESETS = [
  { id: 'this_week', label: 'This Week' },
  { id: 'last_week', label: 'Last Week' },
  { id: 'last_30_days', label: 'Last 30 Days' },
  { id: 'custom', label: 'Custom' },
];

export const MAX_CUSTOM_ACTIVITY_DAYS = 366;

function emptyRange(preset, error) {
  return {
    preset,
    valid: false,
    error,
    dates: [],
    elapsedDates: [],
    comparisonDates: [],
    queryStart: null,
    queryEndExclusive: null,
    label: 'Custom range',
  };
}

export function parseActivityDate(value) {
  if (value instanceof Date) return isValid(value) ? value : null;
  if (!value) return null;
  const parsed = parseISO(String(value));
  return isValid(parsed) ? parsed : null;
}

export function activityDayKey(value) {
  const parsed = parseActivityDate(value);
  return parsed ? format(parsed, 'yyyy-MM-dd') : null;
}

export function toActivityDateInput(value) {
  const parsed = parseActivityDate(value);
  return parsed ? format(parsed, 'yyyy-MM-dd') : '';
}

export function getUserActivityRange({
  preset = 'this_week',
  customStart,
  customEnd,
  now = new Date(),
} = {}) {
  const parsedNow = parseActivityDate(now) || new Date();
  const today = startOfDay(parsedNow);
  let start;
  let end;

  if (preset === 'last_week') {
    start = startOfWeek(subWeeks(today, 1), { weekStartsOn: 1 });
    end = addDays(start, 6);
  } else if (preset === 'last_30_days') {
    start = subDays(today, 29);
    end = today;
  } else if (preset === 'custom') {
    const parsedStart = parseActivityDate(customStart);
    const parsedEnd = parseActivityDate(customEnd);
    if (!parsedStart || !parsedEnd) {
      return emptyRange(preset, 'Choose both a start and end date.');
    }
    start = startOfDay(parsedStart);
    end = startOfDay(parsedEnd);
    if (isAfter(start, end)) {
      return emptyRange(preset, 'Start date must be before the end date.');
    }
    if (isAfter(end, today)) {
      return emptyRange(preset, 'Custom ranges cannot end in the future.');
    }
    const customDayCount = differenceInCalendarDays(end, start) + 1;
    if (customDayCount > MAX_CUSTOM_ACTIVITY_DAYS) {
      return emptyRange(preset, `Custom ranges can include up to ${MAX_CUSTOM_ACTIVITY_DAYS} days.`);
    }
  } else {
    start = startOfWeek(today, { weekStartsOn: 1 });
    end = addDays(start, 6);
  }

  const dates = eachDayOfInterval({ start, end });
  const elapsedDates = dates.filter((date) => !isAfter(date, today));
  const comparisonOffsetDays = dates.length;
  const comparisonDates = elapsedDates.map((date) => subDays(date, comparisonOffsetDays));
  const queryStart = startOfDay(comparisonDates[0] || start);
  const queryEndExclusive = addDays(startOfDay(end), 1);
  const label = format(start, 'MMM d') === format(end, 'MMM d')
    ? format(start, 'MMM d, yyyy')
    : `${format(start, 'MMM d')} - ${format(end, 'MMM d, yyyy')}`;

  return {
    preset,
    valid: true,
    error: null,
    start,
    end,
    dates,
    elapsedDates,
    comparisonDates,
    queryStart,
    queryEndExclusive,
    label,
  };
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function numericMetric(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function roundedMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function mergeCell(target, activity) {
  target.logs += numericMetric(activity.logs ?? activity.log_count);
  target.doors += numericMetric(activity.doors ?? activity.doors_knocked);
  target.sales += numericMetric(activity.sales);
  target.recordedSalesVolume = roundedMoney(
    target.recordedSalesVolume + numericMetric(
      activity.recorded_sales_volume ?? activity.recordedSalesVolume
    )
  );
  target.callbacks += numericMetric(activity.callbacks);
  target.knockLogs += numericMetric(activity.knock_logs);
  target.canvasLogs += numericMetric(activity.canvas_logs);

  const candidate = parseActivityDate(activity.last_activity ?? activity.last_activity_at);
  if (candidate && (!target.lastActivity || candidate > target.lastActivity)) {
    target.lastActivity = candidate;
  }
  target.active = target.logs > 0;
}

function createIdentityIndex(members) {
  const rows = [];
  const byUserId = new Map();
  const byMemberId = new Map();
  const byEmail = new Map();
  const seen = new Set();

  for (const member of members || []) {
    const stableKey = member?.user_id
      ? `user:${member.user_id}`
      : member?.id
        ? `member:${member.id}`
        : `email:${normalizeEmail(member?.email)}`;
    if (!stableKey || stableKey === 'email:' || seen.has(stableKey)) continue;
    seen.add(stableKey);
    const row = { key: stableKey, member };
    rows.push(row);
    if (member?.user_id) byUserId.set(String(member.user_id), row);
    if (member?.id) byMemberId.set(String(member.id), row);
    if (normalizeEmail(member?.email)) byEmail.set(normalizeEmail(member.email), row);
  }

  return { rows, byUserId, byMemberId, byEmail };
}

function resolveActivityIdentity(activity, index) {
  const byUser = activity?.actor_user_id
    ? index.byUserId.get(String(activity.actor_user_id))
    : null;
  const byMember = activity?.actor_team_member_id
    ? index.byMemberId.get(String(activity.actor_team_member_id))
    : null;
  const byEmail = normalizeEmail(activity?.actor_email)
    ? index.byEmail.get(normalizeEmail(activity.actor_email))
    : null;

  const resolved = byUser || byMember || byEmail || null;
  const candidates = [byUser, byMember].filter(Boolean);
  if (candidates.some((candidate) => candidate.key !== resolved?.key)) return null;
  return resolved;
}

function createBlankCell(date, now) {
  const day = startOfDay(date);
  return {
    date: day,
    dateKey: activityDayKey(day),
    active: false,
    isFuture: isAfter(day, startOfDay(now)),
    logs: 0,
    doors: 0,
    sales: 0,
    recordedSalesVolume: 0,
    callbacks: 0,
    knockLogs: 0,
    canvasLogs: 0,
    lastActivity: null,
  };
}

export function buildUserActivityRows({
  members = [],
  dailyActivity = [],
  range,
  now = new Date(),
} = {}) {
  if (!range?.valid) return [];
  const identityIndex = createIdentityIndex(members);
  const currentKeys = new Set(range.dates.map(activityDayKey));
  const comparisonKeys = new Set(range.comparisonDates.map(activityDayKey));
  const currentByIdentity = new Map();
  const comparisonByIdentity = new Map();

  for (const activity of dailyActivity || []) {
    const identity = resolveActivityIdentity(activity, identityIndex);
    const dateKey = String(activity?.date || '');
    if (!identity || !dateKey) continue;
    const targetMap = currentKeys.has(dateKey)
      ? currentByIdentity
      : comparisonKeys.has(dateKey)
        ? comparisonByIdentity
        : null;
    if (!targetMap) continue;
    const identityDays = targetMap.get(identity.key) || new Map();
    const cell = identityDays.get(dateKey) || createBlankCell(parseISO(dateKey), now);
    mergeCell(cell, activity);
    identityDays.set(dateKey, cell);
    targetMap.set(identity.key, identityDays);
  }

  const eligibleKeys = new Set(range.elapsedDates.map(activityDayKey));
  const comparisonEligibleKeys = new Set(range.comparisonDates.map(activityDayKey));

  return identityIndex.rows.map(({ key, member }) => {
    const currentDays = currentByIdentity.get(key) || new Map();
    const comparisonDays = comparisonByIdentity.get(key) || new Map();
    const cells = range.dates.map((date) => {
      const dateKey = activityDayKey(date);
      return currentDays.get(dateKey) || createBlankCell(date, now);
    });
    const activeDays = cells.filter((cell) => eligibleKeys.has(cell.dateKey) && cell.active).length;
    const eligibleDays = eligibleKeys.size;
    const comparisonActiveDays = [...comparisonEligibleKeys]
      .filter((dateKey) => comparisonDays.get(dateKey)?.active)
      .length;
    const comparisonEligibleDays = comparisonEligibleKeys.size;
    const totalSales = cells.reduce((sum, cell) => sum + numericMetric(cell.sales), 0);
    const recordedSalesVolume = roundedMoney(
      cells.reduce((sum, cell) => sum + numericMetric(cell.recordedSalesVolume), 0)
    );

    return {
      key,
      member,
      cells,
      totalSales,
      recordedSalesVolume,
      activeDays,
      eligibleDays,
      activityPercent: eligibleDays ? Math.round((activeDays / eligibleDays) * 100) : 0,
      comparisonActiveDays,
      comparisonEligibleDays,
      comparisonPercent: comparisonEligibleDays
        ? Math.round((comparisonActiveDays / comparisonEligibleDays) * 100)
        : 0,
      isConsistent: eligibleDays > 0 && activeDays === eligibleDays,
      isInactive: activeDays === 0,
    };
  });
}

function rowActivityLogs(row) {
  return (row?.cells || []).reduce((sum, cell) => sum + numericMetric(cell?.logs), 0);
}

function rowLatestActivity(row) {
  return (row?.cells || []).reduce((latest, cell) => {
    const timestamp = cell?.lastActivity instanceof Date
      ? cell.lastActivity.getTime()
      : parseActivityDate(cell?.lastActivity)?.getTime();
    return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
  }, 0);
}

export function sortUserActivityRowsByActivity(rows = []) {
  return [...rows].sort((left, right) => (
    Number(right?.activeDays || 0) - Number(left?.activeDays || 0)
    || rowActivityLogs(right) - rowActivityLogs(left)
    || rowLatestActivity(right) - rowLatestActivity(left)
    || String(left?.member?.name || left?.member?.email || '').localeCompare(
      String(right?.member?.name || right?.member?.email || '')
    )
  ));
}

export function summarizeUserActivity(rows = []) {
  const eligibleDays = rows[0]?.eligibleDays || 0;
  const comparisonEligibleDays = rows[0]?.comparisonEligibleDays || 0;
  const activeUsers = rows.filter((row) => row.activeDays > 0).length;
  const consistentUsers = rows.filter((row) => row.isConsistent).length;
  const activeUserDays = rows.reduce((sum, row) => sum + row.activeDays, 0);
  const comparisonActiveUserDays = rows.reduce((sum, row) => sum + row.comparisonActiveDays, 0);
  const denominator = rows.length * eligibleDays;
  const comparisonDenominator = rows.length * comparisonEligibleDays;
  const adoptionPercent = denominator ? Math.round((activeUserDays / denominator) * 100) : 0;
  const previousAdoptionPercent = comparisonDenominator
    ? Math.round((comparisonActiveUserDays / comparisonDenominator) * 100)
    : 0;
  const change = adoptionPercent - previousAdoptionPercent;

  return {
    totalUsers: rows.length,
    activeUsers,
    consistentUsers,
    activeUserDays,
    adoptionPercent,
    previousAdoptionPercent,
    change,
    direction: change > 0 ? 'up' : change < 0 ? 'down' : 'flat',
  };
}
