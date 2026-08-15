import React, { useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Eye,
  Loader2,
  Map as MapIcon,
  MapPin,
  Network,
  Pencil,
  RefreshCw,
  Rocket,
  Save,
  Search,
  ShieldCheck,
  Users,
  Wand2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  getCanvasBoundaryAreaSqMiles,
  getCanvasWorkloadDeviation,
} from '@/components/canvas/canvasPlannerUtils';
import {
  getCanvasResidentialOpportunitySummary,
  getCanvasResidentialRoleCounts,
  getCanvasZoneResidentialOpportunity,
} from '@/components/canvas/canvasResidentialPresentation';
import {
  formatCanvasFieldHours,
  formatCanvasOpportunityRange,
  formatCanvasStreetMiles,
  recommendCanvasAreaCount,
  summarizeCanvasPlanWorkload,
} from '@/components/canvas/canvasWorkloadModel';
import { canvasZoneLoggedCount, getCanvasOutcome } from '@/components/canvas/canvasOutcomeUtils';
import { createPageUrl } from '@/utils';

const FALLBACK_COLORS = ['#A855F7', '#2563EB', '#059669', '#EA580C', '#DB2777', '#0891B2', '#CA8A04', '#7C3AED'];

function campaignId(campaign) {
  return String(campaign?.campaign_id || campaign?.session_id || campaign?.id || '');
}

function campaignZones(campaignMap) {
  const campaign = campaignMap?.campaign || {};
  const zones = campaign.zones || campaign.plan?.zones || campaign.canonical_plan?.zones || campaignMap?.zones;
  return Array.isArray(zones) ? zones : [];
}

function formatCanvasArea(areaSqMiles) {
  const value = Number(areaSqMiles);
  if (!Number.isFinite(value) || value <= 0) return '0 sq mi';
  const digits = value < 1 ? 2 : value < 100 ? 1 : 0;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: digits })} sq mi`;
}

function StepLabel({ number, children }) {
  return <div className="flex items-center gap-2"><span className="flex h-6 w-6 items-center justify-center rounded-full border border-purple-400/30 bg-purple-500/20 text-[10px] font-black text-purple-200">{number}</span><h3 className="text-xs font-black uppercase tracking-wide text-gray-300">{children}</h3></div>;
}

function Metric({ label, value }) {
  return <div className="rounded-xl border border-white/10 bg-black/30 p-2.5"><p className="text-[9px] font-bold uppercase text-gray-500">{label}</p><p className="mt-1 text-sm font-black text-white">{value}</p></div>;
}

// A Census block housing count is not a door list, so this never renders a lone
// confident number. Range first, expected and confidence underneath.
function OpportunityMetric({ summary, confidencePercent }) {
  const range = formatCanvasOpportunityRange(summary);
  return <div className="rounded-xl border border-white/10 bg-black/30 p-2.5">
    <p className="text-[9px] font-bold uppercase text-gray-500">Estimated homes</p>
    <p className="mt-1 text-sm font-black text-white">{range || 'Analyzing'}</p>
    {summary && <p className="mt-0.5 text-[9px] leading-tight text-gray-500">Expected {Math.round(summary.expected).toLocaleString()}{typeof confidencePercent === 'number' ? ` · ${confidencePercent}% confidence` : ''}</p>}
  </div>;
}

function PlanEvidenceReport({ workload, uncertainCount, releaseId, recommendation, onUseRecommendation }) {
  const miles = formatCanvasStreetMiles(workload?.eligible_street_miles);
  const hours = formatCanvasFieldHours(workload?.estimated_hours);
  const rows = [
    ['Eligible streets', miles || 'Pending geometry'],
    ['Est. field work', hours || 'Pending'],
    ['Needs review', `${uncertainCount} ${uncertainCount === 1 ? 'pocket' : 'pockets'}`],
    ['Evidence release', releaseId ? String(releaseId).slice(0, 18) : 'Unreleased'],
  ];
  return <div className="space-y-2">
    <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-white/10 bg-black/20 p-2 text-[9px]">
      {rows.map(([label, value]) => <span key={label} className="flex items-baseline justify-between gap-2 rounded-lg bg-white/[0.03] px-2 py-1.5"><span className="text-gray-500">{label}</span><span className="font-black text-gray-200">{value}</span></span>)}
    </div>
    {workload && workload.has_street_geometry === false && <p className="text-[9px] leading-relaxed text-gray-500">Field-work hours count door attempts only. Walking time appears once the evidence release carries street geometry.</p>}
    {recommendation && <button type="button" onClick={() => onUseRecommendation(recommendation.count)} className="w-full rounded-xl border border-purple-400/25 bg-purple-500/10 px-3 py-2 text-left text-[10px] leading-relaxed text-purple-100 hover:bg-purple-500/20">Suggested: <span className="font-black">{recommendation.count} areas</span> based on your usual {recommendation.basis === 'field_hours' ? 'field hours' : 'doors'} per area. Tap to use — you can still choose any number.</button>}
  </div>;
}

function TruthRow({ icon: Icon, tone = 'idle', title, detail }) {
  const colors = tone === 'good'
    ? 'border-green-500/20 bg-green-500/10 text-green-300'
    : tone === 'bad'
      ? 'border-red-500/20 bg-red-500/10 text-red-300'
      : tone === 'loading'
        ? 'border-blue-500/20 bg-blue-500/10 text-blue-300'
        : 'border-white/10 bg-white/[0.03] text-gray-400';
  return <div className={`flex items-start gap-3 rounded-xl border p-3 ${colors}`}><Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone === 'loading' ? 'animate-pulse' : ''}`} /><div><p className="text-xs font-bold">{title}</p><p className="mt-0.5 text-[10px] leading-relaxed opacity-75">{detail}</p></div></div>;
}

function roadTruth(status, error) {
  if (status === 'ready') return { tone: 'good', title: 'Residential evidence ready', detail: 'Canvas found street-connected residential work and protected street groups. Changing the area count now reuses this snapshot.' };
  if (status === 'loading') return { tone: 'loading', title: 'Finding residential work', detail: 'Your boundary is preserved while Canvas identifies homes, access, streets, cul-de-sacs, fields, and commercial land.' };
  if (status === 'empty') return { tone: 'bad', title: 'No residential street work found', detail: error?.message || 'Redraw around a neighborhood or review evidence coverage.' };
  if (status === 'invalid') return { tone: 'bad', title: 'Boundary needs changes', detail: error?.message || 'Canvas did not request street data for this boundary.' };
  if (status === 'unavailable') {
    const code = String(error?.code || '');
    const title = /SERVICE_BUSY/.test(code) ? 'Analysis service is busy' : /TIMEOUT/.test(code) ? 'Residential analysis timed out' : 'Residential evidence unavailable';
    return { tone: 'bad', title, detail: `${error?.message || 'Canvas could not load the signed residential evidence release.'} Your boundary is preserved; retry when ready.` };
  }
  return { tone: 'idle', title: 'Residential evidence loads after drawing', detail: 'Canvas never substitutes square grids or treats empty land as door-knocking work.' };
}

function NumberOfAreas({ value, disabled, onChange }) {
  const inputId = useId();
  return <div><label htmlFor={inputId} className="text-[10px] font-bold uppercase text-gray-400">Number of areas</label><Input id={inputId} disabled={disabled} type="number" min={1} max={250} step={1} value={value} onChange={(event) => onChange(Math.max(1, Math.min(250, Number(event.target.value) || 1)))} className="mt-1 h-11 border-white/10 bg-[#151520] text-lg font-black text-white" /></div>;
}

function IssueList({ title, issues }) {
  return <div className="rounded-xl border border-red-400/20 bg-red-400/10 p-3"><p className="mb-1 text-[10px] font-black uppercase text-red-300">{title}</p>{(issues || []).map((issue, index) => <p key={`${String(issue)}:${index}`} className="text-[11px] leading-relaxed text-gray-300">• {typeof issue === 'string' ? issue : issue?.message || issue?.code}</p>)}</div>;
}

function PlannerFailureNotice({ failure, onUseAreaCount, onRetry }) {
  if (!failure) return null;
  const details = failure.details || {};
  const code = String(failure.code || 'CANVAS_PLANNER_FAILED');
  const workUnitCount = Number(details.work_unit_count);
  const maximumWorkUnits = Number(details.maximum_work_unit_count);
  const segmentCount = Number(details.segment_count);
  const maximumSegments = Number(details.maximum_segment_count);
  const complexity = Number(details.interactive_complexity);
  const maximumComplexity = Number(details.maximum_interactive_complexity);
  const serializedBytes = Number(details.serialized_byte_count);
  const maximumSerializedBytes = Number(details.maximum_serialized_byte_count);
  const minimumAreas = Number(details.minimum_zone_count);
  const maximumAreas = Number(details.maximum_zone_count);
  const workGraphExceedsLimit = (Number.isFinite(workUnitCount) && Number.isFinite(maximumWorkUnits) && workUnitCount > maximumWorkUnits)
    || (Number.isFinite(segmentCount) && Number.isFinite(maximumSegments) && segmentCount > maximumSegments);
  const suggestedAreaCount = code === 'TOO_FEW_ZONES_FOR_COMPONENTS' && Number.isInteger(minimumAreas)
    ? minimumAreas
    : code === 'TOO_MANY_ZONES_FOR_WORK_UNITS' && Number.isInteger(maximumAreas)
      ? maximumAreas
      : null;
  const complexityDetails = [
    Number.isFinite(workUnitCount) && Number.isFinite(maximumWorkUnits) ? `Street units ${workUnitCount.toLocaleString()} / ${maximumWorkUnits.toLocaleString()}` : '',
    Number.isFinite(segmentCount) && Number.isFinite(maximumSegments) ? `Segments ${segmentCount.toLocaleString()} / ${maximumSegments.toLocaleString()}` : '',
    Number.isFinite(complexity) && Number.isFinite(maximumComplexity) ? `Area × unit check ${complexity.toLocaleString()} / ${maximumComplexity.toLocaleString()}` : '',
  ].filter(Boolean).join(' · ');
  const countDetail = code === 'CANVAS_PLAN_TOO_COMPLEX' && complexityDetails
    ? complexityDetails
    : code === 'CANVAS_DRAFT_TOO_LARGE' && Number.isFinite(serializedBytes) && Number.isFinite(maximumSerializedBytes)
      ? `Draft size ${(serializedBytes / 1_000_000).toFixed(1)} MB / ${(maximumSerializedBytes / 1_000_000).toFixed(1)} MB`
    : Number.isFinite(minimumAreas) && code === 'TOO_FEW_ZONES_FOR_COMPONENTS'
      ? `This boundary contains ${minimumAreas.toLocaleString()} disconnected street groups, so it needs at least that many areas.`
      : Number.isFinite(maximumAreas) && code === 'TOO_MANY_ZONES_FOR_WORK_UNITS'
        ? `This street graph can support at most ${maximumAreas.toLocaleString()} connected areas without splitting an atomic street unit.`
        : '';
  const guidance = code === 'CANVAS_PLANNER_TIMEOUT'
    ? 'The streets loaded, but subdivision exceeded the two-minute calculation limit. Retry once; if it repeats, divide the global boundary into smaller saved plans.'
    : code === 'TOO_MANY_DISCONNECTED_COMPONENTS'
      ? 'Redraw a smaller boundary around fewer connected street groups. Retrying or increasing the area count cannot exceed the 250-area campaign limit.'
    : code === 'CANVAS_DRAFT_TOO_LARGE'
      ? 'Reduce the drawn boundary. The complete street-ownership snapshot must fit inside the secure saved-plan limit before Canvas can send it later.'
    : code === 'CANVAS_PLAN_TOO_COMPLEX'
      ? workGraphExceedsLimit
        ? 'Reduce the drawn boundary. Changing only the area count will not reduce the underlying street graph.'
        : 'Use fewer areas or reduce the drawn boundary so the full connected split can be verified.'
      : 'Your boundary is preserved. Adjust the suggested count or retry after reviewing the message below.';
  const retryable = !new Set([
    'CANVAS_PLAN_TOO_COMPLEX',
    'CANVAS_DRAFT_TOO_LARGE',
    'TOO_MANY_DISCONNECTED_COMPONENTS',
    'TOO_FEW_ZONES_FOR_COMPONENTS',
    'TOO_MANY_ZONES_FOR_WORK_UNITS',
  ]).has(code);
  const showSuggestedCount = suggestedAreaCount >= 1 && suggestedAreaCount <= 250;
  return <div role="alert" className="rounded-xl border border-red-400/30 bg-red-500/[0.10] p-3"><div className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" /><div className="min-w-0"><p className="text-xs font-black text-red-100">Area preview could not be created</p><p className="mt-1 text-[11px] leading-relaxed text-red-50/90">{failure.message}</p>{countDetail && <p className="mt-1 text-[10px] leading-relaxed text-red-100/75">{countDetail}</p>}<p className="mt-1 text-[10px] leading-relaxed text-gray-400">{guidance}</p><p className="mt-2 font-mono text-[9px] text-red-200/60">{code}</p></div></div>{(showSuggestedCount || retryable) && <div className="mt-3 flex gap-2">{showSuggestedCount && <Button type="button" onClick={() => onUseAreaCount(suggestedAreaCount)} className="h-9 flex-1 bg-red-500/20 text-red-50 hover:bg-red-500/30">Use {suggestedAreaCount} areas</Button>}{retryable && <Button type="button" onClick={onRetry} className="h-9 flex-1 border border-white/10 bg-white/10 text-white"><RefreshCw className="h-3.5 w-3.5" /> Retry preview</Button>}</div>}</div>;
}

function PlanSummary({ plan, boundaryAreaSqMiles, staleReason, residentialAnalysis }) {
  const zones = Array.isArray(plan?.zones) ? plan.zones : [];
  const opportunities = zones.map((zone) => getCanvasZoneResidentialOpportunity(zone, residentialAnalysis)?.expected
    ?? Number(zone.opportunity_expected ?? zone.estimated_doors ?? 0));
  const totalOpportunities = opportunities.reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
  const deviation = getCanvasWorkloadDeviation(plan || {});
  const qa = plan?.qa || {};
  const safetyReady = !staleReason
    && qa.street_coverage_complete === true
    && qa.no_duplicate_work_units === true
    && qa.connected_zones === true
    && qa.atomic_work_units === true
    && qa.protected_units_intact === true;
  const range = opportunities.length ? `${Math.round(Math.min(...opportunities))}–${Math.round(Math.max(...opportunities))} homes` : 'Unavailable';
  return <div className="space-y-2 rounded-2xl border border-white/10 bg-white/[0.03] p-3"><div className="grid grid-cols-2 gap-2"><Metric label="Global boundary" value={formatCanvasArea(boundaryAreaSqMiles)} /><Metric label="Areas" value={zones.length} /><Metric label="Likely homes" value={Math.round(totalOpportunities).toLocaleString()} /><Metric label="Per-area range" value={range} /></div><div className={`rounded-xl border p-3 ${safetyReady ? 'border-green-400/20 bg-green-500/[0.08] text-green-100' : 'border-amber-400/20 bg-amber-500/[0.08] text-amber-100'}`}><p className="text-xs font-black">{safetyReady ? 'Territory checks passed' : staleReason || 'Territory checks need review'}</p><p className="mt-1 text-[10px] opacity-75">Connected residential work · exclusive ownership · protected cul-de-sacs {deviation.verified ? `· max workload deviation ${Math.round(deviation.value)}%` : ''}</p></div>{qa.warnings?.length > 0 && <details className="rounded-xl border border-white/10 bg-black/20"><summary className="cursor-pointer px-3 py-2 text-[10px] font-black text-gray-400">Planning notes ({qa.warnings.length})</summary><div className="space-y-1 border-t border-white/10 p-3">{qa.warnings.map((warning, index) => <p key={`${String(warning)}:${index}`} className="text-[10px] leading-relaxed text-amber-100">• {typeof warning === 'string' ? warning : warning?.message || warning?.code}</p>)}</div></details>}</div>;
}

function AreaPreviewList({ zones, selectedZoneNumber, setSelectedZoneNumber, compact, residentialAnalysis, showAssignees = false, membersById = new Map(), activeTeamMembers = [], disabled = false, onAssignment }) {
  const workloads = zones.map((zone) => getCanvasZoneResidentialOpportunity(zone, residentialAnalysis)?.expected
    ?? Number(zone.opportunity_expected ?? zone.estimated_doors ?? 0));
  const totalWorkload = workloads.reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
  return <div className={`grid gap-2 overflow-y-auto pr-1 ${compact ? 'max-h-52' : 'max-h-64'}`}>{zones.map((zone, index) => {
    const opportunity = Math.max(0, Number(workloads[index]) || 0);
    const share = totalWorkload > 0 ? opportunity / totalWorkload * 100 : 0;
    const selected = Number(selectedZoneNumber) === Number(zone.zone_number);
    const member = membersById.get(String(zone.assigned_team_member_id || ''));
    const color = zone.color || FALLBACK_COLORS[index % FALLBACK_COLORS.length];
    return <div key={zone.zone_id || zone.zone_number} className={`rounded-xl border p-3 ${selected ? 'border-purple-400 bg-purple-500/15' : 'border-white/10 bg-[#12121a]'}`}><button type="button" aria-pressed={selected} onClick={() => setSelectedZoneNumber(zone.zone_number)} className="flex w-full items-center gap-3 text-left"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-xs font-extrabold text-white" style={{ background: color }}>{zone.zone_number}</span><span className="min-w-0 flex-1"><span className="block text-sm font-bold text-white">Area {zone.zone_number}</span><span className="block truncate text-[10px] text-gray-400">About {Math.round(opportunity).toLocaleString()} homes · {share.toFixed(1)}% of workload{showAssignees ? ` · ${member?.name || member?.email || 'Unassigned'}` : ''}</span></span></button>{showAssignees && selected && <Select disabled={disabled} value={String(zone.assigned_team_member_id || 'unassigned')} onValueChange={(value) => onAssignment?.(zone.zone_number, value === 'unassigned' ? '' : value)}><SelectTrigger className="mt-3 h-9 border-white/10 bg-black/30 text-xs text-white"><SelectValue /></SelectTrigger><SelectContent className="z-[4000] border-white/10 bg-black text-white"><SelectItem value="unassigned">Unassigned</SelectItem>{activeTeamMembers.map((rep) => <SelectItem key={rep.id} value={String(rep.id)}>{rep.name || rep.email}</SelectItem>)}</SelectContent></Select>}</div>;
  })}</div>;
}

function AssignmentPool({ members, selectedIds, disabled, toggle, replaceSelection }) {
  const [query, setQuery] = useState('');
  const selectedSet = useMemo(() => new Set(selectedIds.map(String)), [selectedIds]);
  const normalizedQuery = query.trim().toLowerCase();
  const visible = members.filter((member) => !normalizedQuery || `${member.name || ''} ${member.email || ''}`.toLowerCase().includes(normalizedQuery));
  const visibleIds = visible.map((member) => String(member.id));
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedSet.has(id));
  const toggleVisible = () => replaceSelection(allVisibleSelected ? selectedIds.filter((id) => !visibleIds.includes(String(id))) : [...new Set([...selectedIds.map(String), ...visibleIds])]);
  return <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3"><div><p className="text-xs font-black text-white">Choose an assignment pool</p><p className="mt-1 text-[10px] leading-relaxed text-gray-500">Select the reps you want to use now. One rep may hold more than one area.</p></div>{members.length > 8 && <div className="relative mt-3"><Search className="pointer-events-none absolute left-3 top-2.5 h-3.5 w-3.5 text-gray-500" /><Input aria-label="Search active reps" disabled={disabled} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search reps" className="h-9 border-white/10 bg-black/30 pl-9 text-xs text-white" /></div>}<div className="mt-2 flex items-center justify-between"><p className="text-[10px] text-gray-500">{selectedIds.length} selected · {members.length} eligible</p><button type="button" disabled={disabled || !visibleIds.length} onClick={toggleVisible} className="text-[10px] font-black text-purple-300 disabled:text-gray-600">{allVisibleSelected ? 'Clear shown' : 'Select shown'}</button></div><div className="mt-2 max-h-44 space-y-1.5 overflow-y-auto">{visible.map((member) => { const selected = selectedSet.has(String(member.id)); return <button type="button" aria-pressed={selected} disabled={disabled} key={member.id} onClick={() => toggle(member.id)} className={`flex w-full items-center gap-3 rounded-xl border p-2.5 text-left ${selected ? 'border-purple-400/60 bg-purple-500/15' : 'border-white/10 bg-black/20'}`}><span className={`flex h-4 w-4 items-center justify-center rounded border ${selected ? 'border-purple-300 bg-purple-500' : 'border-white/20'}`}>{selected && <CheckCircle2 className="h-3 w-3" />}</span><span className="truncate text-xs font-bold text-white">{member.name || member.email}</span></button>; })}{!members.length && <p className="py-2 text-xs text-amber-300">No active linked reps are available.</p>}</div></div>;
}

function CampaignProgress({ map, loading, error, onRefresh }) {
  const counts = map?.outcome_counts || {};
  const total = Object.values(counts).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const zoneCounts = map?.zone_counts || {};
  return <section className="space-y-3 rounded-2xl border border-green-400/20 bg-green-500/[0.06] p-3"><div className="flex items-center justify-between"><div><p className="flex items-center gap-2 text-xs font-black text-green-200"><Activity className="h-4 w-4" /> Shared campaign map</p><p className="text-[10px] text-gray-400">{total} server-synced house decisions</p></div><Button disabled={loading} onClick={onRefresh} size="icon" className="h-8 w-8 bg-white/10 text-white">{loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}</Button></div>{error && <p className="text-[10px] text-amber-300">Refresh failed; the last verified map remains visible. {error}</p>}<div className="flex flex-wrap gap-1.5">{Object.entries(counts).map(([outcome, count]) => <span key={outcome} className="flex items-center rounded-full border border-white/10 bg-black/40 px-2 py-1 text-[9px] text-white"><span className="mr-1 h-2 w-2 rounded-full" style={{ background: getCanvasOutcome(outcome).color }} />{getCanvasOutcome(outcome).label} {count}</span>)}{!total && <p className="text-[11px] text-gray-500">No synced rep decisions yet.</p>}</div><div className="grid grid-cols-2 gap-1.5 border-t border-white/10 pt-2">{campaignZones(map).map((zone) => <div key={zone.zone_id || zone.zone_number} className="flex items-center justify-between rounded-lg bg-black/30 px-2.5 py-2 text-[10px]"><span className="truncate text-gray-300">Area {zone.zone_number}</span><strong className="ml-2 text-white">{canvasZoneLoggedCount(zoneCounts[zone.zone_id] ?? zoneCounts[zone.zone_number])}</strong></div>)}</div></section>;
}

function ClassificationReview({
  unresolvedCount,
  selectedUnit,
  role,
  setRole,
  opportunityCount,
  setOpportunityCount,
  reason,
  setReason,
  saving,
  disabled,
  onSave,
}) {
  if (!unresolvedCount) return null;
  const streetNames = selectedUnit?.streetNames || selectedUnit?.street_names || [];
  const streetLabel = (Array.isArray(streetNames) ? streetNames.filter(Boolean).join(' / ') : String(streetNames || '')).trim()
    || `Street ${String(selectedUnit?.id || '').slice(-8)}`;
  const roles = [
    { value: 'knock', label: 'Residential homes', detail: 'Count as knockable work' },
    { value: 'transit_only', label: 'Travel only', detail: 'Keep for area connectivity' },
    { value: 'excluded', label: 'Exclude', detail: 'No rep work here' },
  ];

  return <section className="space-y-3 rounded-2xl border border-amber-400/30 bg-amber-500/[0.08] p-3" aria-label="Review uncertain residential evidence">
    <div className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" /><div><p className="text-xs font-black text-amber-100">{unresolvedCount} amber street{unresolvedCount === 1 ? '' : 's'} need review</p><p className="mt-1 text-[10px] leading-relaxed text-amber-50/70">You can preview and save now. Before sending, tap each amber street on the map and tell Canvas whether it contains homes.</p></div></div>
    {!selectedUnit ? <p className="rounded-xl border border-dashed border-amber-200/20 bg-black/20 p-3 text-center text-[11px] font-bold text-amber-100">Tap an amber street on the map to review it.</p> : <div className="space-y-3 rounded-xl border border-amber-200/20 bg-black/25 p-3">
      <div><p className="text-[9px] font-black uppercase text-amber-300">Selected street</p><p className="mt-1 truncate text-sm font-black text-white">{streetLabel}</p></div>
      <div className="grid gap-1.5">{roles.map((option) => <button key={option.value} type="button" aria-pressed={role === option.value} disabled={disabled || saving} onClick={() => setRole(option.value)} className={`rounded-xl border px-3 py-2 text-left ${role === option.value ? 'border-amber-300/60 bg-amber-400/15' : 'border-white/10 bg-white/[0.03]'}`}><span className="block text-[11px] font-black text-white">{option.label}</span><span className="block text-[9px] text-gray-400">{option.detail}</span></button>)}</div>
      {role === 'knock' && <div><label htmlFor="canvas-reviewed-home-count" className="text-[9px] font-black uppercase text-gray-400">Likely knockable homes</label><Input id="canvas-reviewed-home-count" disabled={disabled || saving} type="number" min={1} max={10000} step={1} inputMode="numeric" value={opportunityCount} onChange={(event) => setOpportunityCount(event.target.value)} placeholder="Example: 24" className="mt-1 h-10 border-white/10 bg-black/30 text-white" /></div>}
      <div><label htmlFor="canvas-review-reason" className="text-[9px] font-black uppercase text-gray-400">Why this is correct</label><Input id="canvas-review-reason" disabled={disabled || saving} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Example: Single-family homes visible on both sides" className="mt-1 h-10 border-white/10 bg-black/30 text-white" /></div>
      <Button type="button" disabled={disabled || saving} onClick={onSave} className="h-10 w-full bg-amber-500 font-black text-black hover:bg-amber-400">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Save street review</Button>
    </div>}
  </section>;
}

export default function CanvasPlannerWorkspace(props) {
  const {
    sessionName,
    changeSessionName,
    polygon,
    hasDrawnArea,
    onDraw,
    onClearPolygon,
    onClose,
    selectedTeamMemberIds,
    toggleTeamMember,
    replaceTeamMemberSelection,
    activeTeamMembers,
    teamMembersReady,
    requestedAreaCount,
    changeRequestedAreaCount,
    // Organisation sizing targets. Absent these there is nothing honest to
    // recommend, so no suggestion is rendered rather than a made-up one.
    targetFieldHoursPerArea = 0,
    targetDoorsPerArea = 0,
    requestedZoneCount,
    roadFetchStatus,
    roadFetchError,
    roadFetchProgress,
    refreshRoadData,
    residentialAnalysis,
    selectedClassificationUnit,
    unresolvedClassificationCount,
    classificationRole,
    setClassificationRole,
    classificationOpportunityCount,
    setClassificationOpportunityCount,
    classificationReason,
    setClassificationReason,
    classificationSaving,
    applyClassificationReview,
    serverAnalysisJobId,
    cancelResidentialAnalysis,
    cancellingServerAnalysis,
    generationBlockers,
    generatePlan,
    generating,
    plan,
    planStaleReason,
    planGenerationError,
    zones,
    assignedZoneCount,
    selectedZoneNumber,
    setSelectedZoneNumber,
    autoAssign,
    updateZoneAssignment,
    membersById,
    persistDraft,
    deployPlan,
    retryRepPackagePublication,
    closeCampaign,
    saving,
    deploying,
    packagePublishing,
    packagePublicationStatus,
    packagePublicationIssue,
    closing,
    sendable,
    crewAssignmentStatus,
    workloadDeviationUnavailable,
    workloadExceptionNeedsAcceptance,
    workloadExceptionAccepted,
    changeWorkloadExceptionAcceptance,
    planTooComplex,
    planComplexityStatus,
    serverSession,
    deployed,
    activeDeployment,
    closedDeployment,
    mutationsLocked,
    draftDirty,
    startAnotherArea,
    savedDrafts,
    selectedDraft,
    setSelectedDraftId,
    resumeDraft,
    resumingDraft,
    otherActiveCampaigns,
    selectedIndexedCampaign,
    setSelectedIndexedCampaignId,
    campaignIndexLoading,
    campaignIndexError,
    campaignSigningUnavailable,
    refreshCampaignIndex,
    quarantinableCampaignCount,
    quarantineRejectedCampaigns,
    quarantiningCampaigns,
    liveCampaignMap,
    liveMapLoading,
    liveMapError,
    loadCampaignMap,
    refreshTeamRoster,
    teamRosterRefreshing,
    canRefreshTeamRoster,
    workspaceView,
    changeWorkspaceView,
    compact = false,
  } = props;
  const nameId = useId();
  const buildView = workspaceView !== 'areas';
  const globalAreaSqMiles = getCanvasBoundaryAreaSqMiles(polygon);
  const opportunitySummary = getCanvasResidentialOpportunitySummary(residentialAnalysis);
  const roleCounts = getCanvasResidentialRoleCounts(residentialAnalysis);
  const planWorkload = useMemo(
    () => (residentialAnalysis ? summarizeCanvasPlanWorkload(residentialAnalysis) : null),
    [residentialAnalysis],
  );
  // A suggestion, never a constraint. Absent an organisation target there is
  // nothing honest to recommend, so nothing is shown.
  const areaCountRecommendation = useMemo(() => (planWorkload ? recommendCanvasAreaCount(planWorkload, {
    target_hours_per_area: targetFieldHoursPerArea,
    target_doors_per_area: targetDoorsPerArea,
    expected_opportunities: opportunitySummary?.expected ?? 0,
  }) : null), [planWorkload, targetFieldHoursPerArea, targetDoorsPerArea, opportunitySummary]);
  const networkTruth = roadTruth(roadFetchStatus, roadFetchError);
  const showFooter = buildView || Boolean(plan && !deployed);
  const assignmentDisabled = mutationsLocked || !plan;

  return <div className="relative flex h-full flex-col text-white">
    <div className="shrink-0 border-b border-white/10 p-4"><div className="flex items-start justify-between gap-3"><div><h2 className="flex items-center gap-2 font-extrabold tracking-wide text-purple-300"><MapIcon className="h-5 w-5" /> CANVAS</h2><p className="mt-1 text-[10px] text-gray-500">Plan street-aligned areas first. Assign people when you are ready.</p></div><button type="button" disabled={mutationsLocked && !deployed} onClick={onClose} className="rounded-full p-2 hover:bg-white/10 disabled:opacity-40" aria-label="Close Canvas"><X className="h-5 w-5 text-gray-300" /></button></div><div className="mt-3 grid grid-cols-2 gap-1 rounded-xl border border-white/10 bg-black/30 p-1"><button type="button" aria-pressed={buildView} onClick={() => { if (!buildView && plan) startAnotherArea(); else changeWorkspaceView('new_area'); }} className={`rounded-lg px-3 py-2 text-[10px] font-black ${buildView ? 'bg-purple-500 text-white' : 'text-gray-400 hover:text-white'}`}>NEW AREA</button><button type="button" aria-pressed={!buildView} onClick={() => changeWorkspaceView('areas')} className={`rounded-lg px-3 py-2 text-[10px] font-black ${!buildView ? 'bg-purple-500 text-white' : 'text-gray-400 hover:text-white'}`}>AREAS & ASSIGNMENTS</button></div></div>

    <div className={`min-h-0 flex-1 space-y-4 overflow-y-auto p-4 ${showFooter ? 'pb-36' : 'pb-6'}`}>
      {buildView ? <>
        <section className="space-y-3"><StepLabel number="1">Draw the work area</StepLabel><div><label htmlFor={nameId} className="text-[10px] font-bold uppercase text-gray-500">Area plan name · optional</label><Input id={nameId} maxLength={200} disabled={mutationsLocked} value={sessionName} onChange={(event) => changeSessionName(event.target.value)} className="mt-1 h-11 border-white/10 bg-[#151520] font-bold text-white" /></div><div className="grid grid-cols-2 gap-2"><Button disabled={mutationsLocked} onClick={onDraw} className="h-10 bg-purple-600 text-white hover:bg-purple-500"><Pencil className="h-4 w-4" /> {hasDrawnArea ? 'Redraw area' : 'Draw area'}</Button><Button disabled={!hasDrawnArea || mutationsLocked} onClick={onClearPolygon} className="h-10 border border-white/10 bg-white/10 text-white">Clear</Button></div><TruthRow icon={MapPin} tone={polygon.length ? 'good' : 'idle'} title={polygon.length ? 'Work boundary ready' : 'Draw one freehand boundary'} detail={polygon.length ? `${formatCanvasArea(globalAreaSqMiles)} selected. This boundary—not a house list—is the source of truth.` : 'Outline the entire cold area your team may work.'} /><TruthRow icon={Network} {...networkTruth} />{roadFetchStatus === 'loading' && <div className="rounded-xl border border-blue-400/20 bg-blue-500/[0.07] p-3"><div className="flex items-center justify-between text-[10px] font-black text-blue-100"><span>Residential evidence analysis</span><span>{Number(roadFetchProgress?.percent || 0).toFixed(0)}%</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/30"><div className="h-full rounded-full bg-blue-400 transition-[width]" style={{ width: `${Math.max(2, Math.min(100, Number(roadFetchProgress?.percent || 0)))}%` }} /></div><p className="mt-2 text-[10px] leading-relaxed text-blue-100/70">Canvas will preview only after the signed evidence snapshot is complete. Partial tiles never become territories.</p>{serverAnalysisJobId && <Button disabled={cancellingServerAnalysis} onClick={() => cancelResidentialAnalysis()} className="mt-2 h-8 w-full border border-white/10 bg-white/5 text-white">{cancellingServerAnalysis ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Cancel analysis</Button>}</div>}{['unavailable', 'empty'].includes(roadFetchStatus) && <Button disabled={mutationsLocked} onClick={refreshRoadData} className="h-10 w-full border border-white/10 bg-white/5 text-white"><RefreshCw className="h-4 w-4" /> Retry residential analysis</Button>}</section>
        <section className="space-y-3"><StepLabel number="2">Choose the number of areas</StepLabel><p className="text-[11px] leading-relaxed text-gray-400">This only controls how many connected work areas Canvas creates. Assign reps later in Areas & Assignments.</p><div className="space-y-2 rounded-2xl border border-white/10 bg-white/[0.03] p-3"><NumberOfAreas value={requestedAreaCount} disabled={mutationsLocked} onChange={changeRequestedAreaCount} /><p className="text-[10px] leading-relaxed text-gray-500">After the first preview, this updates the colored split automatically without downloading the evidence again.</p></div><div className="grid grid-cols-2 gap-2"><Metric label="Selected boundary" value={globalAreaSqMiles > 0 ? formatCanvasArea(globalAreaSqMiles) : 'Draw first'} /><OpportunityMetric summary={opportunitySummary} confidencePercent={planWorkload?.confidence_percent ?? null} /></div>{residentialAnalysis && <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-white/10 bg-black/20 p-2 text-[9px]"><span className="rounded-lg bg-green-500/10 px-2 py-1.5 text-green-200">Residential streets {roleCounts.knock}</span><span className="rounded-lg bg-amber-500/10 px-2 py-1.5 text-amber-200">Needs review {roleCounts.uncertain}</span><span className="rounded-lg bg-slate-500/10 px-2 py-1.5 text-slate-300">Transit {roleCounts.transit_only}</span><span className="rounded-lg bg-slate-700/30 px-2 py-1.5 text-slate-400">Excluded {roleCounts.excluded}</span></div>}{residentialAnalysis && <PlanEvidenceReport workload={planWorkload} uncertainCount={roleCounts.uncertain} releaseId={residentialAnalysis?.release_id} recommendation={areaCountRecommendation} onUseRecommendation={changeRequestedAreaCount} />}<ClassificationReview unresolvedCount={unresolvedClassificationCount} selectedUnit={selectedClassificationUnit} role={classificationRole} setRole={setClassificationRole} opportunityCount={classificationOpportunityCount} setOpportunityCount={setClassificationOpportunityCount} reason={classificationReason} setReason={setClassificationReason} saving={classificationSaving} disabled={mutationsLocked} onSave={applyClassificationReview} /><p className="rounded-xl border border-blue-400/15 bg-blue-500/[0.07] p-3 text-[10px] leading-relaxed text-blue-100">Canvas balances residential opportunity—not square miles—keeps areas connected, protects cul-de-sacs, and gives fields or commercial land zero knocking workload.</p>{requestedZoneCount >= 100 && <p className="rounded-xl border border-blue-400/20 bg-blue-500/10 p-3 text-[10px] leading-relaxed text-blue-100">Large subdivision plan: Canvas stops safely if the verified street topology cannot support this many connected areas.</p>}{generationBlockers.length > 0 && <IssueList title="Before preview" issues={generationBlockers} />}<Button disabled={mutationsLocked || generationBlockers.length > 0} onClick={() => generatePlan()} className="h-12 w-full bg-purple-600 font-black text-white hover:bg-purple-500 disabled:bg-gray-800 disabled:text-gray-500">{generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} {generating ? 'Balancing residential work...' : plan ? 'Update area preview' : `Preview ${requestedZoneCount} ${requestedZoneCount === 1 ? 'area' : 'areas'}`}</Button>{generating && <p className="text-center text-[10px] leading-relaxed text-blue-200">Canvas is verifying connected ownership and protected street groups.</p>}<PlannerFailureNotice failure={planGenerationError} onUseAreaCount={changeRequestedAreaCount} onRetry={() => generatePlan()} /></section>
        {zones.length > 0 && <section className="space-y-3"><StepLabel number="3">Review and save</StepLabel><PlanSummary plan={plan} boundaryAreaSqMiles={globalAreaSqMiles} staleReason={planStaleReason} residentialAnalysis={residentialAnalysis} />{planTooComplex && <IssueList title="Plan is too complex to save" issues={[planComplexityStatus.message]} />}<AreaPreviewList zones={zones} selectedZoneNumber={selectedZoneNumber} setSelectedZoneNumber={setSelectedZoneNumber} compact={compact} residentialAnalysis={residentialAnalysis} /><p className="text-[11px] leading-relaxed text-gray-500">Save this residential street split as a reusable area plan. No rep is assigned and nothing is sent from the builder.</p></section>}
      </> : <>
        <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-3"><div className="flex items-center justify-between gap-3"><div><p className="text-xs font-black text-white">Canvas Areas</p><p className="mt-1 text-[10px] leading-relaxed text-gray-500">Open a saved plan, assign any number of its areas, save partial progress, and send only when every area is covered.</p></div><Button disabled={campaignIndexLoading} onClick={refreshCampaignIndex} size="icon" className="h-8 w-8 shrink-0 bg-white/10 text-white">{campaignIndexLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}</Button></div></section>
        {campaignSigningUnavailable && <section className="rounded-2xl border border-amber-400/25 bg-amber-500/[0.08] p-3"><div className="flex items-start gap-2"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" /><div><p className="text-xs font-black text-amber-100">Sending is temporarily disabled</p><p className="mt-1 text-[11px] leading-relaxed text-amber-100/80">Area planning and saving still work. An administrator must configure Canvas lifecycle signing before assignments can be activated.</p></div></div></section>}
        {campaignIndexError && !campaignSigningUnavailable && <section className="rounded-2xl border border-red-400/25 bg-red-500/[0.08] p-3"><p className="text-xs font-black text-red-100">Some campaign records failed verification</p><p className="mt-1 text-[11px] leading-relaxed text-red-100/80">{campaignIndexError} They remain fail-closed and cannot be trusted or sent.</p>{quarantinableCampaignCount > 0 && <Button disabled={quarantiningCampaigns} onClick={quarantineRejectedCampaigns} className="mt-3 h-10 w-full border border-red-300/20 bg-red-500/15 text-red-50 hover:bg-red-500/25">{quarantiningCampaigns ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Quarantine {quarantinableCampaignCount} unsigned legacy record{quarantinableCampaignCount === 1 ? '' : 's'}</Button>}<p className="mt-2 text-[9px] leading-relaxed text-red-100/60">Unsigned legacy records can be quarantined without deletion. Signed records remain hidden for manual recovery so a rotated signing key can never remove a previously valid campaign.</p></section>}
        <section className="space-y-2 rounded-2xl border border-amber-400/20 bg-amber-500/[0.06] p-3"><div><p className="text-xs font-black text-amber-100">Saved area plans ({savedDrafts.length})</p><p className="mt-0.5 text-[10px] text-gray-500">Plans can stay unassigned for as long as needed.</p></div>{savedDrafts.length ? <><Select value={campaignId(selectedDraft)} onValueChange={setSelectedDraftId}><SelectTrigger className="h-10 border-white/10 bg-black/30 text-white"><SelectValue /></SelectTrigger><SelectContent className="z-[4000] border-white/10 bg-black text-white">{savedDrafts.map((draft) => <SelectItem key={campaignId(draft)} value={campaignId(draft)}>{draft.session_name} · {draft.zone_count} areas · v{draft.version}</SelectItem>)}</SelectContent></Select><Button disabled={!selectedDraft || resumingDraft || !teamMembersReady} onClick={() => resumeDraft(selectedDraft)} className="h-10 w-full border border-amber-300/20 bg-amber-500/15 text-amber-50 hover:bg-amber-500/25">{resumingDraft || !teamMembersReady ? <Loader2 className="h-4 w-4 animate-spin" /> : <MapIcon className="h-4 w-4" />} {teamMembersReady ? 'Open area plan' : 'Loading team…'}</Button></> : <div className="rounded-xl border border-dashed border-white/10 p-4 text-center"><p className="text-[11px] text-gray-400">No saved area plans yet.</p><button type="button" onClick={() => changeWorkspaceView('new_area')} className="mt-2 text-[10px] font-black text-purple-300">Create the first area plan</button></div>}</section>
        {(activeDeployment || closedDeployment) && <div className={`rounded-2xl border p-3 ${activeDeployment && packagePublicationStatus === 'ready' ? 'border-green-500/30 bg-green-500/10' : 'border-white/15 bg-white/5'}`}><p className={`text-sm font-bold ${activeDeployment && packagePublicationStatus === 'ready' ? 'text-green-300' : 'text-white'}`}>{activeDeployment ? packagePublicationStatus === 'ready' ? 'Campaign is live' : 'Campaign is waiting for rep maps' : `Campaign ${serverSession.status}`}</p><p className="text-[11px] text-gray-400">{activeDeployment ? packagePublicationStatus === 'ready' ? `${serverSession.delivery_count || assignedZoneCount} assigned areas · house decisions sync onto the shared map` : 'The reviewed deployment is saved, but reps do not receive it until every signed offline package is ready.' : 'Its areas are no longer active on rep maps.'}</p>{activeDeployment && <div className={`mt-3 rounded-xl border p-3 ${packagePublicationStatus === 'ready' ? 'border-green-300/20 bg-green-400/10' : packagePublicationStatus === 'error' ? 'border-red-300/25 bg-red-500/10' : 'border-white/10 bg-black/20'}`}><p className="text-[10px] font-black uppercase text-gray-300">Offline rep maps</p><p className="mt-1 text-[10px] leading-relaxed text-gray-400">{packagePublicationStatus === 'ready' ? 'Signed territory, street, pin, and do-not-knock packages are ready.' : packagePublicationStatus === 'error' ? packagePublicationIssue : 'Publish or refresh the signed packages reps use in weak-signal areas.'}</p><Button disabled={packagePublishing || closing} onClick={() => retryRepPackagePublication(serverSession)} className="mt-2 h-9 w-full border border-white/10 bg-white/10 text-white">{packagePublishing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />} {packagePublicationStatus === 'ready' ? 'Refresh offline rep maps' : 'Publish offline rep maps'}</Button></div>}{activeDeployment && <div className="mt-3 grid grid-cols-3 gap-2"><Button disabled={liveMapLoading} onClick={() => loadCampaignMap(serverSession)} className="h-9 border border-purple-400/25 bg-purple-500/20 text-purple-100"><Eye className="h-4 w-4" /> Map</Button><Button disabled={closing || packagePublishing} onClick={() => closeCampaign('complete')} className="h-9 border border-green-400/25 bg-green-500/15 text-green-100"><CheckCircle2 className="h-4 w-4" /> Done</Button><Button disabled={closing || packagePublishing} onClick={() => closeCampaign('recall')} className="h-9 border border-red-400/25 bg-red-500/15 text-red-100"><AlertTriangle className="h-4 w-4" /> Recall</Button></div>}<Button onClick={startAnotherArea} className="mt-2 h-10 w-full border border-white/10 bg-white/10 text-white"><Pencil className="h-4 w-4" /> Create another area plan</Button></div>}
        {otherActiveCampaigns.length > 0 && <section className="space-y-2 rounded-2xl border border-purple-400/20 bg-purple-500/[0.06] p-3"><p className="text-xs font-black text-purple-200">Other active campaigns ({otherActiveCampaigns.length})</p><Select value={campaignId(selectedIndexedCampaign)} onValueChange={setSelectedIndexedCampaignId}><SelectTrigger className="h-10 border-white/10 bg-black/30 text-white"><SelectValue /></SelectTrigger><SelectContent className="z-[4000] border-white/10 bg-black text-white">{otherActiveCampaigns.map((campaign) => <SelectItem key={campaignId(campaign)} value={campaignId(campaign)}>{campaign.session_name} · {campaign.zone_count} areas</SelectItem>)}</SelectContent></Select>{selectedIndexedCampaign && <div className="grid grid-cols-2 gap-2"><Button disabled={liveMapLoading} onClick={() => loadCampaignMap(selectedIndexedCampaign)} className="h-9 border border-purple-400/25 bg-purple-500/20 text-purple-100"><Eye className="h-4 w-4" /> Map</Button><Button disabled={packagePublishing} onClick={() => retryRepPackagePublication(selectedIndexedCampaign)} className="h-9 border border-blue-400/25 bg-blue-500/15 text-blue-100"><ShieldCheck className="h-4 w-4" /> Offline maps</Button><Button disabled={closing || packagePublishing} onClick={() => closeCampaign('complete', selectedIndexedCampaign)} className="h-9 border border-green-400/25 bg-green-500/15 text-green-100"><CheckCircle2 className="h-4 w-4" /> Done</Button><Button disabled={closing || packagePublishing} onClick={() => closeCampaign('recall', selectedIndexedCampaign)} className="h-9 border border-red-400/25 bg-red-500/15 text-red-100"><AlertTriangle className="h-4 w-4" /> Recall</Button></div>}</section>}
        {liveCampaignMap && <CampaignProgress map={liveCampaignMap} loading={liveMapLoading} error={liveMapError} onRefresh={() => loadCampaignMap(liveCampaignMap.campaign, { progressOnly: true })} />}
        {plan && !deployed && <section className="space-y-3"><div><p className="text-xs font-black text-white">Assign this area plan</p><p className="mt-1 text-[10px] leading-relaxed text-gray-500">Assignments do not change the street split. Partial assignments can be saved.</p></div><PlanSummary plan={plan} boundaryAreaSqMiles={globalAreaSqMiles} staleReason={planStaleReason} />{getCanvasWorkloadDeviation(plan).verified && getCanvasWorkloadDeviation(plan).value > 25 && <button type="button" role="checkbox" aria-checked={workloadExceptionAccepted} disabled={assignmentDisabled} onClick={() => changeWorkloadExceptionAcceptance(!workloadExceptionAccepted)} className={`flex w-full items-start gap-2 rounded-xl border p-3 text-left text-[10px] ${workloadExceptionAccepted ? 'border-amber-300/50 bg-amber-500/15 text-amber-50' : 'border-amber-400/20 bg-amber-500/[0.07] text-amber-100'}`}><span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${workloadExceptionAccepted ? 'border-amber-200 bg-amber-400 text-black' : 'border-amber-200/40'}`}>{workloadExceptionAccepted && <CheckCircle2 className="h-3 w-3" />}</span><span>I reviewed and accept this uneven split. Canvas kept natural street units intact instead of cutting a cul-de-sac.</span></button>}<AssignmentPool members={activeTeamMembers} selectedIds={selectedTeamMemberIds} disabled={assignmentDisabled} toggle={toggleTeamMember} replaceSelection={replaceTeamMemberSelection} /><Button disabled={assignmentDisabled || !selectedTeamMemberIds.length || selectedTeamMemberIds.length > zones.length} onClick={autoAssign} className="h-10 w-full bg-purple-600 text-white"><Wand2 className="h-4 w-4" /> Auto-assign {zones.length} areas across {selectedTeamMemberIds.length || 0} reps</Button>{!activeTeamMembers.length && <div className="rounded-xl border border-amber-400/20 bg-amber-500/[0.07] p-3"><p className="text-xs font-black text-amber-100">No eligible reps yet</p><p className="mt-1 text-[10px] leading-relaxed text-gray-300">The area plan is safe to keep unassigned. Add or activate reps when you are ready.</p><div className="mt-2 grid grid-cols-2 gap-2"><Button asChild className="h-9 border border-amber-300/20 bg-amber-500/15 text-amber-50"><Link to={createPageUrl('AdminTeam')} target="_blank" rel="noopener noreferrer"><Users className="h-4 w-4" /> Manage reps</Link></Button>{canRefreshTeamRoster && <Button disabled={teamRosterRefreshing} onClick={refreshTeamRoster} className="h-9 border border-white/10 bg-white/10 text-white">{teamRosterRefreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Refresh</Button>}</div></div>}<AreaPreviewList zones={zones} selectedZoneNumber={selectedZoneNumber} setSelectedZoneNumber={setSelectedZoneNumber} compact={compact} showAssignees membersById={membersById} activeTeamMembers={activeTeamMembers} disabled={assignmentDisabled} onAssignment={updateZoneAssignment} /></section>}
      </>}
    </div>

    {showFooter && <div className="absolute bottom-0 left-0 right-0 border-t border-white/10 bg-[#09090f] p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">{buildView ? <><div className="mb-2 flex items-center justify-between text-[10px] text-gray-500"><span>{zones.length ? `${zones.length} areas previewed` : planGenerationError ? 'Preview failed — review above' : generating ? 'Building area preview…' : 'No area preview yet'}</span><span>{saving ? 'Saving…' : serverSession?.session_id ? (draftDirty ? 'Unsaved changes' : 'Saved') : 'Not saved'}</span></div><Button disabled={!plan || Boolean(planStaleReason) || mutationsLocked || planTooComplex} onClick={() => persistDraft()} className="h-12 w-full bg-purple-600 font-extrabold text-white hover:bg-purple-500 disabled:bg-gray-800 disabled:text-gray-500">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save area plan</Button></> : <><div className="mb-2 flex items-center justify-between text-[10px] text-gray-500"><span>{assignedZoneCount}/{zones.length} areas assigned</span><span>{saving ? 'Saving…' : draftDirty ? 'Unsaved changes' : 'Saved'}</span></div><div className="flex gap-2"><Button disabled={!plan || mutationsLocked || planTooComplex} onClick={() => persistDraft()} className="h-12 border border-white/10 bg-white/10 px-4 text-white"><Save className="h-4 w-4" /> Save</Button><Button disabled={!sendable || mutationsLocked} onClick={deployPlan} className="h-12 flex-1 bg-purple-600 font-extrabold text-white hover:bg-purple-500 disabled:bg-gray-800 disabled:text-gray-500">{deploying || closing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />} Send assigned areas</Button></div>{planTooComplex ? <p className="mt-2 text-[10px] text-amber-300">{planComplexityStatus.message}</p> : workloadDeviationUnavailable ? <p className="mt-2 text-[10px] text-amber-300">Workload balance could not be verified. Regenerate before sending.</p> : workloadExceptionNeedsAcceptance ? <p className="mt-2 text-[10px] text-amber-300">Review and accept the workload exception before sending.</p> : !crewAssignmentStatus.valid && <p className="mt-2 text-[10px] text-amber-300">{crewAssignmentStatus.message}</p>}</>}</div>}
  </div>;
}
