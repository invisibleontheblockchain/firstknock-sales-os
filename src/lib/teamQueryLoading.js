import { routeIsVisibleInKnock } from '../components/rep/repRouteCollection.js';
import { startOfDay, subDays } from 'date-fns';

export const TEAM_LOG_FIELDS = [
  'id', 'created_date', 'created_by', 'manager_id', 'parsed_status', 'sale_amount', 'counts_as_knock',
];

export const TEAM_ROUTE_FIELDS = [
  'id', 'name', 'created_by', 'manager_id', 'created_date', 'updated_date',
  'assigned_to', 'assigned_to_name', 'status', 'metrics', 'start_location',
  'end_location', 'metadata', 'route_origin_mode', 'route_mode', 'priority',
];

export function getTeamPerformanceQueryPlan(activeTab, historyDays = 30, now = new Date()) {
  const allTime = activeTab === 'roster' || Number(historyDays) >= 99999;
  const days = Math.max(14, Math.floor(Number(historyDays) || 30));
  const start = allTime ? null : startOfDay(subDays(now, days - 1)).toISOString();
  return {
    enabled: activeTab === 'analytics' || activeTab === 'roster',
    allTime,
    start,
    filter: start ? { created_date: { $gte: start } } : {},
    label: allTime ? 'All Time' : `${days}D`,
  };
}

// Team inventory previously re-downloaded every 15 seconds, even when nothing
// changed. Coalesce visible-account events into one refresh per 15-second burst.
export function subscribeToTeamUpdates({
  entities, managerId, routeScope, getRoutes, getLogs, onRoutesChanged, onLogsChanged,
  schedule = setTimeout, cancel = clearTimeout, delayMs = 15000,
}) {
  let routeTimer = null;
  let logTimer = null;
  const queueRoutes = () => {
    if (routeTimer !== null) return;
    routeTimer = schedule(() => { routeTimer = null; onRoutesChanged(); }, delayMs);
  };
  const queueLogs = () => {
    if (logTimer !== null) return;
    logTimer = schedule(() => { logTimer = null; onLogsChanged(); }, delayMs);
  };
  const routeUnsubscribe = entities.SavedRoute.subscribe((event) => {
    if (!event?.id) return;
    if ((event.data && routeIsVisibleInKnock({ ...event.data, id: event.id }, routeScope)) ||
        getRoutes().some((route) => route.id === event.id)) queueRoutes();
  });
  const logUnsubscribe = entities.InteractionLog.subscribe((event) => {
    if (!event?.id) return;
    if (event.data?.manager_id) {
      if (event.data.manager_id === managerId) queueLogs();
      return;
    }
    if (getLogs().some((log) => log.id === event.id)) queueLogs();
  });
  return () => {
    if (routeTimer !== null) cancel(routeTimer);
    if (logTimer !== null) cancel(logTimer);
    routeUnsubscribe();
    logUnsubscribe();
  };
}
