import React, { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  DollarSign,
  RefreshCw,
  Users,
  WifiOff,
} from 'lucide-react';
import { format, isSameDay, parseISO, subDays } from 'date-fns';
import { base44 } from '@/api/base44Client';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  ACTIVITY_RANGE_PRESETS,
  buildUserActivityRows,
  getUserActivityRange,
  sortUserActivityRowsByActivity,
  sortUserActivityRowsByPerformance,
  summarizeUserActivity,
  toActivityDateInput,
} from '@/lib/userActivityHeatmap';

const recordedRevenueFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

function initials(name, email) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  return String(parts[0] || email || '?').slice(0, 2).toUpperCase();
}

function resolvedTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(() => (
    typeof navigator === 'undefined' ? true : navigator.onLine
  ));

  useEffect(() => {
    const online = () => setIsOnline(true);
    const offline = () => setIsOnline(false);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, []);

  return isOnline;
}

function SummaryMetric({ label, value, detail, icon: Icon, tone = 'text-white' }) {
  return (
    <div className="min-w-0 rounded-xl border border-white/[0.06] bg-white/[0.025] px-3 py-3 md:px-4">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="truncate text-[9px] font-bold uppercase tracking-[0.14em] text-white/35">
          {label}
        </span>
        <Icon className={`h-3.5 w-3.5 shrink-0 ${tone}`} />
      </div>
      <div className={`text-xl font-black tracking-tight md:text-2xl ${tone}`}>{value}</div>
      <p className="mt-0.5 truncate text-[10px] text-white/35">{detail}</p>
    </div>
  );
}

function LoadingGrid() {
  return (
    <div className="space-y-2 px-4 py-5" aria-label="Loading team activity">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="flex h-11 animate-pulse items-center gap-4 rounded-lg bg-white/[0.025] px-3">
          <div className="h-7 w-32 rounded-md bg-white/[0.06]" />
          <div className="ml-auto flex gap-7">
            {[0, 1, 2, 3, 4, 5, 6].map((cell) => (
              <div key={cell} className="h-3.5 w-3.5 rounded-full bg-white/[0.07]" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ActivityCell({ cell, member, showProductionTotals }) {
  const name = member?.name || member?.email || 'Team member';
  const dayLabel = format(cell.date, 'EEEE, MMMM d');
  const ariaLabel = cell.isFuture
    ? `${name}, ${dayLabel}: not reached yet`
    : cell.active
      ? `${name}, ${dayLabel}: active with ${cell.logs} ${cell.logs === 1 ? 'log' : 'logs'}`
      : `${name}, ${dayLabel}: no activity`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className="group mx-auto flex h-10 w-10 items-center justify-center rounded-full outline-none transition-colors hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-[#2EEB57]/70"
        >
          {cell.isFuture ? (
            <span className="h-px w-3 rounded-full bg-white/15" />
          ) : cell.active ? (
            <span className="h-4 w-4 rounded-full border border-[#7BFF94]/70 bg-[#2EEB57] shadow-[0_0_14px_rgba(46,235,87,0.55)] transition-transform group-hover:scale-110" />
          ) : (
            <span className="h-3.5 w-3.5 rounded-full border border-white/[0.09] bg-white/[0.025]" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={7}
        className={`${showProductionTotals ? 'w-64' : 'w-56'} rounded-xl border border-white/10 bg-[#111114] p-3 text-white shadow-2xl`}
      >
        <div className="mb-2 border-b border-white/[0.08] pb-2">
          <p className="text-xs font-black">{dayLabel}</p>
          <p className={`mt-0.5 text-[10px] font-bold ${cell.active ? 'text-[#2EEB57]' : 'text-white/40'}`}>
            {cell.isFuture ? 'Not reached yet' : cell.active ? 'Active' : 'No activity logged'}
          </p>
        </div>
        {!cell.isFuture && (
          <div className={`grid ${showProductionTotals ? 'grid-cols-4' : 'grid-cols-3'} gap-2 text-center`}>
            <div>
              <div className="text-sm font-black text-white">{cell.logs}</div>
              <div className="text-[9px] uppercase tracking-wide text-white/35">Logs</div>
            </div>
            <div>
              <div className="text-sm font-black text-white">{cell.doors}</div>
              <div className="text-[9px] uppercase tracking-wide text-white/35">Doors</div>
            </div>
            <div>
              <div className="text-sm font-black text-[#2EEB57]">{cell.sales}</div>
              <div className="text-[9px] uppercase tracking-wide text-white/35">Sales</div>
            </div>
            {showProductionTotals && (
              <div>
                <div className="text-xs font-black text-cyan-200">
                  {recordedRevenueFormatter.format(cell.recordedSalesVolume)}
                </div>
                <div className="text-[9px] uppercase tracking-wide text-white/35">Revenue</div>
              </div>
            )}
          </div>
        )}
        {cell.lastActivity && (
          <p className="mt-2 border-t border-white/[0.08] pt-2 text-[10px] text-white/45">
            Last activity <span className="font-bold text-white/75">{format(cell.lastActivity, 'h:mm a')}</span>
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

export default function UserActivityHeatmap({
  members = [],
  managerId,
  activityData,
  allowAllTime = false,
  externalUpdatedAt = 0,
  isRefreshing = false,
  minimumActivityDate,
  onRefresh,
  rankByActivity = false,
  rankByPerformance = false,
  showProductionTotals = false,
  scopeLabel = 'Team',
}) {
  const [preset, setPreset] = useState('this_week');
  const [now, setNow] = useState(() => new Date());
  const [customStart, setCustomStart] = useState(() => toActivityDateInput(subDays(new Date(), 6)));
  const [customEnd, setCustomEnd] = useState(() => toActivityDateInput(new Date()));
  const isOnline = useOnlineStatus();
  const timeZone = useMemo(resolvedTimeZone, []);
  const usesExternalData = Array.isArray(activityData);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const range = useMemo(() => {
    const resolved = getUserActivityRange({
      preset,
      customStart,
      customEnd,
      minimumDate: minimumActivityDate,
      now,
    });
    if (!resolved.valid || !minimumActivityDate) return resolved;
    const minimum = parseISO(String(minimumActivityDate));
    if (!Number.isFinite(minimum.getTime()) || resolved.queryStart >= minimum) return resolved;
    return {
      ...resolved,
      valid: false,
      error: `Activity history is available from ${format(minimum, 'MMM d, yyyy')}.`,
    };
  }, [preset, customStart, customEnd, now, minimumActivityDate]);

  const queryStart = range.queryStart?.toISOString() || '';
  const queryEnd = range.queryEndExclusive?.toISOString() || '';
  const {
    data: liveData,
    dataUpdatedAt,
    error,
    isError,
    isFetching: isQueryFetching,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ['teamActivityHeatmap', managerId, queryStart, queryEnd, timeZone],
    queryFn: async () => {
      const response = await base44.functions.invoke('getTeamActivityHeatmap', {
        start_at: queryStart,
        end_at: queryEnd,
        time_zone: timeZone,
      });
      const payload = response?.data || response;
      if (!payload?.success || !Array.isArray(payload?.activity)) {
        throw new Error(payload?.message || 'Team activity is unavailable.');
      }
      return payload;
    },
    enabled: !usesExternalData && !!managerId && range.valid,
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    refetchInterval: isOnline ? 60_000 : false,
    refetchOnWindowFocus: true,
    networkMode: 'offlineFirst',
  });

  const hasLiveData = usesExternalData
    || (liveData?.success === true && Array.isArray(liveData.activity));
  const dailyActivity = usesExternalData ? activityData : (hasLiveData ? liveData.activity : []);
  const isFetching = usesExternalData ? isRefreshing : isQueryFetching;
  const refreshActivity = usesExternalData ? onRefresh : refetch;
  const rows = useMemo(() => {
    const builtRows = buildUserActivityRows({
      members,
      dailyActivity,
      range,
      now,
    });
    if (rankByPerformance) return sortUserActivityRowsByPerformance(builtRows);
    return rankByActivity ? sortUserActivityRowsByActivity(builtRows) : builtRows;
  }, [members, dailyActivity, range, now, rankByActivity, rankByPerformance]);
  const summary = useMemo(
    () => summarizeUserActivity(rows, { hasComparison: range.comparisonDates.length > 0 }),
    [rows, range.comparisonDates.length]
  );
  const unavailable = range.valid
    && !hasLiveData
    && !usesExternalData
    && (isError || !isOnline || !managerId);
  const loadingWithoutData = range.valid
    && !hasLiveData
    && isOnline
    && (isLoading || isFetching);
  const newestUpdate = usesExternalData ? externalUpdatedAt : (hasLiveData ? dataUpdatedAt : 0);
  const rosterNoun = scopeLabel === 'Team' ? 'team members' : 'platform users';
  const rowHeading = scopeLabel === 'Team' ? 'Team member' : 'Platform user';
  const rangePresets = ACTIVITY_RANGE_PRESETS.filter((option) => (
    option.id !== 'all_time' || allowAllTime
  ));
  const performanceFirst = rankByPerformance && showProductionTotals;
  const visibleDates = range.aggregateOnly ? [] : range.dates;
  const dateColumnWidth = visibleDates.length > 14 ? 48 : 76;
  const productionColumnWidth = showProductionTotals ? 208 : 0;
  const tableMinWidth = 210 + (visibleDates.length * dateColumnWidth) + productionColumnWidth + 112;
  const trendIcon = summary.direction === 'up'
    ? ArrowUpRight
    : summary.direction === 'down'
      ? ArrowDownRight
      : ArrowRight;
  const trendTone = summary.direction === 'up'
    ? 'text-[#2EEB57]'
    : summary.direction === 'down'
      ? 'text-red-400'
      : 'text-white/55';
  const todayInput = toActivityDateInput(now);

  return (
    <TooltipProvider delayDuration={120}>
      <section className="overflow-hidden rounded-xl border border-[#2EEB57]/15 bg-gradient-to-b from-[#121713] to-[#080A08] shadow-[0_24px_80px_rgba(0,0,0,0.35)] md:rounded-2xl">
        <div className="border-b border-white/[0.06] p-3 md:p-5">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#2EEB57]/20 bg-[#2EEB57]/10">
                <Activity className="h-4 w-4 text-[#2EEB57]" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-black tracking-tight text-white md:text-lg">User Activity</h2>
                  <span className="rounded-full border border-[#2EEB57]/15 bg-[#2EEB57]/[0.07] px-2 py-0.5 text-[8px] font-black uppercase tracking-[0.16em] text-[#72F58B]">
                    Adoption
                  </span>
                </div>
                <p className="mt-0.5 text-[10px] text-white/40 md:text-sm">
                  {rankByPerformance
                    ? 'Ranked by sales, then recorded revenue, then usage.'
                    : 'One green dot means that user logged activity that day.'}
                </p>
                <p className="mt-1 text-[9px] font-bold uppercase tracking-[0.12em] text-white/25">
                  {range.valid ? range.label : 'Choose a valid range'} / {timeZone.replace(/_/g, ' ')}
                </p>
              </div>
            </div>

            <div className="flex max-w-full items-center gap-2 overflow-x-auto pb-1 xl:justify-end">
              <div
                role="group"
                aria-label="Activity date range"
                className="flex min-h-10 shrink-0 items-center rounded-xl border border-white/[0.08] bg-black/45 p-1"
              >
                {rangePresets.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={preset === option.id}
                    onClick={() => setPreset(option.id)}
                    className={`min-h-8 rounded-lg px-3 text-[9px] font-black uppercase tracking-[0.08em] transition-colors ${
                      preset === option.id
                        ? 'bg-white text-black'
                        : 'text-white/40 hover:bg-white/[0.06] hover:text-white'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => refreshActivity?.()}
                disabled={isFetching || !range.valid}
                aria-label={`Refresh ${scopeLabel.toLowerCase()} activity`}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/[0.08] bg-black/45 text-white/45 transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          {preset === 'custom' && (
            <div className="mt-4 flex flex-wrap items-end gap-2 rounded-xl border border-white/[0.06] bg-black/30 p-3">
              <label className="space-y-1 text-[9px] font-bold uppercase tracking-[0.12em] text-white/35">
                <span className="block">From</span>
                <input
                  type="date"
                  value={customStart}
                  max={todayInput}
                  onChange={(event) => setCustomStart(event.target.value)}
                  className="h-9 rounded-lg border border-white/10 bg-[#090909] px-3 text-xs font-semibold text-white [color-scheme:dark]"
                />
              </label>
              <label className="space-y-1 text-[9px] font-bold uppercase tracking-[0.12em] text-white/35">
                <span className="block">To</span>
                <input
                  type="date"
                  value={customEnd}
                  max={todayInput}
                  onChange={(event) => setCustomEnd(event.target.value)}
                  className="h-9 rounded-lg border border-white/10 bg-[#090909] px-3 text-xs font-semibold text-white [color-scheme:dark]"
                />
              </label>
              {!range.valid && <p className="pb-2 text-[10px] font-bold text-red-300">{range.error}</p>}
            </div>
          )}

          {range.valid && hasLiveData && (
            <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
              {range.aggregateOnly ? (
                <>
                  <SummaryMetric
                    label="Active Users"
                    value={`${summary.activeUsers}/${summary.totalUsers}`}
                    detail="logged across complete history"
                    icon={Users}
                  />
                  <SummaryMetric
                    label="Usage Days"
                    value={summary.activeUserDays.toLocaleString()}
                    detail={`${summary.totalLogs.toLocaleString()} total logs`}
                    icon={Activity}
                    tone="text-[#2EEB57]"
                  />
                  <SummaryMetric
                    label="Sales"
                    value={summary.totalSales.toLocaleString()}
                    detail="confirmed across complete history"
                    icon={CheckCircle2}
                    tone="text-[#72F58B]"
                  />
                  <SummaryMetric
                    label="Recorded Revenue"
                    value={recordedRevenueFormatter.format(summary.recordedSalesVolume)}
                    detail="no fabricated prior-period comparison"
                    icon={DollarSign}
                    tone="text-cyan-200"
                  />
                </>
              ) : (
                <>
                  <SummaryMetric
                    label={`${scopeLabel} Adoption`}
                    value={`${summary.adoptionPercent}%`}
                    detail={`${summary.activeUserDays} active user-days`}
                    icon={Activity}
                    tone="text-[#2EEB57]"
                  />
                  <SummaryMetric
                    label="Active Users"
                    value={`${summary.activeUsers}/${summary.totalUsers}`}
                    detail="logged in this period"
                    icon={Users}
                  />
                  <SummaryMetric
                    label="Every Day"
                    value={summary.consistentUsers}
                    detail={rows[0]?.eligibleDays ? `all ${rows[0].eligibleDays} measured days` : 'no measured days'}
                    icon={CheckCircle2}
                    tone="text-[#72F58B]"
                  />
                  <SummaryMetric
                    label="Vs Prior Period"
                    value={`${summary.change > 0 ? '+' : ''}${summary.change} pts`}
                    detail={`${summary.previousAdoptionPercent}% previously`}
                    icon={trendIcon}
                    tone={trendTone}
                  />
                </>
              )}
            </div>
          )}

          {hasLiveData && (!isOnline || isError) && (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-amber-400/15 bg-amber-400/[0.06] px-3 py-2 text-[10px] font-semibold text-amber-100/70">
              <WifiOff className="h-3.5 w-3.5 shrink-0 text-amber-300" />
              <span>
                {!isOnline
                  ? 'You are offline. Showing the last activity data available on this device.'
                  : 'The latest refresh failed. The previously loaded adoption data is still shown.'}
              </span>
            </div>
          )}
        </div>

        {!range.valid ? (
          <div className="flex min-h-40 items-center justify-center px-6 text-center">
            <div>
              <CalendarDays className="mx-auto mb-2 h-5 w-5 text-white/25" />
              <p className="text-xs font-bold text-white/55">{range.error}</p>
            </div>
          </div>
        ) : loadingWithoutData ? (
          <LoadingGrid />
        ) : unavailable ? (
          <div className="flex min-h-48 items-center justify-center px-6 py-10 text-center">
            <div className="max-w-sm">
              <WifiOff className="mx-auto mb-3 h-6 w-6 text-amber-300/70" />
              <h3 className="text-sm font-black text-white">Activity is unavailable</h3>
              <p className="mt-1 text-xs leading-relaxed text-white/40">
                No reliable activity snapshot is available, so {scopeLabel} analytics will not mark anyone inactive.
              </p>
              <button
                type="button"
                onClick={() => refetch()}
                className="mt-4 rounded-lg border border-white/10 bg-white/[0.05] px-4 py-2 text-[10px] font-black uppercase tracking-wider text-white/70 hover:bg-white/10"
              >
                Retry
              </button>
              {error?.message && <p className="mt-2 text-[9px] text-white/25">{error.message}</p>}
            </div>
          </div>
        ) : members.length === 0 ? (
          <div className="flex min-h-40 items-center justify-center px-6 text-center">
            <div>
              <Users className="mx-auto mb-2 h-5 w-5 text-white/25" />
              <p className="text-xs font-bold text-white/55">No {rosterNoun} to measure yet.</p>
              <p className="mt-1 text-[10px] text-white/30">Add a rep and their activity will appear here.</p>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table
              className="w-full border-collapse"
              style={{ minWidth: `${Math.max(tableMinWidth, 720)}px` }}
            >
              <caption className="sr-only">
                {range.aggregateOnly
                  ? `All-time performance ranking for ${range.label}.`
                  : `User activity by day for ${range.label}. Green circles indicate at least one logged action.`}
                {showProductionTotals ? ' Sales and recorded revenue totals cover the selected date range.' : ''}
                {rankByPerformance ? ' Rows rank by sales, recorded revenue, active days, logs, and recent activity.' : ''}
              </caption>
              <thead>
                <tr className="border-b border-white/[0.06] bg-black/25">
                  <th
                    scope="col"
                    className="sticky left-0 z-20 w-[210px] bg-[#0C0F0C] px-4 py-3 text-left text-[9px] font-black uppercase tracking-[0.14em] text-white/30"
                  >
                    {rowHeading}
                  </th>
                  {!performanceFirst && visibleDates.map((date) => {
                    const today = isSameDay(date, now);
                    const compact = visibleDates.length > 14;
                    return (
                      <th
                        key={date.toISOString()}
                        scope="col"
                        className={`px-1 py-2 text-center font-bold ${today ? 'bg-[#2EEB57]/[0.055]' : ''}`}
                        style={{ width: `${dateColumnWidth}px`, minWidth: `${dateColumnWidth}px` }}
                      >
                        <span className={`block text-[9px] uppercase tracking-[0.08em] ${today ? 'text-[#72F58B]' : 'text-white/35'}`}>
                          {format(date, compact ? 'EEE' : 'EEEE')}
                        </span>
                        {(compact || range.preset === 'custom') && (
                          <span className="mt-0.5 block text-[9px] font-medium text-white/20">
                            {format(date, 'MMM d')}
                          </span>
                        )}
                      </th>
                    );
                  })}
                  {showProductionTotals && (
                    <>
                      <th
                        scope="col"
                        aria-sort={rankByPerformance ? 'descending' : undefined}
                        title="Confirmed sales logged in the selected date range"
                        className="w-20 min-w-20 bg-[#0C0F0C] px-3 py-3 text-right text-[9px] font-black uppercase tracking-[0.12em] text-white/30"
                      >
                        Sales
                      </th>
                      <th
                        scope="col"
                        title="Rep-recorded sale amounts in the selected date range"
                        className="w-32 min-w-32 bg-[#0C0F0C] px-3 py-3 text-right text-[9px] font-black uppercase tracking-[0.12em] text-white/30"
                      >
                        <span className="block">Revenue</span>
                        <span className="mt-0.5 block text-[7px] tracking-[0.08em] text-cyan-200/45">Recorded</span>
                      </th>
                    </>
                  )}
                  <th
                    scope="col"
                    className={`${performanceFirst ? '' : 'sticky right-0 z-20'} w-28 min-w-28 bg-[#0C0F0C] px-3 py-3 text-right text-[9px] font-black uppercase tracking-[0.12em] text-white/30`}
                  >
                    {range.aggregateOnly ? 'Usage days' : 'Active days'}
                  </th>
                  {performanceFirst && visibleDates.map((date) => {
                    const today = isSameDay(date, now);
                    const compact = visibleDates.length > 14;
                    return (
                      <th
                        key={date.toISOString()}
                        scope="col"
                        className={`px-1 py-2 text-center font-bold ${today ? 'bg-[#2EEB57]/[0.055]' : ''}`}
                        style={{ width: `${dateColumnWidth}px`, minWidth: `${dateColumnWidth}px` }}
                      >
                        <span className={`block text-[9px] uppercase tracking-[0.08em] ${today ? 'text-[#72F58B]' : 'text-white/35'}`}>
                          {format(date, compact ? 'EEE' : 'EEEE')}
                        </span>
                        {(compact || range.preset === 'custom') && (
                          <span className="mt-0.5 block text-[9px] font-medium text-white/20">
                            {format(date, 'MMM d')}
                          </span>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr
                    key={row.key}
                    className={`border-b border-white/[0.045] last:border-0 ${
                      rowIndex % 2 ? 'bg-white/[0.012]' : ''
                    }`}
                  >
                    <th
                      scope="row"
                      className="sticky left-0 z-10 bg-[#0B0E0B] px-4 py-2.5 text-left"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        {rankByPerformance && (
                          <span className="w-5 shrink-0 font-mono text-[9px] font-black text-[#72F58B]/65">
                            #{rowIndex + 1}
                          </span>
                        )}
                        <Avatar className="h-8 w-8 shrink-0 border border-white/10">
                          <AvatarImage src={row.member?.profile_image_url} alt="" />
                          <AvatarFallback
                            className="text-[10px] font-black text-black"
                            style={{ backgroundColor: row.member?.color || '#2EEB57' }}
                          >
                            {initials(row.member?.name, row.member?.email)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <p className="truncate text-xs font-black text-white">
                            {row.member?.name || row.member?.email || 'Unnamed user'}
                          </p>
                          <p className="truncate text-[9px] font-semibold capitalize text-white/30">
                            {row.member?.role || 'rep'}
                            {row.member?.status === 'inactive' ? ' / inactive roster' : ''}
                          </p>
                        </div>
                      </div>
                    </th>
                    {!performanceFirst && !range.aggregateOnly && row.cells.map((cell) => (
                      <td
                        key={cell.dateKey}
                        className={`px-1 py-1 text-center ${
                          isSameDay(cell.date, now) ? 'bg-[#2EEB57]/[0.035]' : ''
                        }`}
                      >
                        <ActivityCell
                          cell={cell}
                          member={row.member}
                          showProductionTotals={showProductionTotals}
                        />
                      </td>
                    ))}
                    {showProductionTotals && (
                      <>
                        <td
                          aria-label={`${row.member?.name || row.member?.email || 'Unnamed user'}: ${row.totalSales} confirmed sales in ${range.label}`}
                          className="bg-[#0B0E0B] px-3 py-2 text-right font-mono text-sm font-black text-[#7CFF9C]"
                        >
                          {row.totalSales}
                        </td>
                        <td
                          aria-label={`${row.member?.name || row.member?.email || 'Unnamed user'}: ${recordedRevenueFormatter.format(row.recordedSalesVolume)} recorded revenue in ${range.label}`}
                          className="bg-[#0B0E0B] px-3 py-2 text-right font-mono text-xs font-black text-cyan-200"
                        >
                          {recordedRevenueFormatter.format(row.recordedSalesVolume)}
                        </td>
                      </>
                    )}
                    <td className={`${performanceFirst ? '' : 'sticky right-0 z-10'} bg-[#0B0E0B] px-3 py-2 text-right`}>
                      <div className={`text-sm font-black ${row.isConsistent ? 'text-[#2EEB57]' : row.isInactive ? 'text-white/30' : 'text-white'}`}>
                        {range.aggregateOnly ? row.activeDays : `${row.activeDays}/${row.eligibleDays}`}
                      </div>
                      <div className="text-[9px] font-bold text-white/25">
                        {range.aggregateOnly ? 'active days' : `${row.activityPercent}%`}
                      </div>
                    </td>
                    {performanceFirst && !range.aggregateOnly && row.cells.map((cell) => (
                      <td
                        key={cell.dateKey}
                        className={`px-1 py-1 text-center ${
                          isSameDay(cell.date, now) ? 'bg-[#2EEB57]/[0.035]' : ''
                        }`}
                      >
                        <ActivityCell
                          cell={cell}
                          member={row.member}
                          showProductionTotals={showProductionTotals}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-col gap-2 border-t border-white/[0.06] bg-black/25 px-4 py-3 text-[9px] text-white/30 sm:flex-row sm:items-center sm:justify-between">
          {range.aggregateOnly ? (
            <span className="font-semibold text-white/40">
              Complete history is condensed to sales, recorded revenue, and usage totals.
            </span>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-[#2EEB57] shadow-[0_0_8px_rgba(46,235,87,0.45)]" />
                Logged activity
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full border border-white/10 bg-white/[0.025]" />
                No activity
              </span>
              {range.dates.some((date) => date > now) && (
                <span className="flex items-center gap-1.5">
                  <span className="h-px w-2.5 bg-white/15" />
                  Not reached
                </span>
              )}
            </div>
          )}
          <span>
            {newestUpdate ? `Updated ${format(new Date(newestUpdate), 'h:mm a')}` : 'Updates every minute'}
          </span>
          {showProductionTotals && (
            <span className="text-white/25">
              Revenue includes recorded sale amounts; Canvas and unvalued sales contribute $0.
            </span>
          )}
        </div>
      </section>
    </TooltipProvider>
  );
}
