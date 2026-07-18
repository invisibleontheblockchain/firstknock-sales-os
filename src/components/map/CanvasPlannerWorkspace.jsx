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
import { canvasZoneLoggedCount, formatCanvasDistance, getCanvasOutcome } from '@/components/canvas/canvasOutcomeUtils';
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
  if (status === 'ready') return { tone: 'good', title: 'Street network ready', detail: 'Canvas can divide connected street work while keeping protected cul-de-sacs whole.' };
  if (status === 'loading') return { tone: 'loading', title: 'Reading streets', detail: 'Your boundary is saved while Canvas loads the road network.' };
  if (status === 'empty') return { tone: 'bad', title: 'No eligible streets found', detail: error?.message || 'Redraw around a road-connected area.' };
  if (status === 'invalid') return { tone: 'bad', title: 'Boundary needs changes', detail: error?.message || 'Canvas did not request street data for this boundary.' };
  if (status === 'unavailable') {
    const code = String(error?.code || '');
    const title = /RATE_LIMITED|SERVICE_BUSY/.test(code) ? 'Street service is busy' : /TIMEOUT/.test(code) ? 'Street request timed out' : 'Street service unavailable';
    return { tone: 'bad', title, detail: `${error?.message || 'Canvas could not reach a street provider.'} Your boundary is preserved; retry when ready.` };
  }
  return { tone: 'idle', title: 'Streets load after drawing', detail: 'Canvas never substitutes square grids for missing street data.' };
}

function NumberOfAreas({ value, disabled, onChange }) {
  const inputId = useId();
  return <div><label htmlFor={inputId} className="text-[10px] font-bold uppercase text-gray-400">Number of areas</label><Input id={inputId} disabled={disabled} type="number" min={1} max={250} step={1} value={value} onChange={(event) => onChange(Math.max(1, Math.min(250, Number(event.target.value) || 1)))} className="mt-1 h-11 border-white/10 bg-[#151520] text-lg font-black text-white" /></div>;
}

function IssueList({ title, issues }) {
  return <div className="rounded-xl border border-red-400/20 bg-red-400/10 p-3"><p className="mb-1 text-[10px] font-black uppercase text-red-300">{title}</p>{(issues || []).map((issue, index) => <p key={`${String(issue)}:${index}`} className="text-[11px] leading-relaxed text-gray-300">• {typeof issue === 'string' ? issue : issue?.message || issue?.code}</p>)}</div>;
}

function PlanSummary({ plan, boundaryAreaSqMiles, staleReason }) {
  const zones = Array.isArray(plan?.zones) ? plan.zones : [];
  const totalStreetMeters = zones.reduce((sum, zone) => sum + Math.max(0, Number(zone.street_length_meters || 0)), 0);
  const streetMiles = zones.map((zone) => Math.max(0, Number(zone.street_length_meters || 0)) / 1609.344).filter((value) => value > 0);
  const deviation = getCanvasWorkloadDeviation(plan || {});
  const qa = plan?.qa || {};
  const safetyReady = !staleReason
    && qa.street_coverage_complete === true
    && qa.no_duplicate_work_units === true
    && qa.connected_zones === true
    && qa.atomic_work_units === true
    && qa.protected_units_intact === true;
  const range = streetMiles.length ? `${Math.min(...streetMiles).toFixed(1)}–${Math.max(...streetMiles).toFixed(1)} mi` : 'Unavailable';
  return <div className="space-y-2 rounded-2xl border border-white/10 bg-white/[0.03] p-3"><div className="grid grid-cols-2 gap-2"><Metric label="Global boundary" value={formatCanvasArea(boundaryAreaSqMiles)} /><Metric label="Subdivisions" value={zones.length} /><Metric label="Eligible streets" value={formatCanvasDistance(totalStreetMeters)} /><Metric label="Workload range" value={range} /></div><div className={`rounded-xl border p-3 ${safetyReady ? 'border-green-400/20 bg-green-500/[0.08] text-green-100' : 'border-amber-400/20 bg-amber-500/[0.08] text-amber-100'}`}><p className="text-xs font-black">{safetyReady ? 'Street-safety checks passed' : staleReason || 'Street-safety checks need review'}</p><p className="mt-1 text-[10px] opacity-75">Connected areas · exclusive ownership · protected cul-de-sacs {deviation.verified ? `· max workload deviation ${Math.round(deviation.value)}%` : ''}</p></div>{qa.warnings?.length > 0 && <details className="rounded-xl border border-white/10 bg-black/20"><summary className="cursor-pointer px-3 py-2 text-[10px] font-black text-gray-400">Planning notes ({qa.warnings.length})</summary><div className="space-y-1 border-t border-white/10 p-3">{qa.warnings.map((warning, index) => <p key={`${String(warning)}:${index}`} className="text-[10px] leading-relaxed text-amber-100">• {typeof warning === 'string' ? warning : warning?.message || warning?.code}</p>)}</div></details>}</div>;
}

function AreaPreviewList({ zones, selectedZoneNumber, setSelectedZoneNumber, compact, showAssignees = false, membersById = new Map(), activeTeamMembers = [], disabled = false, onAssignment }) {
  const totalStreetMeters = zones.reduce((sum, zone) => sum + Math.max(0, Number(zone.street_length_meters || 0)), 0);
  return <div className={`grid gap-2 overflow-y-auto pr-1 ${compact ? 'max-h-52' : 'max-h-64'}`}>{zones.map((zone, index) => {
    const streetMeters = Math.max(0, Number(zone.street_length_meters || 0));
    const share = totalStreetMeters > 0 ? streetMeters / totalStreetMeters * 100 : 0;
    const selected = Number(selectedZoneNumber) === Number(zone.zone_number);
    const member = membersById.get(String(zone.assigned_team_member_id || ''));
    const color = zone.color || FALLBACK_COLORS[index % FALLBACK_COLORS.length];
    return <div key={zone.zone_id || zone.zone_number} className={`rounded-xl border p-3 ${selected ? 'border-purple-400 bg-purple-500/15' : 'border-white/10 bg-[#12121a]'}`}><button type="button" aria-pressed={selected} onClick={() => setSelectedZoneNumber(zone.zone_number)} className="flex w-full items-center gap-3 text-left"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-xs font-extrabold text-white" style={{ background: color }}>{zone.zone_number}</span><span className="min-w-0 flex-1"><span className="block text-sm font-bold text-white">Area {zone.zone_number}</span><span className="block truncate text-[10px] text-gray-400">{formatCanvasDistance(streetMeters)} · {share.toFixed(1)}% of street workload{showAssignees ? ` · ${member?.name || member?.email || 'Unassigned'}` : ''}</span></span></button>{showAssignees && selected && <Select disabled={disabled} value={String(zone.assigned_team_member_id || 'unassigned')} onValueChange={(value) => onAssignment?.(zone.zone_number, value === 'unassigned' ? '' : value)}><SelectTrigger className="mt-3 h-9 border-white/10 bg-black/30 text-xs text-white"><SelectValue /></SelectTrigger><SelectContent className="z-[4000] border-white/10 bg-black text-white"><SelectItem value="unassigned">Unassigned</SelectItem>{activeTeamMembers.map((rep) => <SelectItem key={rep.id} value={String(rep.id)}>{rep.name || rep.email}</SelectItem>)}</SelectContent></Select>}</div>;
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
    requestedZoneCount,
    roadFetchStatus,
    roadFetchError,
    roadFetchProgress,
    refreshRoadData,
    generationBlockers,
    generatePlan,
    generating,
    plan,
    planStaleReason,
    zones,
    assignedZoneCount,
    selectedZoneNumber,
    setSelectedZoneNumber,
    autoAssign,
    updateZoneAssignment,
    membersById,
    persistDraft,
    deployPlan,
    closeCampaign,
    saving,
    deploying,
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
  const equalLandShare = requestedZoneCount > 0 ? globalAreaSqMiles / requestedZoneCount : 0;
  const networkTruth = roadTruth(roadFetchStatus, roadFetchError);
  const showFooter = buildView || Boolean(plan && !deployed);
  const assignmentDisabled = mutationsLocked || !plan;

  return <div className="relative flex h-full flex-col text-white">
    <div className="shrink-0 border-b border-white/10 p-4"><div className="flex items-start justify-between gap-3"><div><h2 className="flex items-center gap-2 font-extrabold tracking-wide text-purple-300"><MapIcon className="h-5 w-5" /> CANVAS</h2><p className="mt-1 text-[10px] text-gray-500">Plan street-aligned areas first. Assign people when you are ready.</p></div><button type="button" disabled={mutationsLocked && !deployed} onClick={onClose} className="rounded-full p-2 hover:bg-white/10 disabled:opacity-40" aria-label="Close Canvas"><X className="h-5 w-5 text-gray-300" /></button></div><div className="mt-3 grid grid-cols-2 gap-1 rounded-xl border border-white/10 bg-black/30 p-1"><button type="button" aria-pressed={buildView} onClick={() => { if (!buildView && plan) startAnotherArea(); else changeWorkspaceView('new_area'); }} className={`rounded-lg px-3 py-2 text-[10px] font-black ${buildView ? 'bg-purple-500 text-white' : 'text-gray-400 hover:text-white'}`}>NEW AREA</button><button type="button" aria-pressed={!buildView} onClick={() => changeWorkspaceView('areas')} className={`rounded-lg px-3 py-2 text-[10px] font-black ${!buildView ? 'bg-purple-500 text-white' : 'text-gray-400 hover:text-white'}`}>AREAS & ASSIGNMENTS</button></div></div>

    <div className={`min-h-0 flex-1 space-y-4 overflow-y-auto p-4 ${showFooter ? 'pb-36' : 'pb-6'}`}>
      {buildView ? <>
        <section className="space-y-3"><StepLabel number="1">Draw the work area</StepLabel><div><label htmlFor={nameId} className="text-[10px] font-bold uppercase text-gray-500">Area plan name · optional</label><Input id={nameId} disabled={mutationsLocked} value={sessionName} onChange={(event) => changeSessionName(event.target.value)} className="mt-1 h-11 border-white/10 bg-[#151520] font-bold text-white" /></div><div className="grid grid-cols-2 gap-2"><Button disabled={mutationsLocked} onClick={onDraw} className="h-10 bg-purple-600 text-white hover:bg-purple-500"><Pencil className="h-4 w-4" /> {hasDrawnArea ? 'Redraw area' : 'Draw area'}</Button><Button disabled={!hasDrawnArea || mutationsLocked} onClick={onClearPolygon} className="h-10 border border-white/10 bg-white/10 text-white">Clear</Button></div><TruthRow icon={MapPin} tone={polygon.length ? 'good' : 'idle'} title={polygon.length ? 'Work boundary ready' : 'Draw one freehand boundary'} detail={polygon.length ? `${formatCanvasArea(globalAreaSqMiles)} selected. This boundary—not a house list—is the source of truth.` : 'Outline the entire cold area your team may work.'} /><TruthRow icon={Network} {...networkTruth} />{roadFetchStatus === 'loading' && Number(roadFetchProgress?.total) > 1 && <div className="rounded-xl border border-blue-400/20 bg-blue-500/[0.07] p-3"><div className="flex items-center justify-between text-[10px] font-black text-blue-100"><span>Large-area street import</span><span>{roadFetchProgress.completed}/{roadFetchProgress.total} tiles</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/30"><div className="h-full rounded-full bg-blue-400 transition-[width]" style={{ width: `${Math.max(0, Math.min(100, roadFetchProgress.completed / roadFetchProgress.total * 100))}%` }} /></div><p className="mt-2 text-[10px] leading-relaxed text-blue-100/70">Every tile must finish. Canvas will not build from partial street data.</p></div>}{['unavailable', 'empty'].includes(roadFetchStatus) && <Button disabled={mutationsLocked} onClick={refreshRoadData} className="h-10 w-full border border-white/10 bg-white/5 text-white"><RefreshCw className="h-4 w-4" /> Retry street data</Button>}</section>
        <section className="space-y-3"><StepLabel number="2">Choose the number of areas</StepLabel><p className="text-[11px] leading-relaxed text-gray-400">This number is only the subdivision count. It does not choose reps or send anything.</p><div className="space-y-2 rounded-2xl border border-white/10 bg-white/[0.03] p-3"><NumberOfAreas value={requestedAreaCount} disabled={mutationsLocked} onChange={changeRequestedAreaCount} /><p className="text-[10px] leading-relaxed text-gray-500">Create the first preview once. After that, changing this number updates the colored street split automatically after a short pause.</p></div><div className="grid grid-cols-2 gap-2"><Metric label="Global boundary" value={globalAreaSqMiles > 0 ? formatCanvasArea(globalAreaSqMiles) : 'Draw first'} /><Metric label="Equal land reference" value={equalLandShare > 0 ? `${formatCanvasArea(equalLandShare)} / area` : '—'} /></div><p className="rounded-xl border border-blue-400/15 bg-blue-500/[0.07] p-3 text-[10px] leading-relaxed text-blue-100">Land size is shown for orientation. Canvas balances eligible street workload, keeps every area connected, and protects cul-de-sacs instead of cutting equal geometric slices.</p>{requestedZoneCount >= 100 && <p className="rounded-xl border border-blue-400/20 bg-blue-500/10 p-3 text-[10px] leading-relaxed text-blue-100">Large subdivision plan: Canvas stops safely if the street topology is too dense to verify as one plan.</p>}{generationBlockers.length > 0 && <IssueList title="Before preview" issues={generationBlockers} />}<Button disabled={mutationsLocked || generationBlockers.length > 0} onClick={() => generatePlan()} className="h-12 w-full bg-purple-600 font-black text-white hover:bg-purple-500 disabled:bg-gray-800 disabled:text-gray-500">{generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} {plan ? 'Update area preview' : `Preview ${requestedZoneCount} ${requestedZoneCount === 1 ? 'area' : 'areas'}`}</Button></section>
        {zones.length > 0 && <section className="space-y-3"><StepLabel number="3">Review and save</StepLabel><PlanSummary plan={plan} boundaryAreaSqMiles={globalAreaSqMiles} staleReason={planStaleReason} />{planTooComplex && <IssueList title="Plan is too complex to save" issues={[planComplexityStatus.message]} />}<AreaPreviewList zones={zones} selectedZoneNumber={selectedZoneNumber} setSelectedZoneNumber={setSelectedZoneNumber} compact={compact} /><p className="text-[11px] leading-relaxed text-gray-500">Save this street split as a reusable area plan. No rep is assigned and nothing is sent from the builder.</p></section>}
      </> : <>
        <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-3"><div className="flex items-center justify-between gap-3"><div><p className="text-xs font-black text-white">Canvas Areas</p><p className="mt-1 text-[10px] leading-relaxed text-gray-500">Open a saved plan, assign any number of its areas, save partial progress, and send only when every area is covered.</p></div><Button disabled={campaignIndexLoading} onClick={refreshCampaignIndex} size="icon" className="h-8 w-8 shrink-0 bg-white/10 text-white">{campaignIndexLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}</Button></div></section>
        {campaignSigningUnavailable && <section className="rounded-2xl border border-amber-400/25 bg-amber-500/[0.08] p-3"><div className="flex items-start gap-2"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" /><div><p className="text-xs font-black text-amber-100">Sending is temporarily disabled</p><p className="mt-1 text-[11px] leading-relaxed text-amber-100/80">Area planning and saving still work. An administrator must configure Canvas lifecycle signing before assignments can be activated.</p></div></div></section>}
        {campaignIndexError && !campaignSigningUnavailable && <section className="rounded-2xl border border-red-400/25 bg-red-500/[0.08] p-3"><p className="text-xs font-black text-red-100">Some campaign records failed verification</p><p className="mt-1 text-[11px] leading-relaxed text-red-100/80">{campaignIndexError} They remain fail-closed and cannot be trusted or sent.</p>{quarantinableCampaignCount > 0 && <Button disabled={quarantiningCampaigns} onClick={quarantineRejectedCampaigns} className="mt-3 h-10 w-full border border-red-300/20 bg-red-500/15 text-red-50 hover:bg-red-500/25">{quarantiningCampaigns ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Quarantine {quarantinableCampaignCount} unsigned legacy record{quarantinableCampaignCount === 1 ? '' : 's'}</Button>}<p className="mt-2 text-[9px] leading-relaxed text-red-100/60">Unsigned legacy records can be quarantined without deletion. Signed records remain hidden for manual recovery so a rotated signing key can never remove a previously valid campaign.</p></section>}
        <section className="space-y-2 rounded-2xl border border-amber-400/20 bg-amber-500/[0.06] p-3"><div><p className="text-xs font-black text-amber-100">Saved area plans ({savedDrafts.length})</p><p className="mt-0.5 text-[10px] text-gray-500">Plans can stay unassigned for as long as needed.</p></div>{savedDrafts.length ? <><Select value={campaignId(selectedDraft)} onValueChange={setSelectedDraftId}><SelectTrigger className="h-10 border-white/10 bg-black/30 text-white"><SelectValue /></SelectTrigger><SelectContent className="z-[4000] border-white/10 bg-black text-white">{savedDrafts.map((draft) => <SelectItem key={campaignId(draft)} value={campaignId(draft)}>{draft.session_name} · {draft.zone_count} areas · v{draft.version}</SelectItem>)}</SelectContent></Select><Button disabled={!selectedDraft || resumingDraft || !teamMembersReady} onClick={() => resumeDraft(selectedDraft)} className="h-10 w-full border border-amber-300/20 bg-amber-500/15 text-amber-50 hover:bg-amber-500/25">{resumingDraft || !teamMembersReady ? <Loader2 className="h-4 w-4 animate-spin" /> : <MapIcon className="h-4 w-4" />} {teamMembersReady ? 'Open area plan' : 'Loading team…'}</Button></> : <div className="rounded-xl border border-dashed border-white/10 p-4 text-center"><p className="text-[11px] text-gray-400">No saved area plans yet.</p><button type="button" onClick={() => changeWorkspaceView('new_area')} className="mt-2 text-[10px] font-black text-purple-300">Create the first area plan</button></div>}</section>
        {(activeDeployment || closedDeployment) && <div className={`rounded-2xl border p-3 ${activeDeployment ? 'border-green-500/30 bg-green-500/10' : 'border-white/15 bg-white/5'}`}><p className={`text-sm font-bold ${activeDeployment ? 'text-green-300' : 'text-white'}`}>{activeDeployment ? 'Campaign is live' : `Campaign ${serverSession.status}`}</p><p className="text-[11px] text-gray-400">{activeDeployment ? `${serverSession.delivery_count || assignedZoneCount} assigned areas · house decisions sync onto the shared map` : 'Its areas are no longer active on rep maps.'}</p>{activeDeployment && <div className="mt-3 grid grid-cols-3 gap-2"><Button disabled={liveMapLoading} onClick={() => loadCampaignMap(serverSession)} className="h-9 border border-purple-400/25 bg-purple-500/20 text-purple-100"><Eye className="h-4 w-4" /> Map</Button><Button disabled={closing} onClick={() => closeCampaign('complete')} className="h-9 border border-green-400/25 bg-green-500/15 text-green-100"><CheckCircle2 className="h-4 w-4" /> Done</Button><Button disabled={closing} onClick={() => closeCampaign('recall')} className="h-9 border border-red-400/25 bg-red-500/15 text-red-100"><AlertTriangle className="h-4 w-4" /> Recall</Button></div>}<Button onClick={startAnotherArea} className="mt-2 h-10 w-full border border-white/10 bg-white/10 text-white"><Pencil className="h-4 w-4" /> Create another area plan</Button></div>}
        {otherActiveCampaigns.length > 0 && <section className="space-y-2 rounded-2xl border border-purple-400/20 bg-purple-500/[0.06] p-3"><p className="text-xs font-black text-purple-200">Other active campaigns ({otherActiveCampaigns.length})</p><Select value={campaignId(selectedIndexedCampaign)} onValueChange={setSelectedIndexedCampaignId}><SelectTrigger className="h-10 border-white/10 bg-black/30 text-white"><SelectValue /></SelectTrigger><SelectContent className="z-[4000] border-white/10 bg-black text-white">{otherActiveCampaigns.map((campaign) => <SelectItem key={campaignId(campaign)} value={campaignId(campaign)}>{campaign.session_name} · {campaign.zone_count} areas</SelectItem>)}</SelectContent></Select>{selectedIndexedCampaign && <div className="grid grid-cols-3 gap-2"><Button disabled={liveMapLoading} onClick={() => loadCampaignMap(selectedIndexedCampaign)} className="h-9 border border-purple-400/25 bg-purple-500/20 text-purple-100"><Eye className="h-4 w-4" /> Map</Button><Button disabled={closing} onClick={() => closeCampaign('complete', selectedIndexedCampaign)} className="h-9 border border-green-400/25 bg-green-500/15 text-green-100"><CheckCircle2 className="h-4 w-4" /> Done</Button><Button disabled={closing} onClick={() => closeCampaign('recall', selectedIndexedCampaign)} className="h-9 border border-red-400/25 bg-red-500/15 text-red-100"><AlertTriangle className="h-4 w-4" /> Recall</Button></div>}</section>}
        {liveCampaignMap && <CampaignProgress map={liveCampaignMap} loading={liveMapLoading} error={liveMapError} onRefresh={() => loadCampaignMap(liveCampaignMap.campaign)} />}
        {plan && !deployed && <section className="space-y-3"><div><p className="text-xs font-black text-white">Assign this area plan</p><p className="mt-1 text-[10px] leading-relaxed text-gray-500">Assignments do not change the street split. Partial assignments can be saved.</p></div><PlanSummary plan={plan} boundaryAreaSqMiles={globalAreaSqMiles} staleReason={planStaleReason} />{getCanvasWorkloadDeviation(plan).verified && getCanvasWorkloadDeviation(plan).value > 25 && <button type="button" role="checkbox" aria-checked={workloadExceptionAccepted} disabled={assignmentDisabled} onClick={() => changeWorkloadExceptionAcceptance(!workloadExceptionAccepted)} className={`flex w-full items-start gap-2 rounded-xl border p-3 text-left text-[10px] ${workloadExceptionAccepted ? 'border-amber-300/50 bg-amber-500/15 text-amber-50' : 'border-amber-400/20 bg-amber-500/[0.07] text-amber-100'}`}><span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${workloadExceptionAccepted ? 'border-amber-200 bg-amber-400 text-black' : 'border-amber-200/40'}`}>{workloadExceptionAccepted && <CheckCircle2 className="h-3 w-3" />}</span><span>I reviewed and accept this uneven split. Canvas kept natural street units intact instead of cutting a cul-de-sac.</span></button>}<AssignmentPool members={activeTeamMembers} selectedIds={selectedTeamMemberIds} disabled={assignmentDisabled} toggle={toggleTeamMember} replaceSelection={replaceTeamMemberSelection} /><Button disabled={assignmentDisabled || !selectedTeamMemberIds.length || selectedTeamMemberIds.length > zones.length} onClick={autoAssign} className="h-10 w-full bg-purple-600 text-white"><Wand2 className="h-4 w-4" /> Auto-assign {zones.length} areas across {selectedTeamMemberIds.length || 0} reps</Button>{!activeTeamMembers.length && <div className="rounded-xl border border-amber-400/20 bg-amber-500/[0.07] p-3"><p className="text-xs font-black text-amber-100">No eligible reps yet</p><p className="mt-1 text-[10px] leading-relaxed text-gray-300">The area plan is safe to keep unassigned. Add or activate reps when you are ready.</p><div className="mt-2 grid grid-cols-2 gap-2"><Button asChild className="h-9 border border-amber-300/20 bg-amber-500/15 text-amber-50"><Link to={createPageUrl('AdminTeam')} target="_blank" rel="noopener noreferrer"><Users className="h-4 w-4" /> Manage reps</Link></Button>{canRefreshTeamRoster && <Button disabled={teamRosterRefreshing} onClick={refreshTeamRoster} className="h-9 border border-white/10 bg-white/10 text-white">{teamRosterRefreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Refresh</Button>}</div></div>}<AreaPreviewList zones={zones} selectedZoneNumber={selectedZoneNumber} setSelectedZoneNumber={setSelectedZoneNumber} compact={compact} showAssignees membersById={membersById} activeTeamMembers={activeTeamMembers} disabled={assignmentDisabled} onAssignment={updateZoneAssignment} /></section>}
      </>}
    </div>

    {showFooter && <div className="absolute bottom-0 left-0 right-0 border-t border-white/10 bg-[#09090f] p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">{buildView ? <><div className="mb-2 flex items-center justify-between text-[10px] text-gray-500"><span>{zones.length ? `${zones.length} areas previewed` : 'No area preview yet'}</span><span>{saving ? 'Saving…' : serverSession?.session_id ? (draftDirty ? 'Unsaved changes' : 'Saved') : 'Not saved'}</span></div><Button disabled={!plan || Boolean(planStaleReason) || mutationsLocked || planTooComplex} onClick={() => persistDraft()} className="h-12 w-full bg-purple-600 font-extrabold text-white hover:bg-purple-500 disabled:bg-gray-800 disabled:text-gray-500">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save area plan</Button></> : <><div className="mb-2 flex items-center justify-between text-[10px] text-gray-500"><span>{assignedZoneCount}/{zones.length} areas assigned</span><span>{saving ? 'Saving…' : draftDirty ? 'Unsaved changes' : 'Saved'}</span></div><div className="flex gap-2"><Button disabled={!plan || mutationsLocked || planTooComplex} onClick={() => persistDraft()} className="h-12 border border-white/10 bg-white/10 px-4 text-white"><Save className="h-4 w-4" /> Save</Button><Button disabled={!sendable || mutationsLocked} onClick={deployPlan} className="h-12 flex-1 bg-purple-600 font-extrabold text-white hover:bg-purple-500 disabled:bg-gray-800 disabled:text-gray-500">{deploying || closing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />} Send assigned areas</Button></div>{planTooComplex ? <p className="mt-2 text-[10px] text-amber-300">{planComplexityStatus.message}</p> : workloadDeviationUnavailable ? <p className="mt-2 text-[10px] text-amber-300">Workload balance could not be verified. Regenerate before sending.</p> : workloadExceptionNeedsAcceptance ? <p className="mt-2 text-[10px] text-amber-300">Review and accept the workload exception before sending.</p> : !crewAssignmentStatus.valid && <p className="mt-2 text-[10px] text-amber-300">{crewAssignmentStatus.message}</p>}</>}</div>}
  </div>;
}
