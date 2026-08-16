import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
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
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  assignCanvasZonesRoundRobin,
  buildCanvasDraftPayload,
  formatCanvasOverlapConfirmation,
  getCanvasCrewAssignmentStatus,
  getCanvasPlanComplexityStatus,
  getCanvasPlannerFailureMessage,
  getCanvasTeamMemberEligibility,
  getCanvasWorkloadDeviation,
  lockedZonesFromPlan,
  reconcileCanvasPlanWithEligibleTeam,
  restoreCanvasDraftPlan,
  updateCanvasZoneAssignment,
  validateCanvasBoundary,
} from '@/components/canvas/canvasPlannerUtils';
import {
  analyzeCanvasBoundary,
  applyCanvasClassificationOverride,
  cancelCanvasAnalysis,
  clearPersistedCanvasAnalysisJob,
  closeCanvasCampaign,
  deployCanvasCampaign,
  getCanvasAnalysis,
  getCanvasCampaignMap,
  getCanvasCampaignSummary,
  listMyCanvasCampaigns,
  persistCanvasAnalysisJob,
  publishCanvasAssignmentPackages,
  quarantineInvalidCanvasCampaigns,
  readPersistedCanvasAnalysisJob,
  saveCanvasDraft,
} from '@/components/canvas/canvasProductionClient';
import { canvasZoneLoggedCount, formatCanvasDistance, getCanvasOutcome } from '@/components/canvas/canvasOutcomeUtils';
import { getCanvasClassifiedStreetUnits } from '@/components/canvas/canvasResidentialPresentation';
import { mergeCanvasResidentialZones, partitionCanvasResidentialTerritories } from '@/components/logic/canvasResidentialTerritoryAnalysis';
import { partitionCanvasResidentialTerritoriesAsync } from '@/components/logic/canvasResidentialTerritoryPlannerAsync';
import CanvasPlannerWorkspace from './CanvasPlannerWorkspace.jsx';
import { createPageUrl } from '@/utils';

const UNASSIGNED_ZONE_COLOR = '#A855F7';
const ASSIGNED_ZONE_COLOR = '#64748B';
const TERRITORY_COLORS = ['#A855F7', '#2563EB', '#059669', '#EA580C', '#DB2777', '#0891B2', '#CA8A04', '#7C3AED'];
// Manager progress uses versioned operational projections. Keep a bounded
// recovery poll in addition to explicit refresh/focus instead of reloading the
// full campaign every 15 seconds.
const CAMPAIGN_REFRESH_MS = 5 * 60_000;
const MAX_CANVAS_DRAFT_JSON_BYTES = 8_000_000;
const CANVAS_DRAFT_METADATA_RESERVE_BYTES = 200_000;
const MAX_CANVAS_PREVIEW_JSON_BYTES = MAX_CANVAS_DRAFT_JSON_BYTES - CANVAS_DRAFT_METADATA_RESERVE_BYTES;

const polygonKeyFor = (polygon = []) => polygon
  .map((point) => `${Number(point?.lat).toFixed(7)},${Number(point?.lng).toFixed(7)}`)
  .join('|');

const initialQa = (warnings = []) => ({
  deployable: false,
  street_coverage_complete: false,
  no_duplicate_work_units: false,
  no_missing_work_units: false,
  connected_zones: false,
  atomic_work_units: false,
  protected_units_intact: false,
  data_quality_status: 'unverified',
  warnings,
});

const makeIdempotencyKey = () => {
  try { return crypto.randomUUID(); } catch { return `canvas_deploy_${Date.now()}_${Math.random().toString(36).slice(2)}`; }
};

function normalizeQa(qa = {}, warnings = []) {
  const protectedUnitSplits = Number(qa.protected_unit_split_count ?? qa.cul_de_sac_split_count ?? qa.cul_de_sac_splits ?? 0);
  return {
    ...qa,
    street_coverage_complete: qa.street_coverage_complete === true || qa.coverage_complete === true,
    no_duplicate_work_units: qa.no_duplicate_work_units === true || qa.no_duplicate_units === true,
    no_missing_work_units: qa.no_missing_work_units === true || qa.exclusive_work_unit_coverage === true,
    connected_zones: qa.connected_zones === true,
    atomic_work_units: qa.atomic_work_units === true,
    protected_units_intact: qa.protected_units_intact === true && protectedUnitSplits === 0,
    protected_unit_splits: protectedUnitSplits,
    data_quality_status: qa.data_quality_status || 'verified',
    warnings: [...new Set([...(qa.warnings || []), ...warnings])],
  };
}

function withAssignmentGate(plan) {
  if (!plan) return null;
  const qa = normalizeQa(plan.qa);
  const zones = Array.isArray(plan.zones) ? plan.zones : [];
  const assignmentReady = zones.length > 0 && zones.every((zone) => zone.assigned_team_member_id);
  const coreGatesPass = ['street_workload', 'street_work_units'].includes(plan.planning_method)
    && plan.assignment_basis === 'street_work_unit_ids'
    && qa.street_coverage_complete
    && qa.no_duplicate_work_units
    && qa.no_missing_work_units
    && qa.connected_zones
    && qa.atomic_work_units
    && qa.protected_units_intact;
  return { ...plan, qa: { ...qa, deployable: assignmentReady && coreGatesPass } };
}

function planWithAssignments(plan, selectedTeamMemberIds, teamMembers) {
  if (!plan) return null;
  const zones = assignCanvasZonesRoundRobin(plan.zones || [], selectedTeamMemberIds, teamMembers);
  return withAssignmentGate({ ...plan, zones });
}

function residentialPartitionFailure(partition) {
  const details = partition?.details || {};
  if (partition?.code === 'NO_KNOCK_OPPORTUNITY') {
    return 'Canvas did not find verified residential street work in this boundary. Review the evidence or redraw around a neighborhood.';
  }
  if (partition?.code === 'TOO_MANY_ZONES_FOR_WORK_UNITS') {
    return `This boundary supports at most ${Number(details.maximum_zone_count || 0).toLocaleString()} indivisible residential areas.`;
  }
  if (partition?.code === 'TOO_FEW_ZONES_FOR_COMPONENTS') {
    return `The residential work contains ${Number(details.minimum_zone_count || 0).toLocaleString()} disconnected street clusters. Choose at least that many areas.`;
  }
  if (partition?.code === 'CONNECTED_PARTITION_FAILED') {
    return 'Canvas could not keep every requested area connected. Change the area count and try again.';
  }
  return getCanvasPlannerFailureMessage(partition) || 'Canvas could not create connected residential areas.';
}

function lineLengthMeters(coordinates = []) {
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const [leftLng, leftLat] = coordinates[index - 1];
    const [rightLng, rightLat] = coordinates[index];
    const latitudeRadians = ((Number(leftLat) + Number(rightLat)) / 2) * Math.PI / 180;
    const deltaLat = (Number(rightLat) - Number(leftLat)) * 111_320;
    const deltaLng = (Number(rightLng) - Number(leftLng)) * 111_320 * Math.cos(latitudeRadians);
    total += Math.hypot(deltaLat, deltaLng);
  }
  return total;
}

function evidenceSegments(unit) {
  if (Array.isArray(unit?.segments) && unit.segments.length) return unit.segments;
  const coordinates = unit?.geometry?.type === 'LineString' ? unit.geometry.coordinates : [];
  return coordinates.slice(1).map((coordinate, index) => ({
    edge_id: `${String(unit?.work_unit_id || unit?.id || 'canvas-unit')}:${index}`,
    start: { lng: Number(coordinates[index][0]), lat: Number(coordinates[index][1]) },
    end: { lng: Number(coordinate[0]), lat: Number(coordinate[1]) },
    street_names: Array.isArray(unit?.street_names) ? unit.street_names : [],
    length_meters: lineLengthMeters([coordinates[index], coordinate]),
  }));
}

function planResidentialStreetUnits(analysis) {
  return getCanvasClassifiedStreetUnits(analysis).map((unit) => {
    const id = String(unit?.id || unit?.unit_id || unit?.street_unit_id || unit?.work_unit_id || '').trim();
    const opportunity = unit?.opportunity || {};
    const segments = evidenceSegments(unit);
    return {
      ...unit,
      id,
      unit_id: id,
      work_unit_id: id,
      canvas_role: unit?.canvas_role || 'uncertain',
      opportunity: {
        low: Number(unit?.opportunity_low ?? opportunity.min ?? opportunity.low ?? 0),
        expected: Number(unit?.opportunity_expected ?? opportunity.expected ?? 0),
        high: Number(unit?.opportunity_high ?? opportunity.max ?? opportunity.high ?? 0),
      },
      street_names: unit?.street_names || unit?.streetNames || [],
      neighbor_ids: unit?.neighbor_ids || unit?.neighborIds || [],
      segments,
      street_length_meters: Number(unit?.street_length_meters ?? unit?.streetLengthMeters ?? lineLengthMeters(unit?.geometry?.coordinates || [])),
      protected: unit?.protected === true || Boolean(unit?.protected_group_id),
    };
  }).filter((unit) => unit.id);
}

function buildResidentialTerritoryPlan(analysis, areaCount, suppliedPartition = null) {
  const classifiedStreetUnits = planResidentialStreetUnits(analysis);
  const partition = suppliedPartition || partitionCanvasResidentialTerritories({
    street_units: classifiedStreetUnits,
    area_count: areaCount,
  });
  if (!partition?.ok) return { ...partition, message: residentialPartitionFailure(partition) };
  const byId = new Map(classifiedStreetUnits.map((unit) => [unit.id, unit]));
  const zones = (partition.zones || []).map((zone, index) => {
    const ownedUnits = (zone.work_unit_ids || []).map((id) => byId.get(String(id))).filter(Boolean);
    const streetLengthMeters = ownedUnits.reduce((sum, unit) => sum + Number(unit.street_length_meters || 0), 0);
    const opportunity = ownedUnits.reduce((sum, unit) => sum + Number(unit.opportunity?.expected || 0), 0);
    return {
      ...zone,
      zone_id: zone.zone_id || `canvas-residential-zone:${index + 1}`,
      zone_number: Number(zone.zone_number) || index + 1,
      geometry_role: 'display_only',
      street_length_meters: Number(streetLengthMeters.toFixed(2)),
      estimated_doors: opportunity,
      opportunity_expected: opportunity,
      workload_score: opportunity,
      color: zone.color || TERRITORY_COLORS[index % TERRITORY_COLORS.length],
    };
  });
  const unresolvedUnitCount = classifiedStreetUnits.filter((unit) => unit.canvas_role === 'uncertain').length;
  const evidenceId = String(analysis?.evidence_id || '').trim();
  const snapshotHash = String(analysis?.snapshot_hash || '').trim();
  const sourceVersion = String(analysis?.release_id || analysis?.source_version || evidenceId).trim();
  const qaPass = partition.qa?.exclusive_work_unit_coverage === true;
  return {
    ...partition,
    ok: true,
    status: unresolvedUnitCount ? 'needs_review' : 'ready',
    deployable: partition.deployable === true && unresolvedUnitCount === 0 && Boolean(evidenceId && snapshotHash),
    territory_model: 'residential_street_territory_v2',
    planning_method: 'street_workload',
    assignment_basis: 'street_work_unit_ids',
    workload_basis: 'residential_opportunity',
    division_mode: 'area_count',
    road_aligned: true,
    algorithm_version: String(partition.algorithm_version || 'canvas-residential-territory-v2').slice(0, 128),
    data_version: sourceVersion.slice(0, 256),
    evidence_id: evidenceId,
    evidence_release_id: analysis?.release_id || null,
    snapshot_hash: snapshotHash,
    revision_id: analysis?.revision_id || null,
    evidence_schema_version: Number(analysis?.evidence_schema_version || analysis?.schema_version || 1),
    unresolved_unit_count: unresolvedUnitCount,
    selected_team_member_ids: [],
    zones,
    territories: zones,
    work_units: classifiedStreetUnits,
    context_street_units: classifiedStreetUnits.filter((unit) => unit.canvas_role !== 'knock'),
    qa: {
      ...(partition.qa || {}),
      deployable: partition.deployable === true && unresolvedUnitCount === 0 && Boolean(evidenceId && snapshotHash),
      street_coverage_complete: qaPass,
      no_duplicate_work_units: qaPass,
      no_missing_work_units: qaPass,
      connected_zones: partition.qa?.connected_zones === true,
      atomic_work_units: true,
      protected_units_intact: partition.qa?.protected_units_intact === true,
      protected_unit_splits: partition.qa?.protected_units_intact === true ? 0 : 1,
      cul_de_sac_splits: partition.qa?.protected_units_intact === true ? 0 : 1,
      data_quality_status: analysis?.production_trusted === false ? 'untrusted' : 'verified',
      unresolved_unit_count: unresolvedUnitCount,
      max_workload_deviation_percent: partition.qa?.max_opportunity_deviation_percent ?? null,
    },
  };
}

function residentialAnalysisFromServer(startResult, loadedResult = null) {
  const evidence = loadedResult?.evidence || startResult?.evidence || {};
  const analysis = evidence.analysis_result
    || loadedResult?.analysis_result
    || loadedResult?.analysis
    || startResult?.analysis_result
    || startResult?.analysis
    || {};
  return {
    ...analysis,
    evidence_id: evidence.evidence_id || startResult?.evidence_id || loadedResult?.evidence_id || '',
    snapshot_hash: evidence.snapshot_hash || startResult?.snapshot_hash || loadedResult?.snapshot_hash || '',
    release_id: evidence.release_id || startResult?.release_id || analysis.release_id || '',
    revision_id: loadedResult?.revision_id || evidence.revision_id || '',
    evidence_schema_version: Number(evidence.schema_version || startResult?.evidence_schema_version || 1),
    production_trusted: evidence.production_trusted ?? startResult?.production_trusted ?? true,
    source_attribution: evidence.source_attribution || analysis.source_attribution || '',
  };
}

function canvasPlannerError(value, fallbackMessage = 'Canvas planning failed.') {
  const error = value instanceof Error
    ? value
    : new Error(getCanvasPlannerFailureMessage(value) || fallbackMessage);
  if (value?.code !== undefined && value?.code !== null) error.code = String(value.code);
  if (value?.details && typeof value.details === 'object') error.details = value.details;
  return error;
}

function canvasDraftPayloadBytes(payload) {
  return new TextEncoder().encode(JSON.stringify(payload)).byteLength;
}

function campaignId(campaign) {
  return String(campaign?.campaign_id || campaign?.session_id || campaign?.id || '');
}

function campaignZones(campaignMap) {
  const campaign = campaignMap?.campaign || {};
  const zones = campaign.zones || campaign.plan?.zones || campaign.canonical_plan?.zones || campaignMap?.zones;
  return Array.isArray(zones) ? zones : [];
}

function canvasOperationalSummaryFields(summary) {
  if (!summary) return {};
  const zoneCounts = Object.fromEntries((summary.zones || []).map((zone) => [String(zone.zone_id), {
    total_pins: Number(zone?.progress?.distinct_pin_count || 0),
    outcomes: zone?.progress?.outcome_counts || {},
  }]));
  return {
    viewport_decisions: true,
    operational_summary: summary,
    outcome_counts: summary.totals?.outcome_counts || {},
    zone_counts: zoneCounts,
    total_pins: Number(summary.totals?.distinct_pin_count || 0),
    total_events: Number(summary.totals?.event_count || 0),
    dnc_safety: {
      complete: true,
      delivery: 'operational_viewport',
      pin_count: Number(summary.totals?.tenant_wide_active_dnc_count || 0),
    },
    truncated: false,
  };
}

function isTerritoryPlanDeployable(plan, eligibleTeamIds) {
  if (!plan || plan.planning_method !== 'street_workload' || plan.assignment_basis !== 'street_work_unit_ids') return false;
  const residentialV2 = plan.territory_model === 'residential_street_territory_v2';
  if (plan.workload_basis !== (residentialV2 ? 'residential_opportunity' : 'street_length')) return false;
  if (!String(plan.algorithm_version || '').trim() || !String(plan.data_version || '').trim()) return false;
  const qa = normalizeQa(plan.qa);
  const coreGatesPass = qa.street_coverage_complete
    && qa.no_duplicate_work_units
    && qa.no_missing_work_units
    && qa.connected_zones
    && qa.atomic_work_units
    && qa.protected_units_intact
    && Number(qa.protected_unit_splits || qa.cul_de_sac_splits || 0) === 0;
  const workUnits = Array.isArray(plan.work_units) ? plan.work_units : [];
  const ownershipUnits = residentialV2 ? workUnits.filter((unit) => unit?.canvas_role === 'knock') : workUnits;
  const ownershipIds = new Set(ownershipUnits.map((unit) => String(unit?.id || unit?.unit_id || '')));
  const zones = Array.isArray(plan.zones) ? plan.zones : [];
  const ownedIds = zones.flatMap((zone) => Array.isArray(zone?.work_unit_ids) ? zone.work_unit_ids.map(String) : []);
  return coreGatesPass
    && workUnits.length > 0
    && ownershipUnits.length > 0
    && zones.length > 0
    && ownedIds.length === ownershipUnits.length
    && new Set(ownedIds).size === ownershipUnits.length
    && ownedIds.every((id) => ownershipIds.has(id))
    && (!residentialV2 || (Boolean(plan.evidence_id) && Boolean(plan.snapshot_hash) && Number(plan.unresolved_unit_count || 0) === 0))
    && (!residentialV2 || qa.data_quality_status === 'verified')
    && zones.every((zone) => eligibleTeamIds.has(String(zone.assigned_team_member_id || '')));
}

export default function CanvasBuilderSettings({
  drawnPolygon,
  hasDrawnArea,
  onDraw,
  onClearPolygon,
  onResumeBoundary,
  onClose,
  user,
  teamMembers = [],
  teamMembersReady = true,
  onRefreshTeamMembers,
  onDraftDirtyChange,
  onPreviewChange,
}) {
  const polygon = useMemo(() => hasDrawnArea && drawnPolygon?.length > 2 ? drawnPolygon : [], [drawnPolygon, hasDrawnArea]);
  const polygonKey = useMemo(() => polygonKeyFor(polygon), [polygon]);
  const teamEligibility = useMemo(() => getCanvasTeamMemberEligibility(teamMembers), [teamMembers]);
  const activeTeamMembers = teamEligibility.eligible;
  const membersById = useMemo(() => new Map(activeTeamMembers.map((member) => [String(member.id), member])), [activeTeamMembers]);
  const rosterMembersById = useMemo(() => new Map(teamMembers.map((member) => [String(member.id), member])), [teamMembers]);
  const eligibleTeamIds = useMemo(() => new Set(activeTeamMembers.map((member) => String(member.id))), [activeTeamMembers]);
  const [sessionName, setSessionName] = useState('Canvas Cold Area');
  const [divisionBasis, setDivisionBasis] = useState('area_count');
  const [selectedTeamMemberIds, setSelectedTeamMemberIds] = useState([]);
  const [requestedAreaCount, setRequestedAreaCount] = useState(1);
  const [targetStreetWorkloadMiles, setTargetStreetWorkloadMiles] = useState(1.5);
  const [residentialAnalysis, setResidentialAnalysis] = useState(null);
  const [classificationUnitId, setClassificationUnitId] = useState('');
  const [classificationRole, setClassificationRole] = useState('knock');
  const [classificationOpportunityCount, setClassificationOpportunityCount] = useState('');
  const [classificationReason, setClassificationReason] = useState('');
  const [classificationSaving, setClassificationSaving] = useState(false);
  const [roadFetchStatus, setRoadFetchStatus] = useState('idle');
  const [roadFetchError, setRoadFetchError] = useState(null);
  const [roadFetchProgress, setRoadFetchProgress] = useState(null);
  const [roadFetchNonce, setRoadFetchNonce] = useState(0);
  const [serverAnalysisJobId, setServerAnalysisJobId] = useState('');
  const [cancellingServerAnalysis, setCancellingServerAnalysis] = useState(false);
  const [workspaceView, setWorkspaceView] = useState(() => {
    try { return sessionStorage.getItem('fk_canvasPlannerView') === 'areas' ? 'areas' : 'new_area'; } catch { return 'new_area'; }
  });
  const [mobileCollapsed, setMobileCollapsed] = useState(false);
  const [plan, setPlan] = useState(null);
  // Areas the manager pinned. Their exact streets survive the next regeneration.
  const [lockedZoneIds, setLockedZoneIds] = useState(() => new Set());
  const [planStaleReason, setPlanStaleReason] = useState('');
  const [planGenerationError, setPlanGenerationError] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [packagePublishing, setPackagePublishing] = useState(false);
  const [packagePublicationStatus, setPackagePublicationStatus] = useState('idle');
  const [packagePublicationIssue, setPackagePublicationIssue] = useState('');
  const [closing, setClosing] = useState(false);
  const [campaignIndex, setCampaignIndex] = useState([]);
  const [campaignIndexLoading, setCampaignIndexLoading] = useState(false);
  const [campaignIndexError, setCampaignIndexError] = useState('');
  const [quarantinableCampaignCount, setQuarantinableCampaignCount] = useState(0);
  const [quarantiningCampaigns, setQuarantiningCampaigns] = useState(false);
  const [selectedIndexedCampaignId, setSelectedIndexedCampaignId] = useState('');
  const [selectedDraftId, setSelectedDraftId] = useState('');
  const [resumingDraft, setResumingDraft] = useState(false);
  const [liveCampaignMap, setLiveCampaignMap] = useState(null);
  const [liveMapLoading, setLiveMapLoading] = useState(false);
  const [liveMapError, setLiveMapError] = useState('');
  const [serverSession, setServerSession] = useState(null);
  const [selectedZoneNumber, setSelectedZoneNumber] = useState(null);
  const [workloadExceptionAccepted, setWorkloadExceptionAccepted] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const [teamRosterRefreshing, setTeamRosterRefreshing] = useState(false);
  const [livePreviewRevision, setLivePreviewRevision] = useState(0);
  const previousPolygonKey = useRef(polygonKey);
  const roadFetchAbortRef = useRef(null);
  const startAnotherAreaRef = useRef(null);
  const deploymentAttemptRef = useRef(null);
  const packagePublicationAttemptRef = useRef(null);
  const closeAttemptRef = useRef(null);
  const activeOperationRef = useRef('');
  const plannerAbortRef = useRef(null);
  // A merge is decided before the plan that contains it exists.
  const mergedZoneOverrideRef = useRef(null);
  const lastGeneratedPreviewRevisionRef = useRef(-1);
  const lastAttemptedPreviewRevisionRef = useRef(-1);
  const livePreviewTimerRef = useRef(null);
  const fitNextPreviewRef = useRef(false);
  const resumedAnalysisJobRef = useRef(null);

  useEffect(() => {
    packagePublicationAttemptRef.current = null;
    setPackagePublicationStatus('idle');
    setPackagePublicationIssue('');
  }, [serverSession?.session_id]);

  useEffect(() => {
    if (!user?.id || typeof onResumeBoundary !== 'function') return;
    const persisted = readPersistedCanvasAnalysisJob(user.id);
    if (!persisted) return;
    resumedAnalysisJobRef.current = persisted;
    const persistedPolygonKey = polygonKeyFor(persisted.polygon);
    if (!polygon.length) {
      setRequestedAreaCount(persisted.areaCount);
      onResumeBoundary(persisted.polygon);
    } else if (polygonKey !== persistedPolygonKey) {
      resumedAnalysisJobRef.current = null;
    }
  }, [onResumeBoundary, polygon.length, polygonKey, user?.id]);

  const requestedZoneCount = divisionBasis === 'selected_reps'
    ? new Set(selectedTeamMemberIds).size
    : divisionBasis === 'area_count'
      ? Math.max(1, Math.min(250, Number(requestedAreaCount) || 1))
      : plan?.division_basis === 'street_workload_target' ? plan.zones?.length || 0 : 0;
  const zones = useMemo(() => plan?.zones || [], [plan?.zones]);
  const selectedZone = zones.find((zone) => Number(zone.zone_number) === Number(selectedZoneNumber)) || null;
  const classifiedStreetUnits = useMemo(() => planResidentialStreetUnits(residentialAnalysis), [residentialAnalysis]);
  const selectedClassificationUnit = classifiedStreetUnits.find((unit) => unit.id === classificationUnitId) || null;
  const unresolvedClassificationCount = classifiedStreetUnits.filter((unit) => unit.canvas_role === 'uncertain').length;
  const deploymentPlan = useMemo(() => {
    if (!plan) return null;
    const planWithManagerIntent = { ...plan, selected_team_member_ids: [...new Set(selectedTeamMemberIds.map(String).filter(Boolean))] };
    return planStaleReason ? {
      ...planWithManagerIntent,
      qa: { ...(plan.qa || initialQa()), deployable: false, warnings: [...new Set([...(plan.qa?.warnings || []), planStaleReason])] },
    } : planWithManagerIntent;
  }, [plan, planStaleReason, selectedTeamMemberIds]);
  const deployable = isTerritoryPlanDeployable(deploymentPlan, eligibleTeamIds);
  const activeDeployment = serverSession?.status === 'deployed';
  const closedDeployment = ['completed', 'recalled'].includes(serverSession?.status);
  const deployed = activeDeployment || closedDeployment;
  const mutationsLocked = deployed || generating || saving || deploying || packagePublishing || closing || resumingDraft;
  const crewAssignmentStatus = useMemo(
    () => getCanvasCrewAssignmentStatus(deploymentPlan || {}, selectedTeamMemberIds),
    [deploymentPlan, selectedTeamMemberIds],
  );
  const workloadDeviationStatus = useMemo(() => getCanvasWorkloadDeviation(deploymentPlan || {}), [deploymentPlan]);
  const planComplexityStatus = useMemo(() => getCanvasPlanComplexityStatus(deploymentPlan || {}), [deploymentPlan]);
  const planTooComplex = Boolean(plan && !planComplexityStatus.supported);
  const workloadDeviationUnavailable = Boolean(plan && !planStaleReason && !workloadDeviationStatus.verified);
  const workloadExceptionNeedsAcceptance = Boolean(
    plan
    && !planStaleReason
    && workloadDeviationStatus.verified
    && workloadDeviationStatus.value > 25
    && !workloadExceptionAccepted,
  );
  const sendable = deployable
    && !planStaleReason
    && crewAssignmentStatus.valid
    && !workloadDeviationUnavailable
    && !workloadExceptionNeedsAcceptance
    && !planTooComplex;
  const assignedZoneCount = zones.filter((zone) => eligibleTeamIds.has(String(zone.assigned_team_member_id || ''))).length;
  const otherActiveCampaigns = useMemo(() => campaignIndex.filter((campaign) => (
    campaign.status === 'deployed'
    && campaign.lifecycle_state === 'active'
    && campaignId(campaign) !== campaignId(serverSession)
  )), [campaignIndex, serverSession]);
  const selectedIndexedCampaign = otherActiveCampaigns.find((campaign) => campaignId(campaign) === selectedIndexedCampaignId)
    || otherActiveCampaigns[0]
    || null;
  const savedDrafts = useMemo(() => campaignIndex.filter((campaign) => (
    campaign.stored_status === 'draft'
    && campaignId(campaign) !== campaignId(serverSession)
  )), [campaignIndex, serverSession]);
  const selectedDraft = savedDrafts.find((campaign) => campaignId(campaign) === selectedDraftId)
    || savedDrafts[0]
    || null;
  const campaignSigningUnavailable = /lifecycle signing is not configured/i.test(campaignIndexError);

  useEffect(() => {
    const onRequestedView = (event) => {
      const nextView = event.detail?.view === 'areas' ? 'areas' : 'new_area';
      if (nextView === 'new_area' && event.detail?.startNew === true) {
        startAnotherAreaRef.current?.();
        return;
      }
      setWorkspaceView(nextView);
      try { sessionStorage.setItem('fk_canvasPlannerView', nextView); } catch {}
    };
    window.addEventListener('fk-canvas-planner-view-requested', onRequestedView);
    return () => window.removeEventListener('fk-canvas-planner-view-requested', onRequestedView);
  }, []);

  const hasUnsavedCanvasWork = !deployed && (plan
    ? draftDirty
    : polygon.length > 0
      || sessionName !== 'Canvas Cold Area'
      || Number(requestedAreaCount) !== 1);

  useEffect(() => {
    onDraftDirtyChange?.(hasUnsavedCanvasWork);
  }, [hasUnsavedCanvasWork, onDraftDirtyChange]);

  useEffect(() => () => onDraftDirtyChange?.(false), [onDraftDirtyChange]);

  useEffect(() => {
    if (!hasUnsavedCanvasWork) return undefined;
    const warnBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [hasUnsavedCanvasWork]);

  const generationBlockers = useMemo(() => {
    const blockers = [];
    const boundary = validateCanvasBoundary(polygon);
    if (!boundary.valid) blockers.push(boundary.message);
    if (roadFetchStatus === 'loading') blockers.push('Wait while Canvas identifies residential streets and opportunities.');
    if (roadFetchStatus === 'unavailable') blockers.push(roadFetchError?.message || 'Residential evidence is unavailable. Your boundary is preserved.');
    if (roadFetchStatus === 'empty') blockers.push(roadFetchError?.message || 'No verified residential street work was found inside this boundary.');
    if (roadFetchStatus !== 'ready' && boundary.valid && !['loading', 'unavailable', 'empty'].includes(roadFetchStatus)) blockers.push('Residential evidence loads after you draw the global area.');
    if (divisionBasis === 'selected_reps' && requestedZoneCount < 1) blockers.push('Select at least one active rep. Canvas creates one territory per selected rep.');
    if (divisionBasis === 'selected_reps' && requestedZoneCount > 250) blockers.push('Canvas supports at most 250 territories in one campaign.');
    if (divisionBasis === 'area_count' && (requestedAreaCount < 1 || requestedAreaCount > 250)) blockers.push('Choose between 1 and 250 territories.');
    if (divisionBasis === 'street_workload_target' && (targetStreetWorkloadMiles < 0.1 || targetStreetWorkloadMiles > 25)) blockers.push('Choose an approximate street workload between 0.1 and 25 miles per territory.');
    return blockers;
  }, [divisionBasis, polygon, requestedAreaCount, requestedZoneCount, roadFetchError?.message, roadFetchStatus, targetStreetWorkloadMiles]);

  const refreshCampaignIndex = useCallback(async () => {
    if (!user?.id) return setCampaignIndex([]);
    setCampaignIndexLoading(true);
    try {
      const result = await listMyCanvasCampaigns();
      setCampaignIndex(result.campaigns);
      setQuarantinableCampaignCount(Math.max(0, Number(result.quarantinable_campaigns) || 0));
      const warnings = [];
      if (Number(result.rejected_campaigns) > 0) warnings.push(`${result.rejected_campaigns} campaign record${result.rejected_campaigns === 1 ? '' : 's'} failed verification and were hidden.`);
      if (result.truncated) warnings.push('Only the newest 500 campaigns are shown.');
      setCampaignIndexError(warnings.join(' '));
    } catch (error) {
      setCampaignIndexError(error.message || 'Canvas campaigns could not be loaded.');
    } finally {
      setCampaignIndexLoading(false);
    }
  }, [user?.id]);

  const quarantineRejectedCampaigns = async () => {
    if (!quarantinableCampaignCount || quarantiningCampaigns || activeOperationRef.current) return;
    const confirmed = window.confirm(`Quarantine ${quarantinableCampaignCount} unsigned legacy Canvas record${quarantinableCampaignCount === 1 ? '' : 's'}? They will remain preserved for audit, but can never be active or sent to reps. Signed records are never changed by this recovery action.`);
    if (!confirmed) return;
    activeOperationRef.current = 'quarantine';
    setQuarantiningCampaigns(true);
    const toastId = toast.loading('Quarantining invalid Canvas records...');
    try {
      const result = await quarantineInvalidCanvasCampaigns();
      toast.success(`${result.quarantined_count || 0} unsigned legacy Canvas record${result.quarantined_count === 1 ? '' : 's'} quarantined.`, { id: toastId });
      await refreshCampaignIndex();
    } catch (error) {
      toast.error(error.message || 'Invalid Canvas records could not be quarantined.', { id: toastId });
    } finally {
      setQuarantiningCampaigns(false);
      if (activeOperationRef.current === 'quarantine') activeOperationRef.current = '';
    }
  };

  const publishZonePreview = useCallback((nextZones = [], nextWorkUnits = [], detail = {}) => {
    const preview = {
      zones: Array.isArray(nextZones) ? nextZones : [],
      workUnits: Array.isArray(nextWorkUnits) ? nextWorkUnits : [],
    };
    onPreviewChange?.(preview);
    window.dispatchEvent(new CustomEvent('fk-canvas-zones-updated', { detail: { ...preview, ...detail } }));
  }, [onPreviewChange]);

  const loadCampaignMap = useCallback(async (campaign, { quiet = false, progressOnly = false } = {}) => {
    const id = campaignId(campaign);
    if (!id) return;
    if (!quiet) setLiveMapLoading(true);
    try {
      const campaignModel = campaign?.territory_model
        || (id === campaignId(serverSession) ? plan?.territory_model : '');
      const residentialV2 = campaignModel === 'residential_street_territory_v2';
      if (progressOnly && residentialV2) {
        const summary = await getCanvasCampaignSummary({ campaignId: id });
        setLiveCampaignMap((current) => campaignId(current?.campaign) === id
          ? { ...current, ...canvasOperationalSummaryFields(summary) }
          : current);
        setLiveMapError('');
        if (id === campaignId(serverSession)) {
          const packageCounts = summary.assignment_counts || {};
          const ready = Number(packageCounts.total || 0) > 0
            && Number(packageCounts.package_ready || 0) === Number(packageCounts.total || 0);
          setPackagePublicationStatus(ready ? 'ready' : 'idle');
          if (ready) setPackagePublicationIssue('');
        }
        window.dispatchEvent(new CustomEvent('fk-canvas-viewport-refresh-requested'));
        if (!quiet) toast.success('Campaign progress refreshed.');
        return;
      }
      const [result, operationalSummary] = await Promise.all([
        getCanvasCampaignMap({ campaignId: id, includePins: !residentialV2 }),
        residentialV2 ? getCanvasCampaignSummary({ campaignId: id }) : Promise.resolve(null),
      ]);
      const resultZones = campaignZones(result).map((zone) => {
        const assignmentId = String(zone.assigned_team_member_id || '');
        const member = rosterMembersById.get(assignmentId);
        return {
          ...zone,
          assignments: assignmentId ? [assignmentId] : [],
          assigned_team_member_ids: assignmentId ? [assignmentId] : [],
          assigned_to_name: assignmentId ? member?.name || member?.email || `Assigned rep · ${assignmentId.slice(-6)}` : '',
        };
      });
      const visibleResult = {
        ...result,
        campaign: result.campaign ? { ...result.campaign, zones: resultZones } : result.campaign,
        zones: resultZones,
        pins: residentialV2 ? [] : (result.pins || []).map((pin) => ({
          ...pin,
          last_actor_name: rosterMembersById.get(String(pin.last_actor_team_member_id || ''))?.name || '',
        })),
        ...canvasOperationalSummaryFields(operationalSummary),
      };
      if (operationalSummary && id === campaignId(serverSession)) {
        const packageCounts = operationalSummary.assignment_counts || {};
        const ready = Number(packageCounts.total || 0) > 0
          && Number(packageCounts.package_ready || 0) === Number(packageCounts.total || 0);
        setPackagePublicationStatus(ready ? 'ready' : 'idle');
        if (ready) setPackagePublicationIssue('');
      }
      setLiveCampaignMap(visibleResult);
      setLiveMapError('');
      publishZonePreview(resultZones, result.campaign?.work_units || [], { previewOnly: false });
      window.dispatchEvent(new CustomEvent('fk-canvas-campaign-map-updated', { detail: visibleResult }));
      if (!quiet) toast.success('Shared campaign map loaded.');
    } catch (error) {
      setLiveMapError(error.message || 'The shared campaign map could not be loaded.');
      if (!quiet) toast.error(error.message || 'The shared campaign map could not be loaded.');
    } finally {
      if (!quiet) setLiveMapLoading(false);
    }
  }, [plan?.territory_model, publishZonePreview, rosterMembersById, serverSession]);

  useEffect(() => { refreshCampaignIndex(); }, [refreshCampaignIndex]);

  useEffect(() => {
    if (otherActiveCampaigns.some((campaign) => campaignId(campaign) === selectedIndexedCampaignId)) return;
    setSelectedIndexedCampaignId(campaignId(otherActiveCampaigns[0]));
  }, [otherActiveCampaigns, selectedIndexedCampaignId]);

  useEffect(() => {
    if (savedDrafts.some((campaign) => campaignId(campaign) === selectedDraftId)) return;
    setSelectedDraftId(campaignId(savedDrafts[0]));
  }, [savedDrafts, selectedDraftId]);

  useEffect(() => {
    const id = campaignId(liveCampaignMap?.campaign);
    if (!id) return undefined;
    const campaign = { campaign_id: id };
    const refresh = () => loadCampaignMap(campaign, { quiet: true, progressOnly: true });
    const interval = window.setInterval(refresh, CAMPAIGN_REFRESH_MS);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [liveCampaignMap?.campaign, loadCampaignMap]);

  useEffect(() => {
    const handleViewportStatus = (event) => {
      const detail = event.detail || {};
      const id = campaignId(liveCampaignMap?.campaign);
      if (!id || String(detail.campaignId || '') !== id) return;
      setLiveCampaignMap((current) => campaignId(current?.campaign) === id
        ? { ...current, viewport_status: detail, truncated: detail.truncated ? { viewport: true } : false }
        : current);
      if (detail.error) setLiveMapError(detail.error);
      else if (detail.truncated) setLiveMapError('This view contains more than 5,000 decisions. Zoom in to inspect every house safely.');
      else setLiveMapError('');
    };
    window.addEventListener('fk-canvas-viewport-status', handleViewportStatus);
    return () => window.removeEventListener('fk-canvas-viewport-status', handleViewportStatus);
  }, [liveCampaignMap?.campaign]);

  useEffect(() => {
    const validIds = new Set(activeTeamMembers.map((member) => String(member.id)));
    setSelectedTeamMemberIds((current) => current.filter((id) => validIds.has(String(id))));
    if (deployed) return;
    setPlan((current) => {
      const reconciliation = reconcileCanvasPlanWithEligibleTeam(current, activeTeamMembers);
      if (!reconciliation.changed) return current;
      deploymentAttemptRef.current = null;
      setDraftDirty(true);
      if (reconciliation.requiresRegeneration) setPlanStaleReason('The selected-rep roster changed; regenerate the territories before deployment.');
      return reconciliation.plan;
    });
  }, [activeTeamMembers, deployed]);

  useEffect(() => {
    if (previousPolygonKey.current === polygonKey) return;
    plannerAbortRef.current?.abort();
    roadFetchAbortRef.current?.abort();
    previousPolygonKey.current = polygonKey;
    setResidentialAnalysis(null);
    setClassificationUnitId('');
    setClassificationRole('knock');
    setClassificationOpportunityCount('');
    setClassificationReason('');
    setServerAnalysisJobId('');
    setPlan(null);
    setPlanGenerationError(null);
    setServerSession(null);
    setSelectedZoneNumber(null);
    setLiveCampaignMap(null);
    setDraftDirty(false);
    lastGeneratedPreviewRevisionRef.current = -1;
    lastAttemptedPreviewRevisionRef.current = -1;
    window.dispatchEvent(new CustomEvent('fk-canvas-campaign-map-updated', { detail: null }));
  }, [polygonKey]);

  useEffect(() => {
    setWorkloadExceptionAccepted(plan?.qa?.manager_workload_exception_acknowledged === true);
  }, [plan?.data_version]);

  useEffect(() => {
    roadFetchAbortRef.current?.abort();
    if (!polygon.length) {
      setResidentialAnalysis(null);
      setRoadFetchStatus('idle');
      setRoadFetchError(null);
      setRoadFetchProgress(null);
      setServerAnalysisJobId('');
      return undefined;
    }
    const boundary = validateCanvasBoundary(polygon);
    if (!boundary.valid) {
      setResidentialAnalysis(null);
      setRoadFetchStatus('invalid');
      setRoadFetchError({ code: boundary.code, message: boundary.message });
      setRoadFetchProgress(null);
      return undefined;
    }
    const abortController = new AbortController();
    roadFetchAbortRef.current = abortController;
    setRoadFetchStatus('loading');
    setRoadFetchError(null);
    setRoadFetchProgress(null);
    setResidentialAnalysis(null);
    const persisted = resumedAnalysisJobRef.current;
    const resumeJobId = persisted && polygonKeyFor(persisted.polygon) === polygonKey
      ? persisted.jobId
      : null;
    analyzeCanvasBoundary({
      polygon,
      areaCount: 1,
      resumeJobId,
      signal: abortController.signal,
      onProgress: (progress) => {
        if (abortController.signal.aborted) return;
        const jobId = String(progress?.job_id || '');
        if (jobId) {
          setServerAnalysisJobId(jobId);
          persistCanvasAnalysisJob({
            managerId: user?.id,
            jobId,
            polygon,
            areaCount: requestedZoneCount,
          });
        }
        setRoadFetchProgress({
          completed: Math.max(0, Number(progress?.completed_tile_count || 0)),
          total: Math.max(1, Number(progress?.tile_count || 1)),
          percent: Math.max(0, Math.min(100, Number(progress?.progress_pct || 0))),
          status: progress?.status || 'running',
        });
      },
    })
      .then(async (completed) => {
        if (abortController.signal.aborted) return;
        const evidenceId = String(completed?.evidence_id || completed?.evidence?.evidence_id || '');
        const loaded = evidenceId && !completed?.analysis_result && !completed?.analysis
          ? await getCanvasAnalysis({ evidenceId })
          : null;
        if (abortController.signal.aborted) return;
        const analysis = residentialAnalysisFromServer(completed, loaded);
        const streetUnits = planResidentialStreetUnits(analysis);
        if (!streetUnits.length) {
          setResidentialAnalysis(analysis);
          setRoadFetchStatus('empty');
          setRoadFetchError({
            code: 'CANVAS_RESIDENTIAL_EVIDENCE_EMPTY',
            message: 'No classified street evidence was found inside this boundary. Redraw around a neighborhood or check the evidence release coverage.',
          });
          return;
        }
        setResidentialAnalysis(analysis);
        setRoadFetchStatus('ready');
        setRoadFetchError(null);
        setRoadFetchProgress(null);
        setServerAnalysisJobId('');
        clearPersistedCanvasAnalysisJob(user?.id, completed?.job_id || resumeJobId);
        resumedAnalysisJobRef.current = null;
      })
      .catch((error) => {
        if (abortController.signal.aborted || error?.code === 'CANVAS_ANALYSIS_CANCELLED') return;
        setRoadFetchStatus('unavailable');
        setRoadFetchError(error);
        setRoadFetchProgress(null);
      });
    return () => {
      abortController.abort();
      if (roadFetchAbortRef.current === abortController) roadFetchAbortRef.current = null;
    };
  }, [polygonKey, roadFetchNonce, user?.id]);

  useEffect(() => {
    const fitPreview = fitNextPreviewRef.current && zones.length > 0;
    fitNextPreviewRef.current = false;
    publishZonePreview(zones, plan?.work_units || [], { previewOnly: !deployed, fitPreview });
  }, [deployed, plan?.work_units, publishZonePreview, zones]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('fk-canvas-residential-analysis-updated', {
      detail: { analysis: residentialAnalysis },
    }));
    return () => window.dispatchEvent(new CustomEvent('fk-canvas-residential-analysis-updated', {
      detail: { analysis: null },
    }));
  }, [residentialAnalysis]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('fk-canvas-zone-selected', { detail: { zoneNumber: selectedZoneNumber } }));
  }, [selectedZoneNumber]);

  useEffect(() => {
    const selectClassificationUnit = (unitId) => {
      const id = String(unitId || '');
      const unit = classifiedStreetUnits.find((candidate) => candidate.id === id);
      if (!unit || unit.canvas_role !== 'uncertain') return;
      setClassificationUnitId(id);
      setClassificationRole('knock');
      setClassificationOpportunityCount('');
      setClassificationReason('');
      setMobileCollapsed(false);
      window.dispatchEvent(new CustomEvent('fk-canvas-classification-unit-selected', { detail: { unitId: id } }));
    };
    const handleMapRequest = (event) => selectClassificationUnit(event.detail?.unitId);
    window.addEventListener('fk-canvas-classification-unit-requested', handleMapRequest);
    return () => window.removeEventListener('fk-canvas-classification-unit-requested', handleMapRequest);
  }, [classifiedStreetUnits]);

  useEffect(() => {
    const handleSelection = (event) => {
      const zoneNumber = Number(event.detail?.zoneNumber);
      if (Number.isFinite(zoneNumber)) setSelectedZoneNumber(zoneNumber);
    };
    window.addEventListener('fk-canvas-zone-selected', handleSelection);
    return () => window.removeEventListener('fk-canvas-zone-selected', handleSelection);
  }, []);

  const markPlanStale = (message) => {
    if (!plan || deployed || (activeOperationRef.current && activeOperationRef.current !== 'generate')) return;
    setPlanStaleReason(message);
    setDraftDirty(true);
    deploymentAttemptRef.current = null;
  };

  const reconcileFlexibleAssignments = (allowedTeamMemberIds) => {
    if (!plan || deployed || activeOperationRef.current || divisionBasis === 'selected_reps') return;
    const allowed = new Set((allowedTeamMemberIds || []).map(String));
    setPlan((current) => withAssignmentGate({
      ...current,
      selected_team_member_ids: [...allowed],
      zones: current.zones.map((zone) => {
        const assignedId = String(zone.assigned_team_member_id || '');
        return assignedId && !allowed.has(assignedId)
          ? updateCanvasZoneAssignment(zone, '', activeTeamMembers)
          : zone;
      }),
    }));
    setDraftDirty(true);
    deploymentAttemptRef.current = null;
  };

  const toggleTeamMember = (teamMemberId) => {
    if (deployed || activeOperationRef.current) return;
    const id = String(teamMemberId);
    const nextIds = selectedTeamMemberIds.includes(id)
      ? selectedTeamMemberIds.filter((value) => value !== id)
      : [...selectedTeamMemberIds, id];
    setSelectedTeamMemberIds(nextIds);
    if (plan) setDraftDirty(true);
    if (divisionBasis === 'selected_reps') {
      markPlanStale('The selected reps changed; regenerate one territory per rep.');
    }
    else reconcileFlexibleAssignments(nextIds);
  };

  const replaceTeamMemberSelection = (teamMemberIds) => {
    if (deployed || activeOperationRef.current) return;
    const validIds = new Set(activeTeamMembers.map((member) => String(member.id)));
    const nextIds = [...new Set((teamMemberIds || []).map(String).filter((id) => validIds.has(id)))];
    setSelectedTeamMemberIds(nextIds);
    if (plan) setDraftDirty(true);
    deploymentAttemptRef.current = null;
    if (divisionBasis === 'selected_reps') {
      markPlanStale('The selected reps changed; regenerate one territory per rep.');
    }
    else reconcileFlexibleAssignments(nextIds);
  };

  const changeDivisionBasis = (nextBasis) => {
    if (deployed || activeOperationRef.current || nextBasis === divisionBasis) return;
    if (nextBasis === 'area_count') {
      const crewSize = selectedTeamMemberIds.length || activeTeamMembers.length || requestedAreaCount || 1;
      setRequestedAreaCount(Math.max(1, Math.min(250, crewSize)));
    }
    setDivisionBasis(nextBasis);
    if (nextBasis === 'area_count') setLivePreviewRevision((value) => value + 1);
    markPlanStale('The planning goal changed; create the territories again.');
  };

  const changeSessionName = (value) => {
    if (deployed || activeOperationRef.current) return;
    setSessionName(value);
    if (plan) setDraftDirty(true);
    deploymentAttemptRef.current = null;
  };

  const toggleZoneLock = (zone) => {
    const zoneId = String(zone?.zone_id || '');
    if (!zoneId || deployed) return;
    setLockedZoneIds((current) => {
      const next = new Set(current);
      if (next.has(zoneId)) next.delete(zoneId);
      else next.add(zoneId);
      return next;
    });
  };

  const mergeZoneInto = (zone, target) => {
    if (!zone || !target || deployed) return;
    const merged = mergeCanvasResidentialZones({
      street_units: planResidentialStreetUnits(residentialAnalysis),
      zones: plan?.zones || [],
      zone_id_a: zone.zone_id,
      zone_id_b: target.zone_id,
    });
    if (!merged.ok) {
      // Refusing is the correct outcome, so say why rather than failing quietly.
      return toast.error(merged.code === 'MERGE_ZONES_NOT_ADJACENT'
        ? `Area ${zone.zone_number} and Area ${target.zone_number} do not touch. Merging them would create a territory nobody can walk end to end.`
        : 'Canvas could not merge those two areas.');
    }
    setLockedZoneIds((current) => {
      const next = new Set(current);
      next.delete(String(target.zone_id));
      next.add(String(merged.merged_zone.zone_id));
      return next;
    });
    mergedZoneOverrideRef.current = merged.merged_zone;
    toast.success(`Merged Area ${target.zone_number} into Area ${zone.zone_number}.`);
    changeRequestedAreaCount(Math.max(1, (plan?.zones?.length || 1) - 1));
  };

  const changeRequestedAreaCount = (value) => {
    if (deployed || (activeOperationRef.current && activeOperationRef.current !== 'generate')) return;
    if (activeOperationRef.current === 'generate') plannerAbortRef.current?.abort();
    setRequestedAreaCount(value);
    setPlanGenerationError(null);
    setLivePreviewRevision((current) => current + 1);
    markPlanStale('The number of areas changed; Canvas is updating the preview.');
  };

  const changeTargetStreetWorkloadMiles = (value) => {
    if (deployed || activeOperationRef.current) return;
    setTargetStreetWorkloadMiles(value);
    markPlanStale('The workload target changed; create the territories again.');
  };

  const changeWorkloadExceptionAcceptance = (accepted) => {
    if (deployed || activeOperationRef.current) return;
    setWorkloadExceptionAccepted(accepted);
    if (plan) setDraftDirty(true);
    deploymentAttemptRef.current = null;
  };

  const cancelResidentialAnalysis = async ({ quiet = false } = {}) => {
    const jobId = serverAnalysisJobId || resumedAnalysisJobRef.current?.jobId;
    roadFetchAbortRef.current?.abort();
    if (!jobId) return true;
    setCancellingServerAnalysis(true);
    try {
      await cancelCanvasAnalysis({ jobId });
      clearPersistedCanvasAnalysisJob(user?.id, jobId);
      resumedAnalysisJobRef.current = null;
      setServerAnalysisJobId('');
      if (!quiet) toast.success('Canvas analysis cancelled. Your drawn boundary is still here.');
      return true;
    } catch (error) {
      // `quiet` suppresses the success toast, never a failure. A cancel that
      // fails silently is what made Redraw and Clear look broken.
      toast.error(error?.message || 'Canvas could not cancel the analysis.');
      return false;
    } finally {
      setCancellingServerAnalysis(false);
    }
  };

  const refreshRoadData = async () => {
    if (deployed || activeOperationRef.current) return;
    await cancelResidentialAnalysis({ quiet: true });
    if (plan) {
      setPlanStaleReason('Residential evidence is refreshing; update the preview after it loads.');
      setDraftDirty(true);
      deploymentAttemptRef.current = null;
    }
    clearPersistedCanvasAnalysisJob(user?.id);
    setPlanGenerationError(null);
    setRoadFetchNonce((value) => value + 1);
  };

  const applyClassificationReview = async () => {
    if (!selectedClassificationUnit || selectedClassificationUnit.canvas_role !== 'uncertain') {
      return toast.error('Tap an amber street on the map before saving a review.');
    }
    if (activeOperationRef.current) return toast.error('Wait for the current Canvas action to finish.');
    const role = String(classificationRole || '');
    if (!['knock', 'transit_only', 'excluded'].includes(role)) return toast.error('Choose whether this street contains homes, is travel-only, or should be excluded.');
    const opportunityCount = Number(classificationOpportunityCount);
    if (role === 'knock' && (!Number.isInteger(opportunityCount) || opportunityCount < 1 || opportunityCount > 10_000)) {
      return toast.error('Enter the number of likely knockable homes for this residential street.');
    }
    const reason = classificationReason.trim();
    if (reason.length < 10) return toast.error('Add a short reason so this classification change has an audit trail.');
    const evidenceId = String(residentialAnalysis?.evidence_id || '');
    if (!evidenceId) return toast.error('The signed Canvas evidence snapshot is missing. Analyze the boundary again.');
    activeOperationRef.current = 'classification';
    setClassificationSaving(true);
    const toastId = toast.loading('Saving the reviewed street classification...');
    try {
      const revised = await applyCanvasClassificationOverride({
        evidenceId,
        parentRevisionId: residentialAnalysis?.revision_id || null,
        streetUnitId: selectedClassificationUnit.id,
        canvasRole: role,
        opportunityCount: role === 'knock' ? opportunityCount : 0,
        reason,
      });
      const revisionId = String(revised?.revision_id || revised?.head_revision_id || '');
      if (!revisionId) throw new Error('Canvas did not return the saved classification revision.');
      const loaded = await getCanvasAnalysis({ evidenceId, revisionId, useRevisionHead: false });
      const nextAnalysis = residentialAnalysisFromServer(revised, loaded);
      const partitionAreaCount = Math.max(1, Number(requestedZoneCount || requestedAreaCount || 1));
      const partition = await partitionCanvasResidentialTerritoriesAsync({
        street_units: planResidentialStreetUnits(nextAnalysis),
        area_count: partitionAreaCount,
      });
      const failure = getCanvasPlannerFailureMessage(partition);
      if (failure || !partition?.ok) {
        setResidentialAnalysis(nextAnalysis);
        setPlan(null);
        setPlanGenerationError({
          code: String(partition?.code || 'CANVAS_PLANNER_FAILED'),
          message: residentialPartitionFailure(partition) || failure,
          details: partition?.details || {},
        });
        setPlanStaleReason('The reviewed evidence changed the eligible residential work. Choose a supported area count and create the preview again.');
      } else {
        const nextPlan = buildResidentialTerritoryPlan(nextAnalysis, partitionAreaCount, partition);
        const complexity = getCanvasPlanComplexityStatus(nextPlan);
        if (!complexity.supported) throw new Error(complexity.message);
        setResidentialAnalysis(nextAnalysis);
        setPlan(nextPlan);
        setPlanGenerationError(null);
        setPlanStaleReason('');
        setSelectedZoneNumber(nextPlan.zones[0]?.zone_number || null);
        lastGeneratedPreviewRevisionRef.current = livePreviewRevision;
        lastAttemptedPreviewRevisionRef.current = livePreviewRevision;
        fitNextPreviewRef.current = true;
      }
      setSelectedTeamMemberIds([]);
      setWorkloadExceptionAccepted(false);
      setLiveCampaignMap(null);
      setDraftDirty(true);
      deploymentAttemptRef.current = null;
      setClassificationUnitId('');
      setClassificationOpportunityCount('');
      setClassificationReason('');
      window.dispatchEvent(new CustomEvent('fk-canvas-classification-unit-selected', { detail: { unitId: null } }));
      toast.success(failure || !partition?.ok
        ? 'Street review saved. Update the area count and preview the reviewed evidence again.'
        : 'Street review saved. Canvas rebuilt the unassigned area preview from the reviewed evidence.', { id: toastId });
    } catch (error) {
      toast.error(error?.message || 'The street classification could not be saved.', { id: toastId });
    } finally {
      setClassificationSaving(false);
      if (activeOperationRef.current === 'classification') activeOperationRef.current = '';
    }
  };

  const refreshTeamRoster = async () => {
    if (typeof onRefreshTeamMembers !== 'function' || teamRosterRefreshing) return;
    setTeamRosterRefreshing(true);
    try {
      const result = await onRefreshTeamMembers();
      if (result?.error) throw result.error;
      toast.success('Rep roster refreshed.');
    } catch (error) {
      toast.error(error?.message || 'The rep roster could not be refreshed.');
    } finally {
      setTeamRosterRefreshing(false);
    }
  };

  const generatePlan = async ({ quiet = false } = {}) => {
    if (livePreviewTimerRef.current) {
      window.clearTimeout(livePreviewTimerRef.current);
      livePreviewTimerRef.current = null;
    }
    if (activeOperationRef.current) return toast.error('Wait for the current Canvas action to finish.');
    if (generationBlockers.length) return toast.error(generationBlockers[0]);
    if (!residentialAnalysis) return toast.error('Wait for residential evidence before creating the preview.');
    activeOperationRef.current = 'generate';
    setGenerating(true);
    setPlanGenerationError(null);
    const toastId = quiet ? null : toast.loading('Dividing the work area along connected streets...');
    const abortController = new AbortController();
    plannerAbortRef.current = abortController;
    const requestSnapshot = {
      polygon,
      residentialAnalysis,
      requestedZoneCount,
      lockedZones: lockedZonesFromPlan(plan, lockedZoneIds, mergedZoneOverrideRef.current),
      livePreviewRevision,
      sessionName,
      sessionId: serverSession?.session_id,
      expectedVersion: serverSession?.version,
    };
    lastAttemptedPreviewRevisionRef.current = requestSnapshot.livePreviewRevision;
    try {
      const result = await partitionCanvasResidentialTerritoriesAsync({
        street_units: planResidentialStreetUnits(requestSnapshot.residentialAnalysis),
        area_count: requestSnapshot.requestedZoneCount,
        locked_zones: requestSnapshot.lockedZones,
      }, { signal: abortController.signal });
      const failure = getCanvasPlannerFailureMessage(result);
      if (failure || !result?.ok) throw canvasPlannerError(result, residentialPartitionFailure(result) || failure);
      const nextPlan = buildResidentialTerritoryPlan(requestSnapshot.residentialAnalysis, requestSnapshot.requestedZoneCount, result);
      if (!nextPlan.zones.length) throw new Error('The planner did not produce any connected areas.');
      if (nextPlan.zones.length > 250) throw new Error('This plan creates more than 250 areas. Choose fewer subdivisions and generate again.');
      const complexityStatus = getCanvasPlanComplexityStatus(nextPlan);
      if (!complexityStatus.supported) throw new Error(complexityStatus.message);
      const previewPayloadBytes = canvasDraftPayloadBytes(buildCanvasDraftPayload({
        sessionId: requestSnapshot.sessionId,
        expectedVersion: requestSnapshot.expectedVersion,
        sessionName: requestSnapshot.sessionName,
        polygon: requestSnapshot.polygon,
        plan: nextPlan,
      }));
      if (previewPayloadBytes > MAX_CANVAS_PREVIEW_JSON_BYTES) {
        const error = new Error('This street plan is larger than the secure Canvas draft limit. Reduce the drawn boundary, then create the preview again.');
        error.code = 'CANVAS_DRAFT_TOO_LARGE';
        error.details = {
          serialized_byte_count: previewPayloadBytes,
          maximum_serialized_byte_count: MAX_CANVAS_PREVIEW_JSON_BYTES,
        };
        throw error;
      }
      lastGeneratedPreviewRevisionRef.current = requestSnapshot.livePreviewRevision;
      fitNextPreviewRef.current = true;
      setPlan(nextPlan);
      // The merged area now exists in the plan, so the one-shot override is spent.
      mergedZoneOverrideRef.current = null;
      setPlanGenerationError(null);
      if (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1023px)').matches) setMobileCollapsed(true);
      setWorkloadExceptionAccepted(false);
      setPlanStaleReason('');
      setLiveCampaignMap(null);
      setDraftDirty(true);
      deploymentAttemptRef.current = null;
      setSelectedZoneNumber(nextPlan.zones[0]?.zone_number || null);
      if (!quiet) toast.success(`${nextPlan.zones.length} connected areas are ready to review.`, { id: toastId });
    } catch (error) {
      if (error?.name === 'AbortError' || error?.code === 'CANVAS_PLANNER_ABORTED') {
        if (toastId) toast.dismiss(toastId);
      } else {
        const plannerError = canvasPlannerError(error);
        setPlanGenerationError({
          code: String(plannerError.code || 'CANVAS_PLANNER_FAILED'),
          message: plannerError.message || 'Canvas planning failed.',
          details: plannerError.details && typeof plannerError.details === 'object' ? plannerError.details : {},
        });
        toast.error(plannerError.message || 'Canvas planning failed.', toastId ? { id: toastId } : undefined);
      }
    } finally {
      setGenerating(false);
      if (plannerAbortRef.current === abortController) plannerAbortRef.current = null;
      if (activeOperationRef.current === 'generate') activeOperationRef.current = '';
    }
  };

  useEffect(() => {
    if (divisionBasis !== 'area_count' || roadFetchStatus !== 'ready' || generationBlockers.length || deployed || generating) return undefined;
    if (!plan || !planStaleReason || livePreviewRevision <= lastAttemptedPreviewRevisionRef.current) return undefined;
    const timer = window.setTimeout(() => {
      if (livePreviewTimerRef.current === timer) livePreviewTimerRef.current = null;
      if (!activeOperationRef.current) generatePlan({ quiet: true });
    }, 600);
    livePreviewTimerRef.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (livePreviewTimerRef.current === timer) livePreviewTimerRef.current = null;
    };
  }, [divisionBasis, generating, livePreviewRevision, plan, planStaleReason, polygonKey, roadFetchStatus, residentialAnalysis, generationBlockers, deployed]);

  useEffect(() => () => {
    if (livePreviewTimerRef.current) window.clearTimeout(livePreviewTimerRef.current);
    plannerAbortRef.current?.abort();
  }, []);

  const autoAssign = () => {
    if (!plan || deployed || activeOperationRef.current) return;
    const assignmentPool = selectedTeamMemberIds;
    if (!assignmentPool.length) return toast.error('Choose the reps who should receive these territories first.');
    if (assignmentPool.length > zones.length) return toast.error(`Choose at most ${zones.length} reps for ${zones.length} territories.`);
    setPlan((current) => planWithAssignments({ ...current, selected_team_member_ids: assignmentPool }, assignmentPool, activeTeamMembers));
    setDraftDirty(true);
    deploymentAttemptRef.current = null;
    toast.success(`${zones.length} areas assigned across ${assignmentPool.length} selected rep${assignmentPool.length === 1 ? '' : 's'}.`);
  };

  const updateZoneAssignment = (zoneNumber, teamMemberId) => {
    if (!plan || deployed || activeOperationRef.current) return;
    const nextSelectedIds = teamMemberId
      ? [...new Set([...selectedTeamMemberIds, String(teamMemberId)])]
      : selectedTeamMemberIds;
    if (teamMemberId) setSelectedTeamMemberIds(nextSelectedIds);
    setPlan((current) => withAssignmentGate({
      ...current,
      selected_team_member_ids: nextSelectedIds,
      zones: current.zones.map((zone) => Number(zone.zone_number) === Number(zoneNumber)
        ? updateCanvasZoneAssignment(zone, teamMemberId, activeTeamMembers)
        : zone),
    }));
    setDraftDirty(true);
    deploymentAttemptRef.current = null;
  };

  const confirmDiscardUnsaved = useCallback((action) => {
    if (!hasUnsavedCanvasWork) return true;
    return window.confirm(`You have unsaved Canvas territory changes. ${action} will discard them. Continue?`);
  }, [hasUnsavedCanvasWork]);

  const closePlanner = () => {
    if (confirmDiscardUnsaved('Closing the planner')) onClose?.();
  };

  const changeWorkspaceView = (nextView) => {
    const normalizedView = nextView === 'areas' ? 'areas' : 'new_area';
    setWorkspaceView(normalizedView);
    try { sessionStorage.setItem('fk_canvasPlannerView', normalizedView); } catch {}
  };

  // Redraw and Clear act on the locally drawn boundary, so they must never be
  // blocked by the outcome of a server-side cancel. A job that has already
  // failed or finished cannot be cancelled, and treating that as a reason to
  // abort left both buttons as silent no-ops with no feedback at all — the
  // manager's only route out of a failed analysis was reloading the page.
  //
  // The cancel is still attempted, so a running job is stopped rather than left
  // to write a result nobody wants, and any failure is surfaced instead of
  // swallowed. The boundary is client state; clearing it is always allowed.
  const redrawArea = async () => {
    if (!confirmDiscardUnsaved('Redrawing the work area')) return;
    await cancelResidentialAnalysis({ quiet: true });
    onDraw?.();
  };

  const clearArea = async () => {
    if (!confirmDiscardUnsaved('Clearing the work area')) return;
    await cancelResidentialAnalysis({ quiet: true });
    clearPersistedCanvasAnalysisJob(user?.id);
    onClearPolygon?.();
  };

  const persistDraft = async ({ quiet = false, withinDeploy = false } = {}) => {
    if (!deploymentPlan) return null;
    if (planTooComplex) {
      if (!quiet) toast.error(planComplexityStatus.message);
      return null;
    }
    if (activeOperationRef.current && !withinDeploy) {
      if (!quiet) toast.error('Wait for the current Canvas action to finish.');
      return null;
    }
    const ownsOperationLock = !withinDeploy;
    if (ownsOperationLock) activeOperationRef.current = 'save';
    setSaving(true);
    const toastId = quiet ? null : toast.loading('Saving the Canvas area plan...');
    try {
      const auditedPlan = {
        ...deploymentPlan,
        selected_team_member_ids: selectedTeamMemberIds,
        qa: {
          ...(deploymentPlan.qa || {}),
          manager_workload_exception_acknowledged: workloadDeviationStatus.verified
            && workloadDeviationStatus.value > 25
            && workloadExceptionAccepted,
          manager_workload_exception_deviation_percent: workloadDeviationStatus.verified
            ? workloadDeviationStatus.value
            : null,
        },
      };
      const payload = buildCanvasDraftPayload({
        sessionId: serverSession?.session_id,
        expectedVersion: serverSession?.version,
        sessionName,
        polygon,
        plan: auditedPlan,
      });
      if (canvasDraftPayloadBytes(payload) > MAX_CANVAS_DRAFT_JSON_BYTES) {
        throw new Error('This Canvas draft is too large to save as one campaign. Draw a smaller work area and create the territories again.');
      }
      const saved = await saveCanvasDraft(payload);
      setServerSession(saved);
      setPlan((current) => current ? { ...current, qa: { ...current.qa, ...(saved.qa || {}) } } : current);
      setDraftDirty(false);
      refreshCampaignIndex();
      if (!quiet) toast.success(`Area plan saved · version ${saved.version}`, { id: toastId });
      return saved;
    } catch (error) {
      toast.error(error.message, toastId ? { id: toastId } : undefined);
      return null;
    } finally {
      setSaving(false);
      if (ownsOperationLock && activeOperationRef.current === 'save') activeOperationRef.current = '';
    }
  };

  const resumeDraft = async (draft = selectedDraft) => {
    const id = campaignId(draft);
    if (!id || resumingDraft || activeOperationRef.current) return;
    if (!confirmDiscardUnsaved('Opening this saved draft')) return;
    if (!teamMembersReady) return toast.error('Wait for the current Canvas rep roster to finish loading before resuming this draft.');
    activeOperationRef.current = 'resume';
    setResumingDraft(true);
    const toastId = toast.loading('Opening saved Canvas draft...');
    try {
      const result = await getCanvasCampaignMap({ campaignId: id });
      const campaign = result.campaign;
      if (campaignId(campaign) !== id) throw new Error('The server returned a different Canvas draft than the one selected.');
      const serverVersion = Number(campaign?.version);
      if (!Number.isInteger(serverVersion) || serverVersion < 1) throw new Error('This saved draft is missing a valid server version and cannot be resumed safely.');
      const boundary = validateCanvasBoundary(campaign?.polygon);
      if (!boundary.valid) throw new Error(`This saved draft has an invalid boundary. ${boundary.message}`);
      const restored = restoreCanvasDraftPlan(campaign, teamMembers);
      const reconciliation = reconcileCanvasPlanWithEligibleTeam(restored, activeTeamMembers);
      const restoredPlan = withAssignmentGate(reconciliation.plan);
      const divisionMode = restoredPlan.division_mode || 'area_count';
      if (typeof onResumeBoundary !== 'function') throw new Error('Canvas cannot restore this boundary in the current map session.');
      onResumeBoundary(boundary.points);
      previousPolygonKey.current = polygonKeyFor(boundary.points);
      setSessionName(campaign.session_name || draft?.session_name || 'Canvas Cold Area');
      setDivisionBasis(divisionMode);
      const restoredCrewIds = divisionMode === 'selected_reps'
        ? restoredPlan.selected_team_member_ids || []
        : restoredPlan.selected_team_member_ids?.length
          ? restoredPlan.selected_team_member_ids
          : [...new Set((restoredPlan.zones || []).map((zone) => String(zone.assigned_team_member_id || '')).filter(Boolean))];
      setSelectedTeamMemberIds(restoredCrewIds);
      setRequestedAreaCount(restoredPlan.zones.length);
      if (divisionMode === 'street_workload_target' && Number(restoredPlan.target_workload) > 0) {
        setTargetStreetWorkloadMiles(Number((Number(restoredPlan.target_workload) / 1609.344).toFixed(2)));
      }
      setPlan(restoredPlan);
      lastGeneratedPreviewRevisionRef.current = livePreviewRevision;
      lastAttemptedPreviewRevisionRef.current = livePreviewRevision;
      setWorkloadExceptionAccepted(restoredPlan.qa?.manager_workload_exception_acknowledged === true);
      setDraftDirty(false);
      setPlanStaleReason(reconciliation.requiresRegeneration
        ? 'The selected-rep roster changed after this draft was saved. Regenerate before deployment.'
        : '');
      setServerSession({
        session_id: campaign.campaign_id,
        campaign_id: campaign.campaign_id,
        session_name: campaign.session_name,
        status: 'draft',
        version: serverVersion,
        qa: campaign.qa || {},
      });
      setSelectedZoneNumber(restoredPlan.zones[0]?.zone_number || null);
      setLiveCampaignMap(null);
      setLiveMapError('');
      deploymentAttemptRef.current = null;
      setWorkspaceView('areas');
      try { sessionStorage.setItem('fk_canvasPlannerView', 'areas'); } catch {}
      window.dispatchEvent(new CustomEvent('fk-canvas-campaign-map-updated', { detail: null }));
      toast.success(`Draft restored · server version ${campaign.version}`, { id: toastId });
    } catch (error) {
      toast.error(error.message || 'Canvas draft could not be restored.', { id: toastId });
    } finally {
      setResumingDraft(false);
      if (activeOperationRef.current === 'resume') activeOperationRef.current = '';
    }
  };

  const publishRepPackages = async (campaign = serverSession, { toastId = null } = {}) => {
    const id = campaignId(campaign);
    if (!id || campaign?.status !== 'deployed') throw new Error('Deploy this Canvas campaign before publishing rep packages.');
    const reusableAttempt = packagePublicationAttemptRef.current;
    const attempt = reusableAttempt?.campaignId === id
      ? reusableAttempt
      : { campaignId: id, idempotencyKey: makeIdempotencyKey() };
    packagePublicationAttemptRef.current = attempt;
    setPackagePublishing(true);
    setPackagePublicationStatus('publishing');
    setPackagePublicationIssue('');
    if (toastId) toast.loading('Building signed offline maps for every assigned rep...', { id: toastId });
    try {
      const publication = await publishCanvasAssignmentPackages({
        campaignId: attempt.campaignId,
        idempotencyKey: attempt.idempotencyKey,
      });
      packagePublicationAttemptRef.current = null;
      setPackagePublicationStatus('ready');
      setPackagePublicationIssue('');
      return publication;
    } catch (error) {
      setPackagePublicationStatus('error');
      setPackagePublicationIssue(error?.message || 'Offline rep packages could not be published.');
      throw error;
    } finally {
      setPackagePublishing(false);
    }
  };

  const retryRepPackagePublication = async (campaign = serverSession) => {
    if (activeOperationRef.current || packagePublishing) return;
    activeOperationRef.current = 'package-publication';
    const toastId = toast.loading('Publishing signed offline Canvas maps...');
    try {
      const publication = await publishRepPackages(campaign, { toastId });
      toast.success(`${publication.package_count || publication.packages?.length || 0} rep package${Number(publication.package_count || publication.packages?.length || 0) === 1 ? '' : 's'} ready for offline field work.`, { id: toastId });
    } catch (error) {
      toast.error(`${error?.message || 'Rep packages could not be published.'} The reviewed deployment is saved, but it is not delivered to reps. Any predecessor assignment remains in place until retry succeeds.`, { id: toastId, duration: 9000 });
    } finally {
      if (activeOperationRef.current === 'package-publication') activeOperationRef.current = '';
    }
  };

  const deployPlan = async () => {
    if (activeOperationRef.current) return toast.error('Wait for the current Canvas action to finish.');
    if (planStaleReason) return toast.error('The territory preview is out of date. Wait for the live preview or update it before sending.');
    if (planTooComplex) return toast.error(planComplexityStatus.message);
    if (workloadDeviationUnavailable) return toast.error('Canvas could not verify the workload balance. Regenerate the territories before sending.');
    if (workloadExceptionNeedsAcceptance) return toast.error('Review and accept the uneven workload before sending territories.');
    if (!crewAssignmentStatus.valid) return toast.error(crewAssignmentStatus.message || 'Match every selected rep to the territory assignments before sending.');
    if (!deployable || deployed) return toast.error('Assign every territory and clear all street QA blockers before deployment.');
    activeOperationRef.current = 'deploy';
    setDeploying(true);
    const toastId = toast.loading('Saving the final territory revision...');
    try {
      const reusableAttempt = deploymentAttemptRef.current;
      const saved = reusableAttempt
        && reusableAttempt.sessionId === serverSession?.session_id
        && reusableAttempt.version === Number(serverSession?.version)
        ? serverSession
        : await persistDraft({ quiet: true, withinDeploy: true });
      if (!saved) throw new Error('The final draft was not saved. Nothing was sent to reps.');
      if (saved.qa?.deployable !== true) throw new Error('Server QA did not approve this territory revision. Nothing was sent to reps.');
      const attempt = reusableAttempt
        && reusableAttempt.sessionId === saved.session_id
        && reusableAttempt.version === Number(saved.version)
        ? reusableAttempt
        : { sessionId: saved.session_id, version: Number(saved.version), idempotencyKey: makeIdempotencyKey() };
      deploymentAttemptRef.current = attempt;
      toast.loading('Sending exclusive territories to reps...', { id: toastId });
      let deployedSession;
      try {
        deployedSession = await deployCanvasCampaign({
          sessionId: attempt.sessionId,
          expectedVersion: attempt.version,
          idempotencyKey: attempt.idempotencyKey,
        });
      } catch (error) {
        const details = error?.details?.details || error?.details || {};
        const conflictingIds = details.required_supersede_session_ids || details.conflicting_session_ids || [];
        if (!['canvas_deployment_overlap', 'canvas_overlap_conflict'].includes(error?.code) || !conflictingIds.length) throw error;
        if (!window.confirm(formatCanvasOverlapConfirmation(details))) throw new Error('Deployment canceled. Existing Canvas campaigns remain active.');
        deployedSession = await deployCanvasCampaign({
          sessionId: attempt.sessionId,
          expectedVersion: attempt.version,
          idempotencyKey: attempt.idempotencyKey,
          supersedeSessionIds: conflictingIds,
        });
      }
      const nextSession = { ...serverSession, ...deployedSession, session_name: serverSession?.session_name || sessionName };
      setServerSession(nextSession);
      deploymentAttemptRef.current = null;
      refreshCampaignIndex();
      const publication = await publishRepPackages(nextSession, { toastId });
      toast.success(`Sent ${zones.length} exclusive territories with ${publication.package_count || publication.packages?.length || 0} signed offline rep packages.`, { id: toastId });
      loadCampaignMap(nextSession, { quiet: true });
    } catch (error) {
      const streetDataChanged = error?.code === 'topology_data_version_mismatch';
      if (streetDataChanged) {
        clearPersistedCanvasAnalysisJob(user?.id);
        deploymentAttemptRef.current = null;
        setPlanStaleReason('Street data changed on the server. Wait for fresh streets, then regenerate.');
        setRoadFetchNonce((value) => value + 1);
      }
      toast.error(error.message || 'Canvas campaign could not be deployed.', { id: toastId });
    } finally {
      setDeploying(false);
      if (activeOperationRef.current === 'deploy') activeOperationRef.current = '';
    }
  };

  const closeCampaign = async (action, campaign = serverSession) => {
    if (campaign?.status !== 'deployed' || closing || activeOperationRef.current) return;
    const confirmed = window.confirm(`Are you sure you want to ${action === 'complete' ? 'complete' : 'recall'} “${campaign.session_name || 'Canvas Campaign'}”? Its territories will disappear from rep maps.`);
    if (!confirmed) return;
    const reusableAttempt = closeAttemptRef.current;
    const attempt = reusableAttempt
      && reusableAttempt.sessionId === campaignId(campaign)
      && reusableAttempt.version === Number(campaign.version)
      && reusableAttempt.action === action
      ? reusableAttempt
      : { sessionId: campaignId(campaign), version: Number(campaign.version), action, idempotencyKey: makeIdempotencyKey() };
    closeAttemptRef.current = attempt;
    activeOperationRef.current = 'close';
    setClosing(true);
    const toastId = toast.loading(action === 'complete' ? 'Completing Canvas campaign...' : 'Recalling Canvas campaign...');
    try {
      const closed = await closeCanvasCampaign({
        sessionId: attempt.sessionId,
        expectedVersion: attempt.version,
        idempotencyKey: attempt.idempotencyKey,
        action: attempt.action,
      });
      setServerSession((current) => campaignId(current) === campaignId(closed) ? { ...current, ...closed } : current);
      setCampaignIndex((current) => current.map((item) => campaignId(item) === campaignId(closed) ? { ...item, ...closed } : item));
      closeAttemptRef.current = null;
      deploymentAttemptRef.current = null;
      packagePublicationAttemptRef.current = null;
      setPackagePublicationStatus('idle');
      setPackagePublicationIssue('');
      toast.success(action === 'complete' ? 'Campaign completed.' : 'Campaign recalled.', { id: toastId });
    } catch (error) {
      toast.error(`${error.message} Retry the same action to safely reuse the request.`, { id: toastId });
    } finally {
      setClosing(false);
      if (activeOperationRef.current === 'close') activeOperationRef.current = '';
    }
  };

  const startAnotherArea = async () => {
    if (activeOperationRef.current) return;
    if (!confirmDiscardUnsaved('Starting another area')) return;
    // Same reasoning as redrawArea: starting a new area resets local state and
    // must not be blocked by a job that can no longer be cancelled.
    await cancelResidentialAnalysis({ quiet: true });
    clearPersistedCanvasAnalysisJob(user?.id);
    setPlan(null);
    setPlanStaleReason('');
    setPlanGenerationError(null);
    setServerSession(null);
    setSelectedZoneNumber(null);
    setLiveCampaignMap(null);
    setLiveMapError('');
    setSessionName('Canvas Cold Area');
    setDivisionBasis('area_count');
    setSelectedTeamMemberIds([]);
    setWorkloadExceptionAccepted(false);
    setDraftDirty(false);
    setLivePreviewRevision(0);
    lastGeneratedPreviewRevisionRef.current = -1;
    lastAttemptedPreviewRevisionRef.current = -1;
    deploymentAttemptRef.current = null;
    packagePublicationAttemptRef.current = null;
    setPackagePublicationStatus('idle');
    setPackagePublicationIssue('');
    closeAttemptRef.current = null;
    setWorkspaceView('new_area');
    try { sessionStorage.setItem('fk_canvasPlannerView', 'new_area'); } catch {}
    publishZonePreview([], [], { previewOnly: true });
    window.dispatchEvent(new CustomEvent('fk-canvas-campaign-map-updated', { detail: null }));
    onDraw();
  };
  startAnotherAreaRef.current = startAnotherArea;

  const contentProps = {
    sessionName, changeSessionName, polygon, hasDrawnArea, onDraw: redrawArea, onClearPolygon: clearArea, onClose: closePlanner,
    divisionBasis, changeDivisionBasis, selectedTeamMemberIds, toggleTeamMember, replaceTeamMemberSelection, activeTeamMembers, teamMembersReady, teamExclusions: teamEligibility.excluded,
    requestedAreaCount, changeRequestedAreaCount, targetStreetWorkloadMiles, changeTargetStreetWorkloadMiles, requestedZoneCount, roadFetchStatus, roadFetchError, roadFetchProgress, refreshRoadData,
    residentialAnalysis, serverAnalysisJobId, cancelResidentialAnalysis, cancellingServerAnalysis,
    selectedClassificationUnit, unresolvedClassificationCount,
    classificationRole, setClassificationRole,
    classificationOpportunityCount, setClassificationOpportunityCount,
    classificationReason, setClassificationReason,
    classificationSaving, applyClassificationReview,
    generationBlockers, generatePlan, generating, plan, planStaleReason, planGenerationError,
    zones, assignedZoneCount, selectedZone, selectedZoneNumber, setSelectedZoneNumber,
    lockedZoneIds, toggleZoneLock, mergeZoneInto,
    autoAssign, updateZoneAssignment, membersById,
    persistDraft, deployPlan, closeCampaign, retryRepPackagePublication, saving, deploying, packagePublishing, packagePublicationStatus, packagePublicationIssue, closing, deployable, sendable, crewAssignmentStatus, workloadDeviationUnavailable, workloadExceptionNeedsAcceptance, workloadExceptionAccepted, changeWorkloadExceptionAcceptance, planTooComplex, planComplexityStatus, serverSession, deployed, activeDeployment, closedDeployment, mutationsLocked, draftDirty,
    startAnotherArea,
    savedDrafts, selectedDraft, selectedDraftId, setSelectedDraftId, resumeDraft, resumingDraft,
    otherActiveCampaigns, selectedIndexedCampaign, selectedIndexedCampaignId, setSelectedIndexedCampaignId, campaignIndexLoading, campaignIndexError, campaignSigningUnavailable, refreshCampaignIndex,
    quarantinableCampaignCount, quarantineRejectedCampaigns, quarantiningCampaigns,
    liveCampaignMap, liveMapLoading, liveMapError, loadCampaignMap,
    refreshTeamRoster, teamRosterRefreshing, canRefreshTeamRoster: typeof onRefreshTeamMembers === 'function',
    workspaceView, changeWorkspaceView,
  };

  return (
    <div className="fixed inset-0 z-[2000] pointer-events-none lg:flex">
      <div className="hidden lg:block pointer-events-auto h-full w-[410px] bg-[#09090f]/95 border-r border-purple-500/20 shadow-2xl pt-[env(safe-area-inset-top)]"><BuilderContent {...contentProps} /></div>
      <div className={`lg:hidden pointer-events-auto absolute left-0 right-0 bottom-0 rounded-t-3xl bg-[#09090f] border-t border-purple-500/25 shadow-2xl overflow-hidden pb-[env(safe-area-inset-bottom)] transition-[height] ${mobileCollapsed ? 'h-16' : 'h-[82dvh] max-h-[82vh]'}`}>
        <button type="button" onClick={() => setMobileCollapsed((value) => !value)} className="flex h-10 w-full items-center justify-center gap-2 text-[11px] font-bold text-purple-200" aria-expanded={!mobileCollapsed}>
          {mobileCollapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}{mobileCollapsed ? 'Open Canvas planner' : 'Collapse to inspect map'}
        </button>
        {!mobileCollapsed && <BuilderContent compact {...contentProps} />}
      </div>
    </div>
  );
}

function BuilderContent(props) {
  if (props.workspaceView === 'new_area' || props.workspaceView === 'areas') {
    return <CanvasPlannerWorkspace {...props} />;
  }
  return <LegacyBuilderContent {...props} />;
}

function LegacyBuilderContent(props) {
  const {
    sessionName, changeSessionName, polygon, hasDrawnArea, onDraw, onClearPolygon, onClose,
    divisionBasis, changeDivisionBasis, selectedTeamMemberIds, toggleTeamMember, replaceTeamMemberSelection, activeTeamMembers, teamMembersReady, teamExclusions,
    requestedAreaCount, changeRequestedAreaCount, targetStreetWorkloadMiles, changeTargetStreetWorkloadMiles, requestedZoneCount, roadFetchStatus, refreshRoadData,
    generationBlockers, generatePlan, generating, plan, planStaleReason,
    zones, assignedZoneCount, selectedZone, selectedZoneNumber, setSelectedZoneNumber,
    autoAssign, updateZoneAssignment, membersById,
    persistDraft, deployPlan, closeCampaign, retryRepPackagePublication, saving, deploying, packagePublishing, closing, deployable, sendable, crewAssignmentStatus, workloadDeviationUnavailable, workloadExceptionNeedsAcceptance, workloadExceptionAccepted, changeWorkloadExceptionAcceptance, planTooComplex, planComplexityStatus, serverSession, deployed, activeDeployment, closedDeployment, mutationsLocked, draftDirty,
    startAnotherArea,
    savedDrafts, selectedDraft, selectedDraftId, setSelectedDraftId, resumeDraft, resumingDraft,
    otherActiveCampaigns, selectedIndexedCampaign, selectedIndexedCampaignId, setSelectedIndexedCampaignId, campaignIndexLoading, campaignIndexError, campaignSigningUnavailable, refreshCampaignIndex,
    liveCampaignMap, liveMapLoading, liveMapError, loadCampaignMap,
    refreshTeamRoster, teamRosterRefreshing, canRefreshTeamRoster, compact = false,
  } = props;
  const campaignNameId = useId();
  const requestedHeadcount = Math.max(1, Number(requestedAreaCount) || 1);
  const rosterShortfall = divisionBasis === 'area_count'
    ? Math.max(0, requestedHeadcount - activeTeamMembers.length)
    : 0;
  const rosterRecoveryNeeded = teamMembersReady && (!activeTeamMembers.length || rosterShortfall > 0);
  const headcountInputDisabled = deployed || saving || deploying || closing || resumingDraft;

  return (
    <div className="relative h-full flex flex-col text-white">
      <div className="p-4 border-b border-white/10 flex items-center justify-between shrink-0">
        <div><h2 className="flex items-center gap-2 font-extrabold tracking-wide text-purple-300"><MapIcon className="w-5 h-5" /> CANVAS PLANNER</h2><p className="text-[10px] text-gray-500 mt-1">Global area → connected streets → exclusive rep territories</p></div>
        <button type="button" disabled={mutationsLocked && !deployed} onClick={onClose} className="p-2 hover:bg-white/10 rounded-full disabled:opacity-40" aria-label="Close Canvas planner"><X className="w-5 h-5 text-gray-300" /></button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-4 pb-36">
        {activeDeployment && (
          <div className="rounded-2xl border border-green-500/30 bg-green-500/10 p-3">
            <p className="text-sm font-bold text-green-300">Campaign is live</p>
            <p className="text-[11px] text-green-100/70">{serverSession.delivery_count} rep territories · decisions sync onto the shared map</p>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <Button disabled={liveMapLoading} onClick={() => loadCampaignMap(serverSession)} className="h-9 bg-purple-500/20 text-purple-100 border border-purple-400/25 hover:bg-purple-500/30"><Eye className="h-4 w-4" /> Map</Button>
              <Button disabled={closing} onClick={() => closeCampaign('complete')} className="h-9 bg-green-500/15 text-green-100 border border-green-400/25 hover:bg-green-500/25"><CheckCircle2 className="h-4 w-4" /> Done</Button>
              <Button disabled={closing} onClick={() => closeCampaign('recall')} className="h-9 bg-red-500/15 text-red-100 border border-red-400/25 hover:bg-red-500/25"><AlertTriangle className="h-4 w-4" /> Recall</Button>
            </div>
            <Button onClick={startAnotherArea} className="mt-2 h-10 w-full border border-green-300/20 bg-green-500/10 text-green-100 hover:bg-green-500/20"><Pencil className="h-4 w-4" /> Start another area</Button>
          </div>
        )}
        {closedDeployment && <div className="rounded-2xl border border-white/15 bg-white/5 p-3"><p className="text-sm font-bold text-white">Campaign {serverSession.status}</p><p className="text-[11px] text-gray-400">Its territories are no longer active on rep maps.</p><Button onClick={startAnotherArea} className="mt-3 h-10 w-full border border-white/10 bg-white/10 text-white"><Pencil className="h-4 w-4" /> Start another area</Button></div>}

        {savedDrafts.length > 0 && (
          <details className="rounded-2xl border border-amber-400/20 bg-amber-500/[0.06]">
            <summary className="cursor-pointer list-none p-3 text-xs font-black text-amber-100">Saved Canvas drafts ({savedDrafts.length})</summary>
            <div className="space-y-2 border-t border-amber-400/15 p-3"><div className="flex items-center justify-between"><p className="text-[10px] text-gray-500">Resume the exact boundary, street plan, assignments, and server version.</p><button type="button" disabled={campaignIndexLoading} onClick={refreshCampaignIndex} className="text-[10px] font-bold text-amber-200">Refresh</button></div>
            <Select value={campaignId(selectedDraft)} onValueChange={setSelectedDraftId}><SelectTrigger className="h-10 border-white/10 bg-black/30 text-white"><SelectValue /></SelectTrigger><SelectContent className="z-[4000] border-white/10 bg-black text-white">{savedDrafts.map((draft) => <SelectItem key={campaignId(draft)} value={campaignId(draft)}>{draft.session_name} · {draft.zone_count} territories · v{draft.version}</SelectItem>)}</SelectContent></Select>
            <Button disabled={!selectedDraft || resumingDraft || !teamMembersReady} onClick={() => resumeDraft(selectedDraft)} className="h-10 w-full border border-amber-300/20 bg-amber-500/15 text-amber-50 hover:bg-amber-500/25">{resumingDraft || !teamMembersReady ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} {teamMembersReady ? 'Resume draft' : 'Loading rep roster…'}</Button>
            </div>
          </details>
        )}

        {campaignSigningUnavailable && (
          <section className="rounded-2xl border border-amber-400/25 bg-amber-500/[0.08] p-3">
            <div className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
              <div>
                <p className="text-xs font-black text-amber-100">Canvas deployment security needs setup</p>
                <p className="mt-1 text-[11px] leading-relaxed text-amber-100/80">You can still draw, load streets, generate territories, and save a draft. An administrator must configure <span className="font-mono">CANVAS_DEPLOYMENT_SIGNING_SECRET</span> before active campaigns or rep deployment can be trusted.</p>
              </div>
            </div>
          </section>
        )}

        {(otherActiveCampaigns.length > 0 || campaignIndexLoading || (campaignIndexError && !campaignSigningUnavailable)) && (
          <details className="rounded-2xl border border-purple-400/20 bg-purple-500/[0.06]" open={campaignIndexError && !campaignSigningUnavailable ? true : undefined}>
            <summary className="cursor-pointer list-none p-3 text-xs font-black text-purple-200">Active Canvas campaigns ({otherActiveCampaigns.length})</summary>
            <div className="space-y-2 border-t border-purple-400/15 p-3"><div className="flex justify-end"><button type="button" disabled={campaignIndexLoading} onClick={refreshCampaignIndex} className="text-[10px] font-bold text-purple-300">Refresh</button></div>
            {campaignIndexLoading && !otherActiveCampaigns.length && <p className="text-[11px] text-gray-400">Loading campaigns…</p>}
            {campaignIndexError && !campaignSigningUnavailable && <p className="text-[11px] text-amber-300">{campaignIndexError}</p>}
            {selectedIndexedCampaign && <>
              <Select value={campaignId(selectedIndexedCampaign)} onValueChange={setSelectedIndexedCampaignId}><SelectTrigger className="h-10 border-white/10 bg-black/30 text-white"><SelectValue /></SelectTrigger><SelectContent className="z-[4000] border-white/10 bg-black text-white">{otherActiveCampaigns.map((campaign) => <SelectItem key={campaignId(campaign)} value={campaignId(campaign)}>{campaign.session_name} · {campaign.zone_count} territories</SelectItem>)}</SelectContent></Select>
              <div className="grid grid-cols-2 gap-2"><Button disabled={liveMapLoading} onClick={() => loadCampaignMap(selectedIndexedCampaign)} className="h-9 bg-purple-500/20 text-purple-100 border border-purple-400/25"><Eye className="h-4 w-4" /> Map</Button><Button disabled={packagePublishing} onClick={() => retryRepPackagePublication(selectedIndexedCampaign)} className="h-9 border border-blue-400/25 bg-blue-500/15 text-blue-100"><ShieldCheck className="h-4 w-4" /> Offline maps</Button><Button disabled={closing || packagePublishing} onClick={() => closeCampaign('complete', selectedIndexedCampaign)} className="h-9 bg-green-500/15 text-green-100 border border-green-400/25"><CheckCircle2 className="h-4 w-4" /> Done</Button><Button disabled={closing || packagePublishing} onClick={() => closeCampaign('recall', selectedIndexedCampaign)} className="h-9 bg-red-500/15 text-red-100 border border-red-400/25"><AlertTriangle className="h-4 w-4" /> Recall</Button></div>
            </>}
            </div>
          </details>
        )}

        {liveCampaignMap && <CampaignProgress map={liveCampaignMap} loading={liveMapLoading} error={liveMapError} onRefresh={() => loadCampaignMap(liveCampaignMap.campaign, { progressOnly: true })} />}

        <section className="space-y-3">
          <StepLabel number="1" label="Draw the work area" />
          <div><label htmlFor={campaignNameId} className="text-[10px] font-bold uppercase text-gray-500">Campaign name · optional</label><Input id={campaignNameId} disabled={mutationsLocked} value={sessionName} onChange={(event) => changeSessionName(event.target.value)} className="mt-1 bg-[#151520] border-white/10 text-white h-11 font-bold" /></div>
          <div className="grid grid-cols-2 gap-2"><Button disabled={mutationsLocked} onClick={onDraw} className="h-10 bg-purple-600 hover:bg-purple-500 text-white"><Pencil className="w-4 h-4" /> {hasDrawnArea ? 'Redraw area' : 'Draw area'}</Button><Button disabled={!hasDrawnArea || mutationsLocked} onClick={onClearPolygon} className="h-10 bg-white/10 text-white border border-white/10">Clear</Button></div>
          <TruthRow icon={MapPin} tone={polygon.length ? 'good' : 'idle'} title={polygon.length ? 'Global boundary ready' : 'Draw one freehand boundary'} detail={polygon.length ? 'This territory—not a house list—is the source of truth.' : 'Outline the entire cold area your team will work.'} />
          <TruthRow icon={Network} tone={roadFetchStatus === 'ready' ? 'good' : roadFetchStatus === 'loading' ? 'loading' : ['unavailable', 'invalid'].includes(roadFetchStatus) ? 'bad' : 'idle'} title={roadFetchStatus === 'ready' ? 'Street network loaded' : roadFetchStatus === 'loading' ? 'Reading streets' : roadFetchStatus === 'unavailable' ? 'Street network unavailable' : roadFetchStatus === 'invalid' ? 'Boundary needs changes' : 'Streets load after drawing'} detail={roadFetchStatus === 'ready' ? 'Canvas can now divide connected street work while protecting cul-de-sacs.' : roadFetchStatus === 'invalid' ? 'Canvas did not request street data for this unsupported boundary.' : 'Canvas will not substitute square grid areas.'} />
          {roadFetchStatus === 'unavailable' && <Button disabled={mutationsLocked} onClick={refreshRoadData} className="h-10 w-full border border-white/10 bg-white/5 text-white"><RefreshCw className="h-4 w-4" /> Retry street data</Button>}
        </section>

        <section className="space-y-3">
          <StepLabel number="2" label="Choose who is working" />
          <p className="text-[11px] leading-relaxed text-gray-400">Give Canvas one sizing goal. It will handle connected streets, balanced street coverage, exclusive ownership, and cul-de-sacs automatically.</p>
          <div className="grid grid-cols-2 gap-2">
            <ChoiceButton disabled={mutationsLocked || !activeTeamMembers.length} active={divisionBasis === 'selected_reps'} onClick={() => changeDivisionBasis('selected_reps')} icon={Users} title="Choose reps" detail={activeTeamMembers.length ? 'One territory each' : 'No linked reps yet'} />
            <ChoiceButton disabled={mutationsLocked} active={divisionBasis === 'area_count'} onClick={() => changeDivisionBasis('area_count')} icon={Users} title="Enter headcount" detail="Assign names later" />
          </div>
          {divisionBasis === 'selected_reps' && <RosterPicker title="Who is going out?" detail="Canvas creates one connected territory per selected rep. Update the preview after the crew is selected." activeTeamMembers={activeTeamMembers} selectedIds={selectedTeamMemberIds} toggle={toggleTeamMember} replaceSelection={replaceTeamMemberSelection} disabled={mutationsLocked} exclusions={teamExclusions} />}
          {divisionBasis === 'area_count' && <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 space-y-2"><NumberField label="How many people are working this area?" value={requestedAreaCount} min={1} max={250} disabled={headcountInputDisabled} onChange={changeRequestedAreaCount} /><p className="text-[10px] leading-relaxed text-gray-500">Canvas creates one connected territory per person. Create the first preview once; after that, the colored map preview updates automatically after a short pause. You can keep adjusting the headcount while Canvas recalculates.</p></div>}
          <details className="rounded-xl border border-white/10 bg-white/[0.02]" open={divisionBasis === 'street_workload_target' ? true : undefined}>
            <summary className="cursor-pointer list-none px-3 py-2.5 text-[10px] font-black text-gray-400">Advanced · create standard-size work packs</summary>
            <div className="space-y-2 border-t border-white/10 p-3">
              <button type="button" aria-pressed={divisionBasis === 'street_workload_target'} disabled={mutationsLocked} onClick={() => changeDivisionBasis('street_workload_target')} className={`w-full rounded-xl border p-3 text-left ${divisionBasis === 'street_workload_target' ? 'border-purple-400 bg-purple-500/15 text-purple-100' : 'border-white/10 bg-black/20 text-gray-300'}`}><span className="block text-xs font-black">Size territories by street coverage</span><span className="mt-1 block text-[10px] text-gray-500">Canvas calculates how many reusable assignments fit inside the area.</span></button>
              {divisionBasis === 'street_workload_target' && <><NumberField label="Target street coverage per territory (miles)" value={targetStreetWorkloadMiles} min={0.1} max={25} step={0.1} disabled={mutationsLocked} onChange={changeTargetStreetWorkloadMiles} /><p className="text-[10px] leading-relaxed text-gray-500">This is a soft street-work target, not a door count or promised walking time. Whole cul-de-sacs and connected street units stay together even when that makes one territory slightly larger.</p></>}
            </div>
          </details>
          {rosterRecoveryNeeded && (
            <div className="rounded-2xl border border-amber-400/20 bg-amber-500/[0.07] p-3">
              <p className="text-xs font-black text-amber-100">{activeTeamMembers.length ? `Add ${rosterShortfall} more eligible rep${rosterShortfall === 1 ? '' : 's'}` : 'Plan now, assign reps later'}</p>
              <p className="mt-1 text-[11px] leading-relaxed text-gray-300">{divisionBasis === 'area_count' ? `${requestedHeadcount} needed · ${activeTeamMembers.length} eligible. ` : ''}Enter your crew size and build the territory preview now. Before sending, add or activate the remaining reps in Team and have each rep sign in and redeem your invite code.</p>
              <div className="mt-3 grid grid-cols-2 gap-2"><Button asChild className="h-9 border border-amber-300/20 bg-amber-500/15 text-amber-50 hover:bg-amber-500/25"><Link to={createPageUrl('AdminTeam')} target="_blank" rel="noopener noreferrer"><Users className="h-4 w-4" /> Manage reps</Link></Button>{canRefreshTeamRoster && <Button disabled={teamRosterRefreshing || mutationsLocked} onClick={refreshTeamRoster} className="h-9 border border-white/10 bg-white/10 text-white">{teamRosterRefreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Refresh roster</Button>}</div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2"><Metric label={divisionBasis === 'street_workload_target' ? 'Territories' : 'Crew → territories'} value={divisionBasis === 'street_workload_target' && !requestedZoneCount ? 'Calculated for you' : `${requestedZoneCount} → ${requestedZoneCount}`} /><Metric label="Canvas goal" value="Balanced streets" /></div>
          {requestedZoneCount >= 100 && divisionBasis !== 'street_workload_target' && <p className="rounded-xl border border-blue-400/20 bg-blue-500/10 p-3 text-[10px] leading-relaxed text-blue-100">Large-team plan: Canvas will calculate this off the main screen and verify the street complexity. If one campaign is too dense to process safely, it will ask you to split the boundary.</p>}
          {generationBlockers.length > 0 && <IssueList title="Before generation" issues={generationBlockers} tone="blocking" />}
          <Button disabled={mutationsLocked || generationBlockers.length > 0} onClick={() => generatePlan()} className="h-12 w-full bg-purple-600 hover:bg-purple-500 disabled:bg-gray-800 disabled:text-gray-500 text-white font-black">{generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />} {divisionBasis === 'street_workload_target' ? 'Create the best territories' : plan ? 'Update territory preview' : `Create ${requestedZoneCount} ${requestedZoneCount === 1 ? 'territory' : 'territories'}`}</Button>
        </section>

        {zones.length > 0 && (
          <section className="space-y-3">
            <StepLabel number="3" label="Review and send" />
            <PlannerQaPanel disabled={mutationsLocked} plan={plan} staleReason={planStaleReason} workloadExceptionAccepted={workloadExceptionAccepted} onWorkloadExceptionAccepted={changeWorkloadExceptionAcceptance} />
            {planTooComplex && <IssueList title="Campaign is too complex to send" issues={[planComplexityStatus.message]} tone="blocking" />}
            {divisionBasis !== 'selected_reps' && <RosterPicker title="Who should receive these territories?" detail={divisionBasis === 'area_count' ? 'Choose exactly one rep for every territory.' : 'Choose the crew explicitly; every selected rep must receive at least one work pack.'} activeTeamMembers={activeTeamMembers} selectedIds={selectedTeamMemberIds} toggle={toggleTeamMember} replaceSelection={replaceTeamMemberSelection} disabled={mutationsLocked} exclusions={teamExclusions} />}
            {divisionBasis !== 'selected_reps' && <Button disabled={mutationsLocked || !selectedTeamMemberIds.length || selectedTeamMemberIds.length > zones.length || (divisionBasis === 'area_count' && selectedTeamMemberIds.length !== zones.length)} onClick={autoAssign} className="h-10 w-full bg-purple-600 text-white"><Wand2 className="w-4 h-4" /> {divisionBasis === 'area_count' ? `Assign one each to ${selectedTeamMemberIds.length || 0} reps` : `Assign across ${selectedTeamMemberIds.length || 0} selected reps`}</Button>}
            {!planStaleReason && !crewAssignmentStatus.valid && <p className="rounded-xl border border-amber-400/20 bg-amber-400/10 p-3 text-[10px] text-amber-100">{crewAssignmentStatus.message}</p>}
            <p className="text-[11px] text-gray-500">Each territory is exclusive. House decisions are created later by reps tapping their field map.</p>
            <TerritoryReviewList zones={zones} membersById={membersById} selectedZoneNumber={selectedZoneNumber} setSelectedZoneNumber={setSelectedZoneNumber} compact={compact} />
            {selectedZone && <ZoneDetail zone={selectedZone} teamMembers={activeTeamMembers.filter((member) => selectedTeamMemberIds.includes(String(member.id)))} disabled={mutationsLocked} onAssignment={(teamMemberId) => updateZoneAssignment(selectedZone.zone_number, teamMemberId)} />}
          </section>
        )}
      </div>

      <div className="absolute bottom-0 left-0 right-0 p-4 bg-[#09090f] border-t border-white/10 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        <div className="mb-2 flex items-center justify-between text-[10px] text-gray-500"><span>{zones.length ? `${assignedZoneCount}/${zones.length} territories assigned` : 'No territory preview yet'}</span><span>{saving ? 'Saving…' : serverSession?.session_id ? (draftDirty ? 'Unsaved changes' : 'Saved') : 'Not saved'}</span></div>
        <div className="flex gap-2"><Button disabled={!plan || mutationsLocked || planTooComplex} onClick={() => persistDraft()} className="h-12 px-4 bg-white/10 text-white border border-white/10"><Save className="w-4 h-4" /> Finish later</Button><Button disabled={!sendable || mutationsLocked} onClick={deployPlan} className="flex-1 h-12 bg-purple-600 hover:bg-purple-500 disabled:bg-gray-800 disabled:text-gray-500 text-white font-extrabold">{deploying || closing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />} {activeDeployment ? 'Sent' : 'Send territories'}</Button></div>
        {planTooComplex && plan && !deployed ? <p className="mt-2 text-[10px] text-amber-300">{planComplexityStatus.message}</p> : workloadDeviationUnavailable && plan && !deployed ? <p className="mt-2 text-[10px] text-amber-300">Workload balance could not be verified. Create the territories again before sending.</p> : workloadExceptionNeedsAcceptance && plan && !deployed ? <p className="mt-2 text-[10px] text-amber-300">Review and accept the workload exception before sending.</p> : !crewAssignmentStatus.valid && plan && !deployed ? <p className="mt-2 text-[10px] text-amber-300">{crewAssignmentStatus.message}</p> : !deployable && plan && !deployed && <p className="mt-2 text-[10px] text-amber-300">Clear every street-safety blocker before sending.</p>}
      </div>
    </div>
  );
}

function RosterPicker({ title, detail, activeTeamMembers, selectedIds, toggle, replaceSelection, disabled, exclusions }) {
  const [query, setQuery] = useState('');
  const [showSelectedOnly, setShowSelectedOnly] = useState(false);
  const normalizedQuery = query.trim().toLowerCase();
  const selectedSet = new Set(selectedIds);
  const visibleMembers = activeTeamMembers
    .filter((member) => !showSelectedOnly || selectedSet.has(String(member.id)))
    .filter((member) => !normalizedQuery || `${member.name || ''} ${member.email || ''}`.toLowerCase().includes(normalizedQuery))
    .sort((left, right) => {
      const selectionOrder = Number(selectedSet.has(String(right.id))) - Number(selectedSet.has(String(left.id)));
      if (selectionOrder) return selectionOrder;
      return String(left.name || left.email || '').localeCompare(String(right.name || right.email || ''));
    });
  const visibleIds = visibleMembers.map((member) => String(member.id));
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));
  const replaceVisibleSelection = () => {
    const nextIds = allVisibleSelected
      ? selectedIds.filter((id) => !visibleIds.includes(id))
      : [...new Set([...selectedIds, ...visibleIds])];
    if (replaceSelection) replaceSelection(nextIds);
    else visibleIds.filter((id) => allVisibleSelected === selectedIds.includes(id)).forEach(toggle);
  };
  return <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold text-gray-200">{title || 'Choose reps'}</p>{detail && <p className="mt-0.5 text-[10px] leading-relaxed text-gray-500">{detail}</p>}</div><Badge className="shrink-0 border border-purple-400/20 bg-purple-500/10 text-[9px] text-purple-100">{selectedIds.length} selected</Badge></div>{activeTeamMembers.length > 8 && <div className="mt-2 flex gap-2"><div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-3 top-2.5 h-3.5 w-3.5 text-gray-500" /><Input aria-label="Search active reps" disabled={disabled} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search reps" className="h-9 border-white/10 bg-black/30 pl-9 text-xs text-white" /></div><button type="button" aria-pressed={showSelectedOnly} disabled={disabled} onClick={() => setShowSelectedOnly((value) => !value)} className={`rounded-lg border px-2.5 text-[10px] font-black ${showSelectedOnly ? 'border-purple-400/50 bg-purple-500/15 text-purple-100' : 'border-white/10 bg-black/20 text-gray-400'}`}>Selected only</button></div>}<div className="mt-2 flex items-center justify-between"><p className="text-[10px] text-gray-500">{visibleMembers.length} of {activeTeamMembers.length} active reps</p><button type="button" disabled={disabled || !visibleIds.length} onClick={replaceVisibleSelection} className="text-[10px] font-black text-purple-300 disabled:text-gray-600">{allVisibleSelected ? (normalizedQuery || showSelectedOnly ? 'Clear shown' : 'Clear all') : (normalizedQuery || showSelectedOnly ? 'Select shown' : 'Select all active')}</button></div><div className="mt-2 space-y-1.5 max-h-44 overflow-y-auto">{visibleMembers.map((member) => { const selected = selectedIds.includes(String(member.id)); return <button type="button" aria-pressed={selected} disabled={disabled} key={member.id} onClick={() => toggle(member.id)} className={`w-full rounded-xl border p-2.5 text-left flex items-center gap-3 ${selected ? 'border-purple-400/60 bg-purple-500/15' : 'border-white/10 bg-black/20'}`}><span className={`h-4 w-4 rounded border flex items-center justify-center ${selected ? 'border-purple-300 bg-purple-500' : 'border-white/20'}`}>{selected && <CheckCircle2 className="h-3 w-3" />}</span><span className="text-xs font-bold text-white truncate">{member.name || member.email}</span></button>; })}{!activeTeamMembers.length && <p className="text-xs text-amber-300">No active linked reps are available.</p>}{activeTeamMembers.length > 0 && !visibleMembers.length && <p className="py-2 text-center text-xs text-gray-500">{showSelectedOnly ? 'No selected reps match this view.' : 'No reps match this search.'}</p>}</div>{(exclusions.non_rep > 0 || exclusions.unlinked > 0 || exclusions.inactive > 0) && <p className="mt-2 text-[10px] text-gray-500">Ineligible roster records are omitted until their role, account link, and active status are valid.</p>}</div>;
}

function TerritoryReviewList({ zones, membersById, selectedZoneNumber, setSelectedZoneNumber, compact }) {
  const [expanded, setExpanded] = useState(zones.length <= 20);
  const [filterMode, setFilterMode] = useState(zones.length > 20 ? 'attention' : 'all');
  const [query, setQuery] = useState('');
  useEffect(() => {
    setExpanded(zones.length <= 20);
    setFilterMode(zones.length > 20 ? 'attention' : 'all');
    setQuery('');
  }, [zones.length]);
  const assigned = zones.filter((zone) => membersById.has(String(zone.assigned_team_member_id || ''))).length;
  const attentionCount = zones.filter((zone) => !membersById.has(String(zone.assigned_team_member_id || '')) || zone.protected_unit_over_target === true).length;
  const normalizedQuery = query.trim().toLowerCase();
  const visibleZones = zones.filter((zone) => {
    const member = membersById.get(String(zone.assigned_team_member_id || ''));
    if (filterMode === 'attention' && member && zone.protected_unit_over_target !== true) return false;
    return !normalizedQuery || `territory ${zone.zone_number} ${member?.name || ''} ${member?.email || ''}`.toLowerCase().includes(normalizedQuery);
  });
  return <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3"><button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} className="flex w-full items-center justify-between gap-3 text-left"><span><span className="block text-xs font-black text-white">Territories ({zones.length})</span><span className="mt-0.5 block text-[10px] text-gray-500">{assigned}/{zones.length} assigned{zones.length > 20 ? ' · map-first review for large teams' : ''}</span></span>{expanded ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}</button>{expanded && <><div className="mt-3 flex gap-2"><div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-3 top-2.5 h-3.5 w-3.5 text-gray-500" /><Input aria-label="Search territories or assigned reps" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Territory or rep" className="h-9 border-white/10 bg-black/30 pl-9 text-xs text-white" /></div>{zones.length > 20 && <button type="button" aria-pressed={filterMode === 'attention'} onClick={() => setFilterMode((value) => value === 'attention' ? 'all' : 'attention')} className={`rounded-lg border px-2.5 text-[10px] font-black ${filterMode === 'attention' ? 'border-amber-400/40 bg-amber-500/10 text-amber-100' : 'border-white/10 bg-black/20 text-gray-400'}`}>{filterMode === 'attention' ? `Needs review ${attentionCount}` : 'Show needs review'}</button>}</div><div className={`mt-3 grid gap-2 ${compact ? 'max-h-52' : 'max-h-64'} overflow-y-auto pr-1`}>{visibleZones.map((zone) => { const member = membersById.get(String(zone.assigned_team_member_id || '')); return <button type="button" aria-pressed={selectedZoneNumber === zone.zone_number} key={zone.zone_id || zone.zone_number} onClick={() => setSelectedZoneNumber(zone.zone_number)} className={`rounded-xl border p-3 text-left flex items-center gap-3 ${selectedZoneNumber === zone.zone_number ? 'border-purple-400 bg-purple-500/15' : 'border-white/10 bg-[#12121a]'}`}><span className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-xs font-extrabold" style={{ background: member ? zone.color || ASSIGNED_ZONE_COLOR : UNASSIGNED_ZONE_COLOR }}>{zone.zone_number}</span><span className="flex-1 min-w-0"><span className="block text-sm font-bold text-white">Territory {zone.zone_number}</span><span className={`block text-[10px] truncate ${member ? 'text-gray-400' : 'text-red-300'}`}>{formatCanvasDistance(zone.street_length_meters)} · {member?.name || member?.email || 'Unassigned'}{zone.protected_unit_over_target ? ' · workload exception' : ''}</span></span></button>; })}{!visibleZones.length && <p className="rounded-xl border border-green-400/15 bg-green-500/[0.06] p-3 text-center text-[11px] text-green-200">{filterMode === 'attention' ? 'No territories need review. Show all to inspect individual assignments.' : 'No territories match this search.'}</p>}</div></>}</div>;
}

function CampaignProgress({ map, loading, error, onRefresh }) {
  const counts = map.outcome_counts || {};
  const total = Object.values(counts).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const zoneCounts = map.zone_counts || {};
  const zoneProgress = campaignZones(map).map((zone) => {
    const value = zoneCounts[zone.zone_id] ?? zoneCounts[zone.zone_number] ?? 0;
    const logged = canvasZoneLoggedCount(value);
    return { zone, logged };
  });
  const truncated = map.truncated === true || Boolean(map.truncated && typeof map.truncated === 'object' && Object.values(map.truncated).some(Boolean));
  const dncSafetyComplete = map.dnc_safety?.complete === true;
  return <section className="rounded-2xl border border-green-400/20 bg-green-500/[0.06] p-3 space-y-3"><div className="flex items-center justify-between"><div><p className="flex items-center gap-2 text-xs font-black text-green-200"><Activity className="h-4 w-4" /> Shared campaign map</p><p className="text-[10px] text-gray-400">{total} server-synced house decisions · pending rep-device pins appear after acknowledgement</p></div><Button disabled={loading} onClick={onRefresh} size="icon" className="h-8 w-8 bg-white/10 text-white">{loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}</Button></div>{error && <p className="text-[10px] text-amber-300">Refresh failed; the last verified map remains visible. {error}</p>}{truncated && <p className="text-[10px] text-amber-300">{dncSafetyComplete ? 'Older non-do-not-knock history and its progress totals may be hidden by the map display limit. All do-not-knock pins are still loaded.' : 'Older shared history and its progress totals may be hidden by the map display limit.'}</p>}<div className="flex flex-wrap gap-1.5">{Object.entries(counts).map(([outcome, count]) => <Badge key={outcome} className="border border-white/10 bg-black/40 text-[9px] text-white"><span className="mr-1 h-2 w-2 rounded-full" style={{ background: getCanvasOutcome(outcome).color }} />{getCanvasOutcome(outcome).label} {count}</Badge>)}{!total && <p className="text-[11px] text-gray-500">No synced rep decisions yet.</p>}</div>{zoneProgress.length > 0 && <div className="grid grid-cols-2 gap-1.5 border-t border-white/10 pt-2">{zoneProgress.map(({ zone, logged }) => <div key={zone.zone_id || zone.zone_number} className="flex items-center justify-between rounded-lg bg-black/30 px-2.5 py-2 text-[10px]"><span className="truncate text-gray-300">Area {zone.zone_number} · {zone.assigned_to_name || 'Assigned rep'}</span><strong className="ml-2 text-white">{logged}</strong></div>)}</div>}</section>;
}

function StepLabel({ number, label }) { return <div className="flex items-center gap-2"><span className="h-6 w-6 rounded-full bg-purple-500/20 border border-purple-400/30 flex items-center justify-center text-[10px] font-black text-purple-200">{number}</span><h3 className="text-xs font-black uppercase tracking-wide text-gray-300">{label}</h3></div>; }
function ChoiceButton({ active, disabled, onClick, icon: Icon, title, detail }) { return <button type="button" aria-pressed={active} disabled={disabled} onClick={onClick} className={`rounded-xl border p-3 text-left disabled:cursor-not-allowed disabled:opacity-45 ${active ? 'border-purple-400 bg-purple-500/15' : 'border-white/10 bg-[#151520]'}`}><Icon className={`h-4 w-4 mb-2 ${active ? 'text-purple-300' : 'text-gray-500'}`} /><span className="block text-xs font-black text-white">{title}</span><span className="block text-[10px] text-gray-500 mt-1">{detail}</span></button>; }
function TruthRow({ icon: Icon, tone, title, detail }) { const colors = tone === 'good' ? 'border-green-500/20 bg-green-500/10 text-green-300' : tone === 'bad' ? 'border-red-500/20 bg-red-500/10 text-red-300' : tone === 'loading' ? 'border-blue-500/20 bg-blue-500/10 text-blue-300' : 'border-white/10 bg-white/[0.03] text-gray-400'; return <div className={`rounded-xl border p-3 flex items-start gap-3 ${colors}`}><Icon className={`h-4 w-4 mt-0.5 shrink-0 ${tone === 'loading' ? 'animate-pulse' : ''}`} /><div><p className="text-xs font-bold">{title}</p><p className="text-[10px] opacity-70 mt-0.5">{detail}</p></div></div>; }
function Metric({ label, value }) { return <div className="rounded-xl border border-white/10 bg-black/30 p-2.5"><p className="text-[9px] uppercase font-bold text-gray-500">{label}</p><p className="text-sm font-black text-white mt-1">{value}</p></div>; }
function NumberField({ label, value, min, max, step = 1, disabled, onChange }) { const inputId = useId(); return <div><label htmlFor={inputId} className="text-[10px] font-bold text-gray-400 uppercase">{label}</label><Input id={inputId} disabled={disabled} type="number" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Math.max(min, Math.min(max, Number(event.target.value) || min)))} className="mt-1 bg-[#151520] border-white/10 text-white h-10 font-bold" /></div>; }
function IssueList({ title, issues, tone = 'warning' }) { const blocking = tone === 'blocking'; return <div className={`rounded-xl border p-3 ${blocking ? 'border-red-400/20 bg-red-400/10' : 'border-amber-400/20 bg-amber-400/10'}`}><p className={`text-[10px] font-black uppercase mb-1 ${blocking ? 'text-red-300' : 'text-amber-300'}`}>{title}</p>{(issues || []).map((issue, index) => <p key={`${issue}:${index}`} className="text-[11px] text-gray-300">• {typeof issue === 'string' ? issue : issue?.message || issue?.code}</p>)}</div>; }

function PlannerQaPanel({ disabled, plan, staleReason, workloadExceptionAccepted, onWorkloadExceptionAccepted }) {
  const qa = normalizeQa(plan.qa);
  const gates = [['All street units covered', qa.street_coverage_complete], ['No duplicated street units', qa.no_duplicate_work_units], ['Territories stay connected', qa.connected_zones], ['Streets remain atomic', qa.atomic_work_units], ['Cul-de-sacs stay intact', qa.protected_units_intact]];
  const streetReady = !staleReason && gates.every(([, passed]) => passed);
  const streetLengths = (plan.zones || []).map((zone) => Number(zone.street_length_meters || 0)).filter((value) => value > 0);
  const totalStreetLength = Number(qa.total_street_length_meters) || streetLengths.reduce((sum, value) => sum + value, 0);
  const deviationStatus = getCanvasWorkloadDeviation(plan);
  const deviation = deviationStatus.value;
  const deviationReviewVisible = deviationStatus.verified && deviation > 25 && !staleReason;
  const shortestWorkload = deviationStatus.scores.length ? Math.min(...deviationStatus.scores) : 0;
  const longestWorkload = deviationStatus.scores.length ? Math.max(...deviationStatus.scores) : 0;
  const protectedOversize = (plan.zones || []).filter((zone) => zone.protected_unit_over_target === true).map((zone) => `Area ${zone.zone_number}`).join(', ');
  const territoryRange = deviationStatus.scores.length
    ? `${formatCanvasDistance(shortestWorkload).replace(' of streets', '')}–${formatCanvasDistance(longestWorkload).replace(' of streets', '')}`
    : '—';
  const plannerWarnings = (qa.warnings || []).filter((warning) => !deviationReviewVisible || !/workload imbalance reaches/i.test(String(warning)));
  return <div className="rounded-2xl border border-white/10 bg-[#12121a] p-4 space-y-3"><div className="flex items-center justify-between gap-3"><div><p className="text-sm font-black text-white">{plan.zones?.length || 0} territories ready</p><p className="text-[10px] text-gray-500">Balanced by connected street coverage—not invented door totals</p></div><Badge className={`shrink-0 border-none ${streetReady ? 'bg-green-500/15 text-green-300' : 'bg-amber-500/15 text-amber-300'}`}>{streetReady ? 'street-safe' : 'review'}</Badge></div><div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3"><Metric label="Total streets" value={formatCanvasDistance(totalStreetLength).replace(' of streets', '')} /><Metric label="Weighted range" value={territoryRange} /><Metric label="Maximum deviation" value={deviationStatus.verified ? `${deviation}%` : 'Review required'} /></div>{streetReady && <p className="flex items-start gap-2 rounded-xl border border-green-400/20 bg-green-500/10 p-3 text-[11px] leading-relaxed text-green-100"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" /> Every eligible street is owned once, every territory stays connected, and cul-de-sacs remain together.</p>}{!deviationStatus.verified && !staleReason && <IssueList title="Workload balance unverified" issues={['Canvas could not verify the workload deviation for this plan. Create the territories again before sending.']} tone="blocking" />}{deviationReviewVisible && <div className="rounded-xl border border-amber-400/25 bg-amber-400/10 p-3"><p className="text-[11px] font-black text-amber-100">Uneven workload needs review</p><p className="mt-1 text-[10px] leading-relaxed text-gray-300">One territory differs from the ideal by {deviation}%. Canvas keeps natural street units intact instead of cutting a cul-de-sac or disconnected fragment to force perfect numbers.</p><button type="button" role="checkbox" aria-checked={workloadExceptionAccepted} disabled={disabled} onClick={() => onWorkloadExceptionAccepted(!workloadExceptionAccepted)} className={`mt-3 flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-[10px] font-bold disabled:opacity-60 ${workloadExceptionAccepted ? 'border-green-400/30 bg-green-500/15 text-green-100' : 'border-amber-300/25 bg-black/20 text-amber-100'}`}><span className={`flex h-4 w-4 items-center justify-center rounded border ${workloadExceptionAccepted ? 'border-green-300 bg-green-500' : 'border-amber-200/40'}`}>{workloadExceptionAccepted && <CheckCircle2 className="h-3 w-3" />}</span>I reviewed and accept this uneven split</button></div>}{protectedOversize && <p className="rounded-xl border border-amber-400/20 bg-amber-400/10 p-3 text-[11px] text-amber-100">{protectedOversize} exceeds the target because an atomic cul-de-sac or connected street component cannot be split safely.</p>}{staleReason && <IssueList title="Create territories again" issues={[staleReason]} tone="blocking" />}{plannerWarnings.length > 0 && <IssueList title="Workload exceptions" issues={plannerWarnings} />}<details className="rounded-xl border border-white/10 bg-black/20"><summary className="cursor-pointer list-none px-3 py-2.5 text-[10px] font-black text-gray-400">Quality details</summary><div className="grid gap-1.5 border-t border-white/10 p-2">{gates.map(([label, passed]) => <div key={label} className="flex items-center justify-between rounded-lg bg-black/25 px-3 py-2 text-xs"><span className="text-gray-300">{label}</span>{passed ? <ShieldCheck className="h-4 w-4 text-green-300" /> : <AlertTriangle className="h-4 w-4 text-amber-300" />}</div>)}</div></details></div>;
}

function ZoneDetail({ zone, teamMembers, disabled, onAssignment }) {
  const assignmentId = zone.assigned_team_member_id || '';
  return <section className="rounded-2xl border border-white/10 bg-[#12121a] p-4 space-y-3"><div className="flex items-center justify-between"><div><p className="text-sm font-black text-white">Territory {zone.zone_number}</p><p className="text-[11px] text-gray-500">{formatCanvasDistance(zone.street_length_meters)} · {zone.work_unit_ids?.length || 0} connected street units</p></div><span className="w-9 h-9 rounded-xl" style={{ background: assignmentId ? zone.color || ASSIGNED_ZONE_COLOR : UNASSIGNED_ZONE_COLOR }} /></div><Select disabled={disabled} value={assignmentId || '__unassigned__'} onValueChange={(value) => onAssignment(value === '__unassigned__' ? '' : value)}><SelectTrigger className="w-full h-10 rounded-xl bg-black/40 border border-white/10 text-sm text-white px-3"><SelectValue placeholder="Assign rep" /></SelectTrigger><SelectContent className="z-[4000] bg-black border-white/10 text-white"><SelectItem value="__unassigned__">Unassigned</SelectItem>{teamMembers.map((member) => <SelectItem key={member.id} value={String(member.id)}>{member.name || member.email}</SelectItem>)}</SelectContent></Select><p className="text-[10px] text-gray-500">To rebalance safely, change the reps or territory count and regenerate whole street units.</p></section>;
}