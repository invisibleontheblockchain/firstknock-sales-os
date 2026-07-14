import { addDays, format, isValid, parseISO, startOfDay, subDays } from 'date-fns';

export const ALL_TIME_ANALYTICS_DAYS = 99999;

export function parseAnalyticsTimestamp(value) {
  if (value instanceof Date) return isValid(value) ? value : null;
  if (!value) return null;

  const parsed = parseISO(String(value));
  return isValid(parsed) ? parsed : null;
}

export function getAnalyticsDateWindow({ dateDays = 30, selectedDate = null, now = new Date() } = {}) {
  const selected = parseAnalyticsTimestamp(selectedDate);
  if (selected) {
    const start = startOfDay(selected);
    return {
      start,
      end: addDays(start, 1),
      isAllTime: false,
      isSingleDay: true,
      label: format(start, 'MMM d, yyyy'),
    };
  }

  const days = Number(dateDays);
  if (!Number.isFinite(days) || days >= ALL_TIME_ANALYTICS_DAYS) {
    return {
      start: null,
      end: null,
      isAllTime: true,
      isSingleDay: false,
      label: 'All Time',
    };
  }

  const safeDays = Math.max(1, Math.floor(days));
  const today = startOfDay(parseAnalyticsTimestamp(now) || new Date());
  const start = subDays(today, safeDays - 1);

  return {
    start,
    end: addDays(today, 1),
    isAllTime: false,
    isSingleDay: safeDays === 1,
    label: safeDays === 1 ? 'Today' : `${safeDays} Days`,
  };
}

export function isWithinAnalyticsDateWindow(value, window) {
  const timestamp = parseAnalyticsTimestamp(value);
  if (!timestamp) return false;
  if (window?.isAllTime) return true;
  if (!window?.start || !window?.end) return false;

  return timestamp >= window.start && timestamp < window.end;
}

export function filterAnalyticsRecords(records = [], field, window) {
  return records.filter((record) => isWithinAnalyticsDateWindow(record?.[field], window));
}

export async function fetchAllAnalyticsPages(fetchPage, { pageSize = 5000, maxPages = 100 } = {}) {
  if (typeof fetchPage !== 'function') throw new TypeError('fetchPage must be a function');

  const safePageSize = Math.max(1, Math.floor(Number(pageSize) || 5000));
  const safeMaxPages = Math.max(1, Math.floor(Number(maxPages) || 100));
  const records = [];

  for (let pageIndex = 0; pageIndex < safeMaxPages; pageIndex += 1) {
    const skip = pageIndex * safePageSize;
    const response = await fetchPage(safePageSize, skip);
    const page = Array.isArray(response) ? response : (response?.items || []);

    records.push(...page);
    if (page.length < safePageSize) return records;
  }

  throw new Error(`Analytics query exceeded ${safeMaxPages.toLocaleString()} pages`);
}

export function summarizeAnalyticsAppointments(appointments = [], { selectedDay = false } = {}) {
  const nonCanceled = appointments.filter((appointment) =>
    !['canceled', 'cancelled'].includes(appointment?.status)
  );
  const upcoming = appointments.filter((appointment) =>
    ['scheduled', 'confirmed'].includes(appointment?.status)
  );
  const noShows = appointments.filter((appointment) => appointment?.status === 'no_show').length;
  const denominator = selectedDay ? nonCanceled.length : appointments.length;

  return {
    appointmentCount: selectedDay ? nonCanceled.length : upcoming.length,
    upcomingCount: upcoming.length,
    noShowCount: noShows,
    noShowRate: denominator ? Math.round((noShows / denominator) * 100) : 0,
  };
}
