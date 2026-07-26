import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Banknote,
  BarChart3,
  Check,
  CircleDollarSign,
  CreditCard,
  Crown,
  DollarSign,
  DoorOpen,
  Gauge,
  LogOut,
  Medal,
  Radio,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Target,
  TrendingUp,
  UserCheck,
  Users,
  XCircle,
  Zap,
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { base44 } from '@/api/base44Client';
import {
  hashForSection,
  HQ_SECTION_IDS,
  nextSectionForKey,
  sectionFromHash,
} from '@/admin/hqNavigation';
import { buildPlatformAdoptionView } from '@/admin/platformAdoption';
import UserActivityHeatmap from '@/components/analytics/team/UserActivityHeatmap';
import { canViewPlatformDashboard } from '@/lib/platformDashboardAccess';

const PERIOD_OPTIONS = [
  { id: '7d', label: '7D' },
  { id: '30d', label: '30D' },
  { id: '90d', label: '90D' },
  { id: 'all', label: 'ALL TIME' },
];

const CUSTOMER_FILTERS = [
  { id: 'current', label: 'Current' },
  { id: 'paid', label: 'Paid' },
  { id: 'trialing', label: 'Trials & beta' },
  { id: 'risk', label: 'At risk' },
  { id: 'all', label: 'All' },
];

const HQ_TAB_DETAILS = {
  field: { label: 'Field', icon: Target },
  adoption: { label: 'Adoption', icon: UserCheck },
  revenue: { label: 'Revenue', icon: CreditCard },
  pulse: { label: '30-day pulse', icon: BarChart3 },
  cash: { label: 'Stripe cash', icon: DollarSign },
  leaderboard: { label: 'Leaderboard', icon: Crown },
  live: { label: 'Live feed', icon: Radio },
  customers: { label: 'Customers', icon: Users },
  operations: { label: 'Operations', icon: Activity },
};

const HQ_TABS = HQ_SECTION_IDS.map((id) => ({ id, ...HQ_TAB_DETAILS[id] }));

function hqTabFromLocation() {
  return sectionFromHash(typeof window === 'undefined' ? '' : window.location.hash);
}

function isCompletePlatformPayload(payload) {
  return payload?.success === true
    && payload?.rep?.periods
    && Array.isArray(payload?.rep?.adoption?.reps)
    && Array.isArray(payload?.rep?.adoption?.days)
    && payload?.business
    && payload?.source_health?.firstknock;
}

function resolvedTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const compactNumber = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const fullNumber = new Intl.NumberFormat('en-US');
const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});
const preciseMoney = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

function formatNumber(value, compact = false) {
  const number = Number(value || 0);
  return compact ? compactNumber.format(number) : fullNumber.format(number);
}

function formatMoney(value, compact = false) {
  const number = Number(value || 0);
  if (compact && Math.abs(number) >= 1000) {
    return `$${compactNumber.format(number)}`;
  }
  return money.format(number);
}

function formatDate(value, fallback = '—') {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? format(date, 'MMM d, yyyy') : fallback;
}

function relativeTime(value) {
  if (!value) return 'Time unavailable';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? formatDistanceToNow(date, { addSuffix: true })
    : 'Time unavailable';
}

function customerMilestone(customer) {
  const status = String(customer?.status || '').toLowerCase();
  if (status === 'beta') return { label: 'Beta ends', date: customer?.trial_ends_at };
  if (status === 'trialing') return { label: 'Trial ends', date: customer?.trial_ends_at };
  if (['canceled', 'cancelled'].includes(status)) return { label: 'Access ends', date: customer?.renews_at };
  if (['past_due', 'unpaid', 'incomplete'].includes(status)) return { label: 'Billing period', date: customer?.renews_at };
  return { label: customer?.renews_at ? 'Renews' : 'No renewal', date: customer?.renews_at };
}

function customerCardTone(customer) {
  const status = String(customer?.status || '').toLowerCase();
  if (['past_due', 'unpaid', 'incomplete'].includes(status)) return 'mobile-record-card--risk';
  if (['trialing', 'beta'].includes(status)) return 'mobile-record-card--trial';
  if (status === 'active' && customer?.paid_confirmed) return 'mobile-record-card--paid';
  return 'mobile-record-card--quiet';
}

function Panel({ children, className = '' }) {
  return (
    <section className={`relative overflow-hidden rounded-[26px] border border-white/[0.08] bg-[#090C0A]/90 shadow-[0_26px_80px_rgba(0,0,0,0.35)] ${className}`}>
      {children}
    </section>
  );
}

function Eyebrow({ children, tone = 'green' }) {
  const tones = {
    green: 'border-[#39FF6E]/20 bg-[#39FF6E]/10 text-[#7CFF9C]',
    violet: 'border-violet-400/20 bg-violet-400/10 text-violet-200',
    cyan: 'border-cyan-400/20 bg-cyan-400/10 text-cyan-200',
  };
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] ${tones[tone]}`}>
      {children}
    </span>
  );
}

function PeriodSwitcher({ period, onChange }) {
  return (
    <div role="group" aria-label="Analytics period" className="flex w-full rounded-xl border border-white/[0.08] bg-black/40 p-1 sm:w-auto">
      {PERIOD_OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => onChange(option.id)}
          aria-pressed={period === option.id}
          className={`min-h-10 flex-1 rounded-lg px-2.5 py-2 text-[9px] font-black tracking-[0.12em] transition-all sm:flex-none sm:px-3 ${period === option.id ? 'bg-[#39FF6E] text-black shadow-[0_0_18px_rgba(57,255,110,.18)]' : 'text-white/35 hover:text-white'}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function MetricTile({ icon: Icon, label, value, helper, color = '#39FF6E' }) {
  return (
    <div className="group relative min-h-[116px] overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4 transition-all duration-300 hover:-translate-y-0.5 hover:border-white/[0.14] hover:bg-white/[0.04]">
      <div
        className="pointer-events-none absolute -right-8 -top-10 h-24 w-24 rounded-full opacity-15 blur-2xl transition-opacity group-hover:opacity-25"
        style={{ background: color }}
      />
      <div className="relative flex items-start justify-between gap-3">
        <p className="text-[10px] font-black uppercase tracking-[0.18em] text-white/45">{label}</p>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-white/[0.08] bg-black/40">
          <Icon className="h-4 w-4" style={{ color }} />
        </span>
      </div>
      <p className="relative mt-3 font-mono text-2xl font-black tracking-[-0.04em] text-white md:text-[28px]">{value}</p>
      {helper && <p className="relative mt-1 text-[11px] font-medium text-white/38">{helper}</p>}
    </div>
  );
}

function HeroMetric({ icon: Icon, label, value, helper, rate, rateLabel = 'Door to sale', color = '#39FF6E' }) {
  const boundedRate = Math.min(100, Math.max(0, Number(rate || 0)));
  return (
    <div className="relative flex min-h-[248px] flex-col justify-between overflow-hidden rounded-2xl border border-white/[0.08] bg-black/45 p-5">
      <div className="absolute inset-0 opacity-60" style={{ background: `radial-gradient(circle at 30% 20%, ${color}22, transparent 56%)` }} />
      <div className="relative flex items-center justify-between">
        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/50">{label}</p>
        <Icon className="h-5 w-5" style={{ color }} />
      </div>
      {rate !== undefined ? (
        <div className="relative mx-auto my-2 grid h-36 w-36 place-items-center rounded-full p-[9px]" style={{ background: `conic-gradient(${color} ${boundedRate}%, rgba(255,255,255,.07) 0)` }}>
          <div className="grid h-full w-full place-items-center rounded-full border border-white/[0.06] bg-[#080B09] text-center shadow-inner">
            <div>
              <p className="font-mono text-4xl font-black tracking-[-0.07em] text-white">{value}</p>
              <p className="mt-1 text-[9px] font-black uppercase tracking-[0.18em] text-white/35">{rateLabel}</p>
            </div>
          </div>
        </div>
      ) : (
        <div className="relative py-6">
          <p className="font-mono text-4xl font-black tracking-[-0.07em] text-white md:text-5xl">{value}</p>
          <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
            <div className="h-full w-[72%] rounded-full" style={{ background: `linear-gradient(90deg, ${color}, ${color}55)` }} />
          </div>
        </div>
      )}
      <p className="relative text-[11px] font-medium leading-relaxed text-white/45">{helper}</p>
    </div>
  );
}

const DIMENSIONAL_RAILS = [1, 0.75, 0.5, 0.25, 0];

function niceCeiling(value) {
  const maximum = Math.max(0, Number(value || 0));
  if (maximum === 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(maximum));
  const normalizedMaximum = maximum / magnitude;
  const step = normalizedMaximum <= 1 ? 1 : normalizedMaximum <= 2 ? 2 : normalizedMaximum <= 5 ? 5 : 10;
  return step * magnitude;
}

function fullDayLabel(point) {
  const date = new Date(`${point?.date || ''}T00:00:00Z`);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
    : String(point?.label || 'Unknown day');
}

function DimensionalColumnChart({
  data = [],
  series = [],
  ariaLabel,
  scaleFormatter = formatNumber,
  dayAriaLabel,
  renderReadout,
}) {
  const points = Array.isArray(data) ? data : [];
  const [activeIndex, setActiveIndex] = useState(Math.max(0, points.length - 1));
  const scrollerRef = useRef(null);
  const selectedIndex = Math.min(activeIndex, Math.max(0, points.length - 1));
  const selectedPoint = points[selectedIndex];
  const maximum = Math.max(0, ...points.flatMap((point) => series.map((item) => Number(point?.[item.key] || 0))));
  const ceiling = niceCeiling(maximum);
  const plotWidth = Math.max(780, points.length * 34);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollLeft = scroller.scrollWidth;
  }, [points.length]);

  const moveSelection = (event, index) => {
    let nextIndex = index;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = Math.min(points.length - 1, index + 1);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = Math.max(0, index - 1);
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = points.length - 1;
    else return;
    event.preventDefault();
    setActiveIndex(nextIndex);
    event.currentTarget.parentElement?.querySelector(`[data-dimensional-index="${nextIndex}"]`)?.focus();
  };

  if (points.length === 0) {
    return <div className="grid h-[290px] place-items-center text-center text-xs text-white/35">No activity has landed in this window yet.</div>;
  }

  return (
    <div className="dimensional-stage" aria-label={ariaLabel}>
      <div className="dimensional-readout" aria-live="polite">
        {renderReadout?.(selectedPoint)}
      </div>
      <div ref={scrollerRef} className="dimensional-scroll">
        <div className="dimensional-plot" style={{ minWidth: `${plotWidth}px` }}>
          <div className="dimensional-grid">
            {DIMENSIONAL_RAILS.map((rail) => (
              <div key={rail} aria-hidden="true" className="dimensional-rail" style={{ bottom: `${34 + rail * 216}px` }}>
                <span>{scaleFormatter(ceiling * rail)}</span>
              </div>
            ))}
            <div aria-hidden="true" className="dimensional-floor" />
            <div className="dimensional-days">
              {points.map((point, index) => {
                const active = index === selectedIndex;
                const showLabel = active || index === 0 || index === points.length - 1 || index % 5 === 0;
                return (
                  <button
                    key={point.date || index}
                    type="button"
                    data-dimensional-index={index}
                    aria-label={dayAriaLabel?.(point) || fullDayLabel(point)}
                    aria-current={active ? 'date' : undefined}
                    tabIndex={active ? 0 : -1}
                    className={`dimensional-day ${active ? 'is-active' : ''}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onFocus={() => setActiveIndex(index)}
                    onClick={() => setActiveIndex(index)}
                    onKeyDown={(event) => moveSelection(event, index)}
                  >
                    <span className={`dimensional-prism-zone ${series.length === 1 ? 'is-single' : ''}`} aria-hidden="true">
                      {series.map((item) => {
                        const value = Math.max(0, Number(point?.[item.key] || 0));
                        const height = Math.min(100, (value / ceiling) * 100);
                        return (
                          <span
                            key={item.key}
                            className={`dimensional-prism dimensional-prism--${item.tone} ${value === 0 ? 'is-zero' : ''}`}
                            style={{ '--prism-height': `${height}%` }}
                          />
                        );
                      })}
                    </span>
                    <span aria-hidden="true" className={`dimensional-date ${showLabel ? '' : 'is-muted'}`}>{point.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <div className="dimensional-legend" aria-hidden="true">
        {series.map((item) => (
          <span key={item.key}><i className={`dimensional-legend-swatch dimensional-legend-swatch--${item.tone}`} />{item.label}</span>
        ))}
        <span className="ml-auto hidden text-white/25 sm:inline">Tap a day for exact numbers</span>
      </div>
    </div>
  );
}

function SourceStatus({ source }) {
  const live = source?.status === 'live';
  return (
    <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.16em] ${live ? 'border-[#39FF6E]/20 bg-[#39FF6E]/10 text-[#82FF9E]' : 'border-amber-400/20 bg-amber-400/10 text-amber-200'}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${live ? 'animate-pulse bg-[#39FF6E] shadow-[0_0_10px_#39FF6E]' : 'bg-amber-300'}`} />
      {live ? `${source?.mode === 'test' ? 'Stripe test' : 'Stripe live'}` : 'Stripe unavailable'}
    </div>
  );
}

function RankBadge({ rank }) {
  const palette = rank === 1
    ? 'border-yellow-300/30 bg-yellow-300/10 text-yellow-200'
    : rank === 2
      ? 'border-slate-300/25 bg-slate-300/10 text-slate-200'
      : rank === 3
        ? 'border-orange-400/25 bg-orange-400/10 text-orange-300'
        : 'border-white/[0.07] bg-white/[0.03] text-white/35';
  return (
    <span aria-label={`Rank ${rank}`} title={`Rank ${rank}`} className={`grid h-8 w-8 place-items-center rounded-xl border font-mono text-xs font-black ${palette}`}>
      {rank <= 3 ? <Medal className="h-4 w-4" /> : rank}
    </span>
  );
}

function StatusBadge({ status, confirmed }) {
  const normalizedStatus = String(status || '').toLowerCase();
  const classes = normalizedStatus === 'active' && confirmed
    ? 'border-[#39FF6E]/20 bg-[#39FF6E]/10 text-[#8CFFA6]'
    : ['trialing', 'beta'].includes(normalizedStatus)
      ? 'border-violet-400/20 bg-violet-400/10 text-violet-200'
      : ['past_due', 'unpaid', 'incomplete'].includes(normalizedStatus)
        ? 'border-amber-400/20 bg-amber-400/10 text-amber-200'
        : 'border-white/10 bg-white/[0.04] text-white/45';
  const label = normalizedStatus === 'active' && confirmed
    ? 'Paid'
    : normalizedStatus === 'beta'
      ? 'Beta'
      : normalizedStatus.replace(/_/g, ' ') || 'Unknown';
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-[9px] font-black uppercase tracking-[0.14em] ${classes}`}>{label}</span>;
}

function FeedGlyph({ category }) {
  const map = {
    payment: { icon: Check, color: '#39FF6E', bg: 'rgba(57,255,110,.10)' },
    trial: { icon: Sparkles, color: '#A78BFA', bg: 'rgba(167,139,250,.10)' },
    sale: { icon: Target, color: '#67E8F9', bg: 'rgba(103,232,249,.10)' },
    failed: { icon: XCircle, color: '#FB7185', bg: 'rgba(251,113,133,.10)' },
    canceled: { icon: XCircle, color: '#FB923C', bg: 'rgba(251,146,60,.10)' },
    refund: { icon: ArrowUpRight, color: '#FACC15', bg: 'rgba(250,204,21,.10)' },
    customer: { icon: UserCheck, color: '#39FF6E', bg: 'rgba(57,255,110,.10)' },
  };
  const selected = map[category] || { icon: Activity, color: '#94A3B8', bg: 'rgba(148,163,184,.10)' };
  const Icon = selected.icon;
  return (
    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-white/[0.06]" style={{ background: selected.bg }}>
      <Icon className="h-4 w-4" style={{ color: selected.color }} />
    </span>
  );
}

function LoadingState() {
  return (
    <div className="h-full overflow-y-auto bg-[#030504] p-4 md:p-7">
      <div className="mx-auto max-w-[1580px] animate-pulse space-y-5">
        <div className="h-24 rounded-[26px] border border-white/[0.06] bg-white/[0.025]" />
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="h-[420px] rounded-[26px] border border-white/[0.06] bg-white/[0.025]" />
          <div className="h-[420px] rounded-[26px] border border-white/[0.06] bg-white/[0.025]" />
        </div>
        <div className="h-80 rounded-[26px] border border-white/[0.06] bg-white/[0.025]" />
      </div>
    </div>
  );
}

function AccessDenied() {
  return (
    <div className="grid h-full place-items-center overflow-y-auto bg-[#030504] p-6">
      <div className="max-w-md rounded-[28px] border border-red-400/15 bg-red-400/[0.05] p-8 text-center shadow-2xl">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-red-400/20 bg-red-400/10">
          <ShieldAlert className="h-6 w-6 text-red-300" />
        </span>
        <h1 className="mt-5 text-2xl font-black text-white">This account is not approved</h1>
        <p className="mt-2 text-sm leading-relaxed text-white/45">FirstKnock HQ is limited to the authorized operator accounts.</p>
        <button onClick={() => base44.auth.logout(window.location.origin + '/hq/index.html')} className="mt-5 inline-flex h-10 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 text-[10px] font-black uppercase tracking-[0.14em] text-white/65 hover:bg-white/[0.08]">
          <LogOut className="h-4 w-4" /> Use another account
        </button>
      </div>
    </div>
  );
}

export default function AdminDashboard() {
  const queryClient = useQueryClient();
  const dashboardScrollRef = useRef(null);
  const tabShellRef = useRef(null);
  const tabStripRef = useRef(null);
  const [activeTab, setActiveTab] = useState(hqTabFromLocation);
  const [period, setPeriod] = useState('all');
  const [leaderboardSearch, setLeaderboardSearch] = useState('');
  const [feedFilter, setFeedFilter] = useState('all');
  const [customerFilter, setCustomerFilter] = useState('current');
  const [customerSearch, setCustomerSearch] = useState('');
  const timeZone = useMemo(resolvedTimeZone, []);

  useEffect(() => {
    const syncTabFromLocation = () => {
      const tabId = hqTabFromLocation();
      const canonicalHash = hashForSection(tabId);
      if (window.location.hash !== canonicalHash) window.history.replaceState(null, '', canonicalHash);
      setActiveTab(tabId);
      window.requestAnimationFrame(() => {
        dashboardScrollRef.current?.scrollTo({ top: tabShellRef.current?.offsetTop || 0, behavior: 'auto' });
      });
    };
    const initialTab = hqTabFromLocation();
    const initialHash = hashForSection(initialTab);
    if (window.location.hash !== initialHash) window.history.replaceState(null, '', initialHash);
    window.addEventListener('hashchange', syncTabFromLocation);
    window.addEventListener('popstate', syncTabFromLocation);
    return () => {
      window.removeEventListener('hashchange', syncTabFromLocation);
      window.removeEventListener('popstate', syncTabFromLocation);
    };
  }, []);

  useEffect(() => {
    const strip = tabStripRef.current;
    const activeButton = strip?.querySelector(`[data-hq-tab="${activeTab}"]`);
    if (!strip || !activeButton) return;
    strip.scrollLeft = Math.max(0, activeButton.offsetLeft - (strip.clientWidth - activeButton.clientWidth) / 2);
  }, [activeTab]);

  const selectHqTab = (tabId, focusTab = false) => {
    if (!HQ_SECTION_IDS.includes(tabId)) return;
    setActiveTab(tabId);
    const nextHash = hashForSection(tabId);
    if (window.location.hash !== nextHash) {
      if (focusTab) window.history.replaceState(null, '', nextHash);
      else window.history.pushState(null, '', nextHash);
    }
    dashboardScrollRef.current?.scrollTo({ top: tabShellRef.current?.offsetTop || 0, behavior: 'auto' });
    if (focusTab) {
      window.requestAnimationFrame(() => tabStripRef.current?.querySelector(`[data-hq-tab="${tabId}"]`)?.focus());
    }
  };

  const handleTabKeyDown = (event) => {
    const nextTabId = nextSectionForKey(activeTab, event.key);
    if (!nextTabId) return;
    event.preventDefault();
    selectHqTab(nextTabId, true);
  };

  const { data: user, isLoading: isUserLoading } = useQuery({
    queryKey: ['user'],
    queryFn: () => base44.auth.me(),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const isAuthorizedViewer = canViewPlatformDashboard(user);

  const handleLogout = async () => {
    try {
      await base44.auth.logout(window.location.origin + '/hq/index.html');
    } finally {
      queryClient.clear();
    }
  };

  const analyticsQuery = useQuery({
    queryKey: ['platformCommandCenter', timeZone],
    queryFn: async () => {
      const response = await base44.functions.invoke('adminDiagnostics', {
        view: 'platform_command_center',
        time_zone: timeZone,
      });
      const payload = response?.data || response;
      if (!isCompletePlatformPayload(payload)) {
        throw new Error(payload?.error || 'The command center did not return a complete platform snapshot.');
      }
      return payload;
    },
    enabled: isAuthorizedViewer,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
    retry: 1,
  });

  const data = analyticsQuery.data;
  const adoptionView = useMemo(
    () => buildPlatformAdoptionView(data?.rep?.adoption),
    [data?.rep?.adoption]
  );
  const rep = data?.rep?.periods?.[period];
  const rep30 = data?.rep?.periods?.['30d'];
  const trend = data?.rep?.trend || [];
  const business = data?.business;
  const loadedCustomerCount = business?.customers?.length || 0;
  const totalCustomerCount = Number(business?.customer_count ?? loadedCustomerCount);
  const stripeMetrics = business?.metrics;
  const stripeLive = data?.source_health?.stripe?.status === 'live';
  const currentSoldDoors = data?.rep?.field_ops?.current_sold_doors?.total || 0;
  const revenueCoverage = rep?.confirmed_sales > 0 ? Math.round((rep.valued_sales / rep.confirmed_sales) * 100) : 0;
  const stripeCashDays = trend.filter((point) => Number(point?.stripe_revenue || 0) > 0).length;
  const stripeBestDay = trend.reduce((best, point) => (
    Number(point?.stripe_revenue || 0) > Number(best?.stripe_revenue || 0) ? point : best
  ), null);
  const stripeDailyAverage = Number(stripeMetrics?.collected_30d || 0) / 30;

  const leaderboard = useMemo(() => {
    const query = leaderboardSearch.trim().toLowerCase();
    return (rep?.leaderboard || [])
      .map((row, index) => ({ ...row, rank: index + 1 }))
      .filter((row) => !query || [row.name, row.email, row.team_name].some((value) => String(value || '').toLowerCase().includes(query)));
  }, [rep?.leaderboard, leaderboardSearch]);

  const feed = useMemo(() => (data?.feed || []).filter((item) => {
    if (feedFilter === 'stripe') return item.source === 'stripe';
    if (feedFilter === 'sales') return item.category === 'sale';
    return true;
  }), [data?.feed, feedFilter]);

  const customers = useMemo(() => {
    const query = customerSearch.trim().toLowerCase();
    return (business?.customers || []).filter((customer) => {
      const matchesQuery = !query || [customer.name, customer.email, customer.plan].some((value) => String(value || '').toLowerCase().includes(query));
      if (!matchesQuery) return false;
      if (customerFilter === 'paid') return customer.status === 'active' && customer.paid_confirmed;
      if (customerFilter === 'trialing') return ['trialing', 'beta'].includes(customer.status);
      if (customerFilter === 'risk') return ['past_due', 'unpaid', 'incomplete'].includes(customer.status);
      if (customerFilter === 'current') return ['active', 'trialing', 'beta', 'past_due', 'unpaid', 'incomplete'].includes(customer.status);
      return true;
    });
  }, [business?.customers, customerFilter, customerSearch]);

  if (isUserLoading) return <LoadingState />;
  if (!isAuthorizedViewer) return <AccessDenied />;
  if (analyticsQuery.isLoading) return <LoadingState />;

  if (analyticsQuery.isError) {
    return (
      <div className="grid h-full place-items-center overflow-y-auto bg-[#030504] p-6">
        <div className="max-w-lg rounded-[28px] border border-amber-400/15 bg-amber-400/[0.05] p-8 text-center">
          <AlertTriangle className="mx-auto h-8 w-8 text-amber-300" />
          <h1 className="mt-4 text-2xl font-black text-white">Metrics are temporarily unavailable</h1>
          <p className="mt-2 text-sm leading-relaxed text-white/45">No partial totals are being shown as zero. Retry to reload the complete FirstKnock and Stripe picture.</p>
          <button onClick={() => analyticsQuery.refetch()} className="mt-6 inline-flex h-11 items-center gap-2 rounded-xl bg-[#39FF6E] px-5 text-xs font-black uppercase tracking-[0.14em] text-black transition-transform hover:-translate-y-0.5">
            <RefreshCw className="h-4 w-4" /> Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={dashboardScrollRef} className="relative h-full overflow-y-auto bg-[#030504] text-white">
      <div className="pointer-events-none fixed inset-0 opacity-60" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,.018) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.018) 1px, transparent 1px)', backgroundSize: '44px 44px' }} />
      <div className="pointer-events-none fixed -left-32 top-20 h-96 w-96 rounded-full bg-[#39FF6E]/[0.07] blur-[120px]" />
      <div className="pointer-events-none fixed -right-32 top-1/3 h-96 w-96 rounded-full bg-violet-500/[0.08] blur-[130px]" />

      <div className="relative mx-auto flex w-full max-w-[1580px] flex-col gap-5 p-3 pb-12 sm:p-5 md:p-7">
        <header className="relative -mx-1 flex flex-col gap-4 rounded-[24px] border border-white/[0.07] bg-[#050806]/90 px-4 py-4 shadow-2xl backdrop-blur-2xl sm:px-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-4">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl border border-[#39FF6E]/20 bg-[#39FF6E]/10 shadow-[0_0_28px_rgba(57,255,110,.12)]">
              <Gauge className="h-5 w-5 text-[#39FF6E]" />
            </span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-black tracking-[-0.04em] sm:text-2xl">Mission Control</h1>
                <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-white/35">Platform wide</span>
              </div>
              <p className="mt-0.5 text-[11px] font-medium text-white/38">FirstKnock field production + customer revenue intelligence</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SourceStatus source={data?.source_health?.stripe} />
            <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.035] px-3 py-1.5 text-[10px] font-bold text-white/45">
              <Radio className="h-3.5 w-3.5 text-[#39FF6E]" />
              Synced {relativeTime(data?.generated_at)}
            </div>
            <button
              onClick={() => analyticsQuery.refetch()}
              disabled={analyticsQuery.isFetching}
              aria-label="Refresh platform analytics"
              className="grid h-9 w-9 place-items-center rounded-full border border-white/[0.09] bg-white/[0.04] text-white/55 transition-all hover:border-white/20 hover:bg-white/[0.08] hover:text-white disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${analyticsQuery.isFetching ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={handleLogout}
              aria-label="Sign out of FirstKnock HQ"
              className="grid h-9 w-9 place-items-center rounded-full border border-white/[0.09] bg-white/[0.04] text-white/45 transition-all hover:border-white/20 hover:bg-white/[0.08] hover:text-white"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </header>

        <nav ref={tabShellRef} aria-label="HQ sections" className="hq-tab-shell">
          <div ref={tabStripRef} role="tablist" aria-label="FirstKnock HQ sections" className="hq-tab-strip">
            {HQ_TABS.map((tab) => {
              const Icon = tab.icon;
              const selected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  id={`hq-tab-${tab.id}`}
                  type="button"
                  role="tab"
                  data-hq-tab={tab.id}
                  aria-selected={selected}
                  aria-controls={`hq-panel-${tab.id}`}
                  tabIndex={selected ? 0 : -1}
                  className={`hq-tab-button ${selected ? 'is-active' : ''}`}
                  onClick={() => selectHqTab(tab.id)}
                  onKeyDown={handleTabKeyDown}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>
        </nav>

        <div id="hq-panel-field" role="tabpanel" aria-labelledby="hq-tab-field" tabIndex={0} hidden={activeTab !== 'field'} className="hq-tab-panel">
          <Panel className="p-4 sm:p-5">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#39FF6E]/60 to-transparent" />
            <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <Eyebrow><Zap className="h-3 w-3" /> Our guys</Eyebrow>
                <h2 className="mt-3 text-2xl font-black tracking-[-0.045em] sm:text-3xl">Field performance</h2>
                <p className="mt-1 text-xs text-white/40">What the entire rep organization is producing across Precision and Canvas.</p>
              </div>
              <PeriodSwitcher period={period} onChange={setPeriod} />
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <HeroMetric
                icon={Target}
                label="Door close"
                value={`${Number(rep?.door_close_rate || rep?.close_rate || 0).toFixed(1)}%`}
                rate={rep?.door_close_rate || rep?.close_rate || 0}
                helper={`${formatNumber(rep?.confirmed_sales)} confirmed sales / ${formatNumber(rep?.knocks)} logged knocks`}
              />
              <div className="grid grid-cols-2 gap-3 sm:col-span-2">
                <MetricTile icon={DoorOpen} label="Logged knocks" value={formatNumber(rep?.knocks, true)} helper={`${formatNumber(rep?.unique_doors)} unique doors`} />
                <MetricTile icon={Users} label="DM conversations" value={formatNumber(rep?.decision_maker_conversations, true)} helper={`${Number(rep?.talk_rate || 0).toFixed(1)}% of knocks reached a decision maker`} color="#67E8F9" />
                <MetricTile icon={Crown} label="Confirmed sales" value={formatNumber(rep?.confirmed_sales, true)} helper={`${formatNumber(currentSoldDoors)} doors currently marked sold`} color="#FACC15" />
                <MetricTile icon={Banknote} label="Sales volume" value={formatMoney(rep?.recorded_sales_volume, true)} helper={`${revenueCoverage}% of sales include value`} color="#67E8F9" />
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-white/[0.06] bg-black/30 p-4">
              <div className="flex items-center justify-between gap-3 text-[10px] font-black uppercase tracking-[0.15em]">
                <span className="text-white/38">Activity source mix</span>
                <span className="font-mono text-white/55">{formatNumber(rep?.active_reps)} active reps · {formatNumber(rep?.appointments)} appointments</span>
              </div>
              <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-white/[0.05]">
                <div className="h-full bg-[#39FF6E]" style={{ width: `${rep?.knocks ? (rep.precision_knocks / rep.knocks) * 100 : 0}%` }} />
                <div className="h-full bg-cyan-300" style={{ width: `${rep?.knocks ? (rep.canvas_knocks / rep.knocks) * 100 : 0}%` }} />
              </div>
              <p className="mt-2 text-right font-mono text-[9px] font-bold text-white/28">{formatNumber(rep?.precision_knocks)} Precision · {formatNumber(rep?.canvas_knocks)} Canvas</p>
            </div>
          </Panel>
        </div>

        <div id="hq-panel-adoption" role="tabpanel" aria-labelledby="hq-tab-adoption" tabIndex={0} hidden={activeTab !== 'adoption'} className="hq-tab-panel">
          <UserActivityHeatmap
            members={adoptionView.members}
            activityData={adoptionView.activity}
            externalUpdatedAt={Date.parse(data?.generated_at || '') || 0}
            isRefreshing={analyticsQuery.isFetching}
            minimumActivityDate={data?.rep?.adoption?.days?.[0]?.date}
            onRefresh={() => analyticsQuery.refetch()}
            rankByActivity
            scopeLabel="Platform"
          />
        </div>

        <div id="hq-panel-revenue" role="tabpanel" aria-labelledby="hq-tab-revenue" tabIndex={0} hidden={activeTab !== 'revenue'} className="hq-tab-panel">
          <Panel className="p-4 sm:p-5">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-violet-400/70 to-transparent" />
            <div className="mb-5 flex items-end justify-between gap-3">
              <div>
                <Eyebrow tone="violet"><CreditCard className="h-3 w-3" /> Our customers</Eyebrow>
                <h2 className="mt-3 text-2xl font-black tracking-[-0.045em] sm:text-3xl">Revenue engine</h2>
                <p className="mt-1 text-xs text-white/40">Live subscriber health and confirmed Stripe cash.</p>
              </div>
              {stripeLive && <span className="hidden rounded-lg border border-white/[0.07] bg-white/[0.03] px-2.5 py-1.5 font-mono text-[9px] font-bold text-white/35 sm:block">60s refresh</span>}
            </div>

            {!stripeLive ? (
              <div className="grid min-h-[312px] place-items-center rounded-2xl border border-amber-400/15 bg-amber-400/[0.04] p-7 text-center">
                <div>
                  <AlertTriangle className="mx-auto h-7 w-7 text-amber-300" />
                  <h3 className="mt-3 text-lg font-black">Stripe connection needs attention</h3>
                  <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-white/40">Rep analytics remain live. Customer totals are withheld so a connection issue can never look like zero revenue.</p>
                </div>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-3">
                <HeroMetric
                  icon={TrendingUp}
                  label="Contracted MRR"
                  value={formatMoney(stripeMetrics?.mrr, true)}
                  helper={`${formatMoney(stripeMetrics?.trial_mrr_pipeline, true)} additional MRR currently in trial`}
                  color="#A78BFA"
                />
                <div className="grid grid-cols-2 gap-3 sm:col-span-2">
                  <MetricTile icon={UserCheck} label="Paying customers" value={formatNumber(stripeMetrics?.paying_customers)} helper={`${formatNumber(stripeMetrics?.paid_seats)} paid seats · verified by Stripe`} color="#39FF6E" />
                  <MetricTile icon={Sparkles} label="Trials & beta" value={formatNumber(stripeMetrics?.active_trials_and_beta)} helper={`${formatNumber(stripeMetrics?.active_trials)} Stripe · ${formatNumber(stripeMetrics?.active_beta_accounts)} beta`} color="#A78BFA" />
                  <MetricTile icon={CircleDollarSign} label="Gross collected" value={formatMoney(stripeMetrics?.gross_collected, true)} helper={`${formatMoney(stripeMetrics?.collected_30d, true)} in the last 30 days`} color="#67E8F9" />
                  <MetricTile icon={AlertTriangle} label="At-risk accounts" value={formatNumber(stripeMetrics?.past_due_customers)} helper={`${formatNumber(stripeMetrics?.confirmed_payments)} confirmed payments`} color="#FB923C" />
                </div>
              </div>
            )}

            <div className="mt-4 grid grid-cols-3 divide-x divide-white/[0.06] rounded-2xl border border-white/[0.06] bg-black/30 py-3 text-center">
              <div className="px-2"><p className="font-mono text-lg font-black">{formatNumber(business?.total_app_accounts)}</p><p className="mt-1 text-[8px] font-black uppercase tracking-[0.14em] text-white/35">App accounts</p></div>
              <div className="px-2"><p className="font-mono text-lg font-black">{formatNumber(business?.manager_accounts)}</p><p className="mt-1 text-[8px] font-black uppercase tracking-[0.14em] text-white/35">Managers</p></div>
              <div className="px-2"><p className="font-mono text-lg font-black">{formatNumber(stripeMetrics?.total_stripe_customers)}</p><p className="mt-1 text-[8px] font-black uppercase tracking-[0.14em] text-white/35">Stripe customers</p></div>
            </div>
          </Panel>
        </div>

        <div id="hq-panel-pulse" role="tabpanel" aria-labelledby="hq-tab-pulse" tabIndex={0} hidden={activeTab !== 'pulse'} className="hq-tab-panel">
          <Panel className="p-4 sm:p-5">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <Eyebrow tone="cyan"><BarChart3 className="h-3 w-3" /> 30-day pulse</Eyebrow>
                <h3 className="mt-3 text-xl font-black tracking-[-0.035em]">Decision-maker runway</h3>
                <p className="mt-1 text-[11px] text-white/38">Talked-to people versus sold, on one honest scale. No answers are excluded.</p>
              </div>
              <div className="rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.06] px-4 py-2.5 sm:text-right">
                <p className="text-[8px] font-black uppercase tracking-[0.18em] text-cyan-100/45">DM close · 30 days</p>
                <p className="mt-1 font-mono text-2xl font-black text-cyan-100">{Number(rep30?.decision_maker_close_rate || 0).toFixed(1)}%</p>
              </div>
            </div>
            <DimensionalColumnChart
              data={trend}
              ariaLabel="Thirty day decision-maker conversations and confirmed sales"
              series={[
                { key: 'decision_maker_conversations', label: 'DM conversations', tone: 'cyan' },
                { key: 'sales', label: 'Confirmed sales', tone: 'green' },
              ]}
              dayAriaLabel={(point) => {
                const conversations = Number(point?.decision_maker_conversations || 0);
                const sales = Number(point?.sales || 0);
                const close = conversations > 0 ? (sales / conversations) * 100 : 0;
                return `${fullDayLabel(point)}: ${conversations} decision-maker conversations, ${sales} confirmed sales, ${close.toFixed(1)} percent close rate`;
              }}
              renderReadout={(point) => {
                const conversations = Number(point?.decision_maker_conversations || 0);
                const sales = Number(point?.sales || 0);
                const close = conversations > 0 ? (sales / conversations) * 100 : 0;
                return (
                  <>
                    <div><p>Selected day</p><strong>{point?.label}</strong></div>
                    <div className="dimensional-readout-values">
                      <span><b className="text-cyan-200">{formatNumber(conversations)}</b> DM conversations</span>
                      <span><b className="text-[#8CFFA6]">{formatNumber(sales)}</b> sold</span>
                      <span><b className="text-white">{close.toFixed(1)}%</b> DM close</span>
                    </div>
                  </>
                );
              }}
            />
          </Panel>
        </div>

        <div id="hq-panel-cash" role="tabpanel" aria-labelledby="hq-tab-cash" tabIndex={0} hidden={activeTab !== 'cash'} className="hq-tab-panel">
          <Panel className="p-4 sm:p-5">
            <div className="mb-4 flex items-end justify-between gap-3">
              <div>
                <Eyebrow tone="violet"><DollarSign className="h-3 w-3" /> Stripe cash</Eyebrow>
                <h3 className="mt-3 text-xl font-black tracking-[-0.035em]">Cash vault</h3>
                <p className="mt-1 text-[11px] text-white/38">Confirmed Stripe collections, day by day.</p>
              </div>
              {stripeLive && (
                <div className="text-right">
                  <p className="text-[8px] font-black uppercase tracking-[0.18em] text-violet-200/45">Collected · 30 days</p>
                  <p className="mt-1 font-mono text-2xl font-black text-violet-100">{formatMoney(stripeMetrics?.collected_30d, true)}</p>
                </div>
              )}
            </div>
            {stripeLive ? (
              <>
                <DimensionalColumnChart
                  data={trend}
                  ariaLabel="Thirty day confirmed Stripe cash collections"
                  series={[{ key: 'stripe_revenue', label: 'Stripe cash', tone: 'violet' }]}
                  scaleFormatter={(value) => formatMoney(value, true)}
                  dayAriaLabel={(point) => `${fullDayLabel(point)}: ${preciseMoney.format(point?.stripe_revenue || 0)} collected through Stripe`}
                  renderReadout={(point) => (
                    <>
                      <div><p>Selected day</p><strong>{point?.label}</strong></div>
                      <div className="dimensional-readout-values">
                        <span><b className="text-violet-200">{preciseMoney.format(point?.stripe_revenue || 0)}</b> confirmed cash</span>
                      </div>
                    </>
                  )}
                />
                <div className="mt-3 grid grid-cols-3 divide-x divide-white/[0.06] rounded-2xl border border-white/[0.06] bg-black/25 py-3 text-center">
                  <div className="px-2"><p className="font-mono text-base font-black text-violet-100">{formatNumber(stripeCashDays)}</p><p className="mt-1 text-[8px] font-black uppercase tracking-[0.13em] text-white/30">Cash days</p></div>
                  <div className="px-2"><p className="font-mono text-base font-black text-violet-100">{formatMoney(stripeDailyAverage, true)}</p><p className="mt-1 text-[8px] font-black uppercase tracking-[0.13em] text-white/30">Daily average</p></div>
                  <div className="px-2"><p className="font-mono text-base font-black text-violet-100">{formatMoney(stripeBestDay?.stripe_revenue, true)}</p><p className="mt-1 text-[8px] font-black uppercase tracking-[0.13em] text-white/30">Best day</p></div>
                </div>
              </>
            ) : (
              <div className="grid h-[360px] place-items-center text-center text-xs text-white/35">The cash vault will appear when Stripe reconnects.</div>
            )}
          </Panel>
        </div>

        <div id="hq-panel-leaderboard" role="tabpanel" aria-labelledby="hq-tab-leaderboard" tabIndex={0} hidden={activeTab !== 'leaderboard'} className="hq-tab-panel">
          <Panel>
            <div className="flex flex-col gap-3 border-b border-white/[0.06] p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
              <div>
                <Eyebrow><Crown className="h-3 w-3" /> Rep leaderboard</Eyebrow>
                <h3 className="mt-3 text-xl font-black tracking-[-0.035em]">Who is closing the most</h3>
                <p className="mt-1 text-[11px] text-white/35">Door conversion and talked-to conversion, side by side.</p>
              </div>
              <div className="flex w-full flex-col gap-2 sm:w-auto lg:flex-row">
                <PeriodSwitcher period={period} onChange={setPeriod} />
                <div className="flex h-11 w-full items-center gap-2 rounded-xl border border-white/[0.08] bg-black/35 px-3 text-white/40 focus-within:border-[#39FF6E]/30 focus-within:text-white/70 sm:h-10 sm:w-auto">
                  <Search className="h-4 w-4" />
                  <input type="search" aria-label="Search rep leaderboard" value={leaderboardSearch} onChange={(event) => setLeaderboardSearch(event.target.value)} placeholder="Search rep or email" className="min-w-0 flex-1 bg-transparent text-xs text-white outline-none placeholder:text-white/25 sm:w-48" />
                  {leaderboardSearch && <button type="button" onClick={() => setLeaderboardSearch('')} aria-label="Clear rep search" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-white/35 hover:bg-white/[0.06] hover:text-white"><XCircle className="h-4 w-4" /></button>}
                </div>
              </div>
            </div>
            <ol data-hq-view="leaderboard-mobile" aria-label="Rep leaderboard" className="mobile-record-list lg:hidden">
              {leaderboard.map((row) => (
                <li key={row.key} data-hq-card="rep" className="mobile-record-card mobile-record-card--rep">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <RankBadge rank={row.rank} />
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-white/[0.09] bg-gradient-to-br from-white/[0.1] to-white/[0.025] text-sm font-black text-white/75">{String(row.name || '?').slice(0, 1).toUpperCase()}</span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-black text-white">{row.name}</p>
                        <p className="mobile-record-email">{row.email}</p>
                      </div>
                    </div>
                    <div className="mobile-sales-pill">
                      <span>Sales</span>
                      <strong>{formatNumber(row.confirmed_sales)}</strong>
                    </div>
                  </div>

                  <dl className="mobile-primary-metrics">
                    <div className="mobile-primary-metric is-green">
                      <dt>DM close</dt>
                      <dd>{Number(row.decision_maker_close_rate || 0).toFixed(1)}%</dd>
                      <p>Sales ÷ conversations</p>
                    </div>
                    <div className="mobile-primary-metric">
                      <dt>Door close</dt>
                      <dd>{Number(row.door_close_rate || row.close_rate || 0).toFixed(1)}%</dd>
                      <p>Sales ÷ doors</p>
                    </div>
                  </dl>

                  <dl className="mobile-secondary-metrics">
                    <div><dt>Doors</dt><dd>{formatNumber(row.knocks)}</dd></div>
                    <div><dt>DM convos</dt><dd>{formatNumber(row.decision_maker_conversations)}</dd></div>
                    <div><dt>Talk rate</dt><dd>{Number(row.talk_rate || 0).toFixed(1)}%</dd></div>
                  </dl>

                  <div className="mobile-record-footer">
                    <span>Sales volume</span>
                    <strong>{formatMoney(row.recorded_sales_volume, true)}</strong>
                    {row.unvalued_sales > 0 && <small>{row.unvalued_sales} sale{row.unvalued_sales === 1 ? '' : 's'} without value</small>}
                  </div>
                </li>
              ))}
              {leaderboard.length === 0 && <li className="mobile-empty-card">No reps match this search.</li>}
            </ol>
            <div data-hq-view="leaderboard-desktop" className="hidden max-h-[540px] overflow-auto lg:block">
              <table className="w-full min-w-[1120px] text-left">
                <thead className="sticky top-0 z-10 border-b border-white/[0.06] bg-[#080B09]/95 text-[9px] font-black uppercase tracking-[0.15em] text-white/30 backdrop-blur-xl">
                  <tr>
                    <th className="px-5 py-3">Rank</th>
                    <th className="px-3 py-3">Rep</th>
                    <th className="px-3 py-3 text-right" title="Logged door outcomes">Doors</th>
                    <th className="px-3 py-3 text-right" title="Inferred decision-maker conversations; no-answer outcomes excluded">DM convos</th>
                    <th className="px-3 py-3 text-right">Sales</th>
                    <th className="px-3 py-3 text-right" title="Decision-maker conversations divided by logged doors">Talk %</th>
                    <th className="px-3 py-3 text-right" title="Confirmed sales divided by logged doors">Door close %</th>
                    <th className="px-3 py-3 text-right" title="Confirmed sales divided by inferred decision-maker conversations">DM close %</th>
                    <th className="px-5 py-3 text-right">Sales volume</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.05]">
                  {leaderboard.map((row) => (
                    <tr key={row.key} className="group transition-colors hover:bg-white/[0.025]">
                      <td className="px-5 py-3"><RankBadge rank={row.rank} /></td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-3">
                          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/[0.08] bg-gradient-to-br from-white/[0.09] to-white/[0.02] text-xs font-black text-white/70">{String(row.name || '?').slice(0, 1).toUpperCase()}</span>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-bold text-white">{row.name}</p>
                            <p className="max-w-[260px] truncate text-[10px] text-white/35">{row.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-sm font-bold text-white/60">{formatNumber(row.knocks)}</td>
                      <td className="px-3 py-3 text-right font-mono text-sm font-bold text-cyan-200/80">{formatNumber(row.decision_maker_conversations)}</td>
                      <td className="px-3 py-3 text-right font-mono text-sm font-black text-[#7CFF9C]">{formatNumber(row.confirmed_sales)}</td>
                      <td className="px-3 py-3 text-right">
                        <span className="inline-flex min-w-[62px] justify-center rounded-lg border border-cyan-300/15 bg-cyan-300/[0.06] px-2 py-1 font-mono text-xs font-black text-cyan-100">{Number(row.talk_rate || 0).toFixed(1)}%</span>
                      </td>
                      <td className="px-3 py-3 text-right">
                        <span className="inline-flex min-w-[62px] justify-center rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 font-mono text-xs font-black text-white/65">{Number(row.door_close_rate || row.close_rate || 0).toFixed(1)}%</span>
                      </td>
                      <td className="px-3 py-3 text-right">
                        <span className="inline-flex min-w-[62px] justify-center rounded-lg border border-[#39FF6E]/15 bg-[#39FF6E]/[0.07] px-2 py-1 font-mono text-xs font-black text-[#8CFFA6]">{Number(row.decision_maker_close_rate || 0).toFixed(1)}%</span>
                      </td>
                      <td className="px-5 py-3 text-right">
                        <p className="font-mono text-sm font-black text-cyan-200">{formatMoney(row.recorded_sales_volume, true)}</p>
                        {row.unvalued_sales > 0 && <p className="mt-0.5 text-[9px] text-white/25">{row.unvalued_sales} without value</p>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {leaderboard.length === 0 && <div className="grid h-44 place-items-center text-sm text-white/35">No reps match this search.</div>}
            </div>
          </Panel>
        </div>

        <div id="hq-panel-live" role="tabpanel" aria-labelledby="hq-tab-live" tabIndex={0} hidden={activeTab !== 'live'} className="hq-tab-panel">
          <Panel className="hq-live-panel flex min-h-[520px] flex-col">
            <div className="border-b border-white/[0.06] p-4 sm:p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Eyebrow tone="cyan"><Activity className="h-3 w-3" /> Live wire</Eyebrow>
                  <h3 className="mt-3 text-xl font-black tracking-[-0.035em]">What is happening now</h3>
                </div>
                <span className="flex items-center gap-2 font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-white/30"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#39FF6E]" /> Auto</span>
              </div>
              <div className="mt-4 flex gap-1 rounded-xl border border-white/[0.07] bg-black/35 p-1">
                {[
                  { id: 'all', label: 'All' },
                  { id: 'stripe', label: 'Stripe' },
                  { id: 'sales', label: 'Rep sales' },
                ].map((option) => (
                  <button key={option.id} onClick={() => setFeedFilter(option.id)} className={`flex-1 rounded-lg px-2 py-2 text-[9px] font-black uppercase tracking-[0.12em] transition-colors ${feedFilter === option.id ? 'bg-white/[0.09] text-white' : 'text-white/30 hover:text-white/60'}`}>{option.label}</button>
                ))}
              </div>
            </div>
            <div className="flex-1 divide-y divide-white/[0.05] overflow-y-auto">
              {feed.slice(0, 40).map((item) => (
                <div key={item.id} className="flex gap-3 p-4 transition-colors hover:bg-white/[0.025]">
                  <FeedGlyph category={item.category} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-black text-white">{item.title}</p>
                        <p className="mt-1 truncate text-[10px] text-white/38">{item.name || item.email}</p>
                      </div>
                      {Number(item.amount) > 0 && <span className="shrink-0 font-mono text-xs font-black text-[#8CFFA6]">{preciseMoney.format(item.amount)}</span>}
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3 text-[9px] font-bold uppercase tracking-[0.1em] text-white/25">
                      <span>{item.source === 'stripe' ? 'Stripe' : item.mode || 'FirstKnock'}</span>
                      <span>{relativeTime(item.occurred_at)}</span>
                    </div>
                  </div>
                </div>
              ))}
              {feed.length === 0 && <div className="grid h-44 place-items-center px-6 text-center text-xs text-white/35">No activity in this feed yet.</div>}
            </div>
          </Panel>
        </div>

        <div id="hq-panel-customers" role="tabpanel" aria-labelledby="hq-tab-customers" tabIndex={0} hidden={activeTab !== 'customers'} className="hq-tab-panel">
        <Panel>
          <div className="flex flex-col gap-4 border-b border-white/[0.06] p-4 sm:p-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <Eyebrow tone="violet"><Users className="h-3 w-3" /> Customer book</Eyebrow>
              <h3 className="mt-3 text-xl font-black tracking-[-0.035em]">Customer subscription book</h3>
              <p className="mt-1 text-xs text-white/38">Live Stripe status, plan, seats, MRR, and renewal timing.</p>
              <p aria-live="polite" className="mt-2 font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-violet-200/45">
                {formatNumber(customers.length)} matching · {loadedCustomerCount < totalCustomerCount
                  ? `${formatNumber(loadedCustomerCount)} of ${formatNumber(totalCustomerCount)} loaded`
                  : `${formatNumber(totalCustomerCount)} total`}
              </p>
            </div>
            <div className="flex w-full flex-col gap-2 sm:flex-row lg:w-auto">
              <div role="group" aria-label="Filter customer book" className="order-2 -mx-1 min-w-0 overflow-x-auto px-1 pb-1 sm:order-1 sm:mx-0 sm:flex-1 sm:pb-0 lg:flex-none">
                <div className="flex w-max min-w-full gap-1 rounded-xl border border-white/[0.07] bg-black/35 p-1 sm:min-w-0">
                  {CUSTOMER_FILTERS.map((option) => (
                    <button key={option.id} type="button" aria-pressed={customerFilter === option.id} onClick={() => setCustomerFilter(option.id)} className={`min-h-11 shrink-0 snap-start rounded-lg px-3 py-2 text-[9px] font-black uppercase tracking-[0.1em] transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-violet-300 sm:min-h-10 ${customerFilter === option.id ? 'bg-violet-400/15 text-violet-100' : 'text-white/35 hover:text-white/65'}`}>{option.label}</button>
                  ))}
                </div>
              </div>
              <div className="order-1 flex h-11 w-full items-center gap-2 rounded-xl border border-white/[0.08] bg-black/35 px-3 text-white/40 focus-within:border-violet-400/30 focus-within:text-white/70 sm:order-2 sm:h-10 sm:w-auto">
                <Search className="h-4 w-4" />
                <input type="search" aria-label="Search customer book" value={customerSearch} onChange={(event) => setCustomerSearch(event.target.value)} placeholder="Search customers" className="min-w-0 flex-1 bg-transparent text-xs text-white outline-none placeholder:text-white/25 sm:w-44" />
                {customerSearch && <button type="button" onClick={() => setCustomerSearch('')} aria-label="Clear customer search" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-white/35 hover:bg-white/[0.06] hover:text-white"><XCircle className="h-4 w-4" /></button>}
              </div>
            </div>
          </div>
          {!stripeLive ? (
            <div className="grid h-48 place-items-center px-6 text-center text-xs text-white/35">Customer records will appear when Stripe reconnects.</div>
          ) : (
            <>
              <ul data-hq-view="customers-mobile" aria-label="Customer subscriptions" className="mobile-record-list lg:hidden">
                {customers.map((customer) => {
                  const milestone = customerMilestone(customer);
                  return (
                    <li key={customer.key} data-hq-card="customer" className={`mobile-record-card ${customerCardTone(customer)}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-3">
                          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-violet-300/15 bg-violet-400/[0.08] text-sm font-black text-violet-100">{String(customer.name || '?').slice(0, 1).toUpperCase()}</span>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-black text-white">{customer.name}</p>
                            <p className="mobile-record-email">{customer.email}</p>
                          </div>
                        </div>
                        <StatusBadge status={customer.status} confirmed={customer.paid_confirmed} />
                      </div>

                      <div className="mobile-customer-plan">
                        <span>Plan</span>
                        <strong>{customer.plan || 'Plan unavailable'}</strong>
                      </div>

                      <dl className="mobile-customer-metrics">
                        <div>
                          <dt>MRR</dt>
                          <dd>{formatMoney(customer.mrr)}</dd>
                        </div>
                        <div>
                          <dt>Seats</dt>
                          <dd>{formatNumber(customer.seats)}</dd>
                        </div>
                      </dl>

                      <div className="mobile-customer-milestone">
                        <span>{milestone.label}</span>
                        <strong>{formatDate(milestone.date)}</strong>
                      </div>
                    </li>
                  );
                })}
                {customers.length === 0 && <li className="mobile-empty-card">No customers match this filter.</li>}
              </ul>
              <div data-hq-view="customers-desktop" className="hidden max-h-[560px] overflow-auto lg:block">
              <table className="w-full min-w-[900px] text-left">
                <thead className="sticky top-0 z-10 border-b border-white/[0.06] bg-[#080B09]/95 text-[9px] font-black uppercase tracking-[0.15em] text-white/30 backdrop-blur-xl">
                  <tr>
                    <th className="px-5 py-3">Customer</th>
                    <th className="px-3 py-3">Plan</th>
                    <th className="px-3 py-3">Status</th>
                    <th className="px-3 py-3 text-right">Seats</th>
                    <th className="px-3 py-3 text-right">MRR</th>
                    <th className="px-5 py-3 text-right">Next milestone</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.05]">
                  {customers.map((customer) => {
                    const milestone = customerMilestone(customer);
                    return (
                      <tr key={customer.key} className="transition-colors hover:bg-white/[0.025]">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-violet-400/15 bg-violet-400/[0.08] text-xs font-black text-violet-200">{String(customer.name || '?').slice(0, 1).toUpperCase()}</span>
                          <div className="min-w-0"><p className="max-w-[260px] truncate text-sm font-bold text-white">{customer.name}</p><p className="max-w-[260px] truncate text-[10px] text-white/35">{customer.email}</p></div>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-xs font-bold text-white/65">{customer.plan}</td>
                      <td className="px-3 py-3"><StatusBadge status={customer.status} confirmed={customer.paid_confirmed} /></td>
                      <td className="px-3 py-3 text-right font-mono text-sm font-bold text-white/55">{formatNumber(customer.seats)}</td>
                      <td className="px-3 py-3 text-right font-mono text-sm font-black text-violet-200">{formatMoney(customer.mrr)}</td>
                      <td className="px-5 py-3 text-right">
                        <p className="text-xs font-bold text-white/55">{formatDate(milestone.date)}</p>
                        <p className="mt-0.5 text-[9px] uppercase tracking-[0.1em] text-white/25">{milestone.label}</p>
                      </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {customers.length === 0 && <div className="grid h-44 place-items-center text-sm text-white/35">No customers match this filter.</div>}
              </div>
            </>
          )}
        </Panel>
        </div>

        <div id="hq-panel-operations" role="tabpanel" aria-labelledby="hq-tab-operations" tabIndex={0} hidden={activeTab !== 'operations'} className="hq-tab-panel">
        <Panel className="p-4 sm:p-5">
          <div className="mb-5">
            <Eyebrow tone="cyan"><Activity className="h-3 w-3" /> Operations</Eyebrow>
            <h3 className="mt-3 text-xl font-black tracking-[-0.035em]">Field infrastructure</h3>
            <p className="mt-1 text-xs text-white/38">Routes, roster size, and platform-wide outcome volume.</p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {[
              ['Total routes', data?.rep?.field_ops?.total_routes, Activity],
              ['Active routes', data?.rep?.field_ops?.active_routes, Radio],
              ['Completed routes', data?.rep?.field_ops?.completed_routes, Check],
              ['Team members', data?.rep?.field_ops?.team_members, Users],
              ['Precision outcomes', data?.rep?.field_ops?.precision_outcomes, Target],
              ['Canvas outcomes', data?.rep?.field_ops?.canvas_outcomes, DoorOpen],
            ].map(([label, value, Icon]) => (
              <div key={label} className="rounded-2xl border border-white/[0.06] bg-black/25 p-3.5">
                <div className="flex items-center justify-between"><p className="text-[8px] font-black uppercase tracking-[0.14em] text-white/30">{label}</p><Icon className="h-3.5 w-3.5 text-white/25" /></div>
                <p className="mt-2 font-mono text-xl font-black text-white/75">{formatNumber(value, true)}</p>
              </div>
            ))}
          </div>
          <div className="mt-4 flex flex-col gap-2 border-t border-white/[0.05] pt-4 text-[10px] leading-relaxed text-white/28 sm:flex-row sm:items-center sm:justify-between">
            <p>Sales are rep-reported. Recorded sales volume excludes Canvas sales and any sale without a dollar amount.</p>
            <p>Stripe gross collected is paid invoice volume before refunds; MRR uses active subscriptions with verified paid history. Beta access is shown separately from Stripe trials.</p>
          </div>
        </Panel>

        </div>
      </div>
    </div>
  );
}
