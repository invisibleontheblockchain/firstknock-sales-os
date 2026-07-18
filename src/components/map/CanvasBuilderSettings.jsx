import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Home, Loader2, Map as MapIcon, MapPin, Network, Pencil, Rocket, Save, ShieldCheck, Users, Wand2, X } from 'lucide-react';
import { toast } from 'sonner';
import { base44 } from '@/api/base44Client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import CanvasOpportunityReview from '@/components/canvas/CanvasOpportunityReview';
import { loadCanvasAnalysis, saveCanvasAnalysis } from '@/components/canvas/canvasAnalysisStore';
import {
  assignCanvasZonesRoundRobin,
  attachStableDoorsToCanvasZones,
  buildCanvasDraftPayload,
  formatCanvasOverlapConfirmation,
  getCanvasTeamMemberEligibility,
  getCanvasGenerationBlockers,
  getCanvasPlannerFailureMessage,
  getCanvasSplitTarget,
  getStableOpportunityPoints,
  isCanvasPlanDeployable,
  isVerifiedCanvasPlannerResult,
  normalizeCanvasPlannerResult,
  reconcileCanvasPlanWithEligibleTeam,
  updateCanvasZoneAssignment,
} from '@/components/canvas/canvasPlannerUtils';
import { closeCanvasCampaign, deployCanvasCampaign, listMyCanvasCampaigns, saveCanvasDraft } from '@/components/canvas/canvasProductionClient';
import { clearOverpassRoadNetworkCache, fetchOverpassRoadNetwork } from '@/components/logic/overpassRoadNetwork';
import { planCanvasTerritories } from '@/components/logic/canvasStreetTerritoryPlanner';

const UNASSIGNED_ZONE_COLOR = '#A855F7';
const ASSIGNED_ZONE_COLOR = '#64748B';
const CANVAS_HIGHWAY_FILTER = 'primary|secondary|tertiary|unclassified|residential|living_street';

const polygonKeyFor = (polygon = []) => polygon
  .map((point) => `${Number(point?.lat).toFixed(6)},${Number(point?.lng).toFixed(6)}`)
  .join('|');

const initialQa = (warnings = []) => ({
  deployable: false,
  coverage_complete: false,
  no_duplicate_doors: false,
  no_missing_doors: false,
  connected_zones: false,
  atomic_work_units: false,
  cul_de_sac_splits: 0,
  protected_units_intact: false,
  data_quality_status: 'unverified',
  warnings,
});

const makeIdempotencyKey = () => {
  try { return crypto.randomUUID(); } catch { return `canvas_deploy_${Date.now()}_${Math.random().toString(36).slice(2)}`; }
};

function planWithAssignments(plan, selectedTeamMemberIds, teamMembers) {
  if (!plan) return null;
  const zones = assignCanvasZonesRoundRobin(plan.zones || [], selectedTeamMemberIds, teamMembers);
  return withAssignmentGate({ ...plan, zones });
}

function withAssignmentGate(plan) {
  if (!plan) return null;
  const qa = plan.qa || initialQa();
  const assignmentReady = (plan.zones || []).length > 0 && (plan.zones || []).every((zone) => zone.assigned_team_member_id);
  const coreGatesPass = plan.planning_method === 'street_work_units'
    && plan.assignment_basis === 'stable_door_ids'
    && qa.coverage_complete === true
    && qa.no_duplicate_doors === true
    && qa.no_missing_doors === true
    && qa.connected_zones === true
    && qa.atomic_work_units === true
    && Number(qa.cul_de_sac_splits) === 0
    && qa.protected_units_intact === true
    && qa.data_quality_status === 'verified';
  return { ...plan, qa: { ...qa, deployable: assignmentReady && coreGatesPass } };
}

function normalizeGeneratedPlan(result, { opportunities, workloadBasis, selectedTeamMemberIds, teamMembers }) {
  const rawZones = Array.isArray(result) ? result : (result?.zones || []);
  const opportunitiesById = new Map(opportunities.map((opportunity) => [String(opportunity.id), opportunity]));
  const suppliedDoors = (Array.isArray(result?.doors) ? result.doors : []).map((door) => {
    const stableDoorId = String(door?.stable_door_id || door?.id || '');
    const source = opportunitiesById.get(stableDoorId) || {};
    return {
      ...source,
      ...door,
      stable_door_id: stableDoorId,
      lat: Number(door?.lat ?? source.lat),
      lng: Number(door?.lng ?? source.lng),
    };
  });
  const attached = suppliedDoors.length
    ? { zones: rawZones, doors: suppliedDoors, missingDoorIds: [] }
    : attachStableDoorsToCanvasZones(rawZones, opportunities);
  const coreVerified = isVerifiedCanvasPlannerResult(result);
  const assignmentBasis = coreVerified || result?.assignment_basis === 'stable_door_ids' || attached.doors.length
    ? 'stable_door_ids'
    : 'legacy_geometry';
  const coreQa = result?.qa || {};
  const unassignedCount = Math.max(0, Number(coreQa.unassigned_count) || 0);
  const duplicateCount = Math.max(0, Number(coreQa.duplicate_count) || 0);
  const disconnectedCount = Math.max(0, Number(coreQa.disconnected_count) || 0);
  const culDeSacSplitCount = Math.max(0, Number(coreQa.cul_de_sac_split_count) || 0);
  const qa = coreVerified ? {
    deployable: true,
    coverage_complete: unassignedCount === 0 && attached.doors.length === opportunities.length,
    no_duplicate_doors: duplicateCount === 0 && coreQa.has_duplicate_doors !== true,
    no_missing_doors: unassignedCount === 0 && coreQa.has_unassigned_doors !== true,
    connected_zones: disconnectedCount === 0 && coreQa.has_disconnected_zones !== true,
    atomic_work_units: culDeSacSplitCount === 0 && coreQa.has_cul_de_sac_splits !== true,
    cul_de_sac_splits: culDeSacSplitCount,
    protected_units_intact: culDeSacSplitCount === 0 && coreQa.has_cul_de_sac_splits !== true,
    data_quality_status: 'verified',
    warnings: [...(result?.warnings || []), ...(coreQa.warnings || [])],
  } : initialQa([
    'The planner did not return strict QA. This result is a Draft Preview only.',
    ...(attached.missingDoorIds.length ? [`${attached.missingDoorIds.length} homes were not placed in an area.`] : []),
  ]);
  return planWithAssignments({
    ...(Array.isArray(result) ? {} : result),
    planning_method: coreVerified ? 'street_work_units' : 'preview_only',
    assignment_basis: assignmentBasis,
    workload_basis: workloadBasis,
    requested_zone_count: workloadBasis === 'selected_reps' ? new Set(selectedTeamMemberIds).size : result?.requested_zone_count,
    selected_team_member_ids: [...new Set(selectedTeamMemberIds)],
    algorithm_version: result?.algorithm_version,
    road_aligned: coreVerified,
    culdesac_integrity: coreVerified && qa.protected_units_intact,
    zones: attached.zones.map((zone, index) => ({
      ...zone,
      zone_id: zone.zone_id || zone.id || `canvas_zone_${index + 1}`,
      zone_number: Number(zone.zone_number) || index + 1,
      estimated_doors: Number(zone.door_count) || zone.stable_door_ids?.length || 0,
    })),
    doors: attached.doors,
    qa,
  }, selectedTeamMemberIds, teamMembers);
}

export default function CanvasBuilderSettings({
  drawnPolygon,
  hasDrawnArea,
  onDraw,
  onClearPolygon,
  onClose,
  user,
  teamMembers = [],
  generateStreetPlan = planCanvasTerritories,
}) {
  const polygon = useMemo(() => hasDrawnArea && drawnPolygon?.length > 2 ? drawnPolygon : [], [drawnPolygon, hasDrawnArea]);
  const polygonKey = useMemo(() => polygonKeyFor(polygon), [polygon]);
  const teamEligibility = useMemo(() => getCanvasTeamMemberEligibility(teamMembers), [teamMembers]);
  const activeTeamMembers = teamEligibility.eligible;
  const membersById = useMemo(() => new Map(activeTeamMembers.map((member) => [String(member.id), member])), [activeTeamMembers]);
  const [sessionName, setSessionName] = useState('Canvas Cold Area');
  const [workloadBasis, setWorkloadBasis] = useState('selected_reps');
  const [selectedTeamMemberIds, setSelectedTeamMemberIds] = useState([]);
  const [homesPerArea, setHomesPerArea] = useState(100);
  const [roadNetwork, setRoadNetwork] = useState(null);
  const [roadFetchStatus, setRoadFetchStatus] = useState('idle');
  const [roadFetchNonce, setRoadFetchNonce] = useState(0);
  const [mobileCollapsed, setMobileCollapsed] = useState(false);
  const [opportunityAnalysis, setOpportunityAnalysis] = useState(() => {
    const loaded = loadCanvasAnalysis(user?.id);
    return loaded?.plannerPolygonKey === polygonKey ? loaded : null;
  });
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [plan, setPlan] = useState(null);
  const [planStaleReason, setPlanStaleReason] = useState('');
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [closing, setClosing] = useState(false);
  const [campaignIndex, setCampaignIndex] = useState([]);
  const [campaignIndexLoading, setCampaignIndexLoading] = useState(false);
  const [campaignIndexError, setCampaignIndexError] = useState('');
  const [selectedIndexedCampaignId, setSelectedIndexedCampaignId] = useState('');
  const [serverSession, setServerSession] = useState(null);
  const [selectedZoneNumber, setSelectedZoneNumber] = useState(null);
  const [editZoneNumber, setEditZoneNumber] = useState(null);
  const previousPolygonKey = useRef(polygonKey);
  const deploymentAttemptRef = useRef(null);
  const closeAttemptRef = useRef(null);

  const opportunities = useMemo(() => getStableOpportunityPoints(opportunityAnalysis), [opportunityAnalysis]);
  const splitTarget = useMemo(() => getCanvasSplitTarget({
    splitBasis: workloadBasis,
    selectedTeamMemberIds,
    homesPerArea,
    totalHomes: opportunities.length,
  }), [homesPerArea, opportunities.length, selectedTeamMemberIds, workloadBasis]);
  const zones = plan?.zones || [];
  const selectedZone = zones.find((zone) => Number(zone.zone_number) === Number(selectedZoneNumber)) || null;
  const generationBlockers = useMemo(() => getCanvasGenerationBlockers({
    polygon,
    splitBasis: workloadBasis,
    selectedTeamMemberIds,
    teamMembers: activeTeamMembers,
    homesPerArea,
    analysis: opportunityAnalysis,
    roadFetchStatus,
  }), [activeTeamMembers, homesPerArea, opportunityAnalysis, polygon, roadFetchStatus, selectedTeamMemberIds, workloadBasis]);
  const plannerQa = useMemo(() => plan ? normalizeCanvasPlannerResult(plan, {
    requestedZoneCount: splitTarget.requestedZoneCount,
    roadFetchStatus,
  }) : null, [plan, roadFetchStatus, splitTarget.requestedZoneCount]);
  const deploymentPlan = useMemo(() => planStaleReason ? {
    ...plan,
    qa: {
      ...(plan?.qa || initialQa()),
      deployable: false,
      warnings: [...new Set([...(plan?.qa?.warnings || []), planStaleReason])],
    },
  } : plan, [plan, planStaleReason]);
  const assignmentsEligible = zones.length > 0
    && zones.every((zone) => membersById.has(String(zone.assigned_team_member_id || '')));
  const deployable = Boolean(deploymentPlan && assignmentsEligible && isCanvasPlanDeployable(deploymentPlan));
  const activeDeployment = serverSession?.status === 'deployed';
  const closedDeployment = ['completed', 'recalled'].includes(serverSession?.status);
  const deployed = activeDeployment || closedDeployment;
  const assignedZoneCount = zones.filter((zone) => membersById.has(String(zone.assigned_team_member_id || ''))).length;
  const otherActiveCampaigns = useMemo(() => campaignIndex.filter((campaign) => (
    campaign.status === 'deployed'
    && campaign.lifecycle_state === 'active'
    && campaign.session_id !== serverSession?.session_id
  )), [campaignIndex, serverSession?.session_id]);
  const selectedIndexedCampaign = otherActiveCampaigns.find((campaign) => campaign.session_id === selectedIndexedCampaignId)
    || otherActiveCampaigns[0]
    || null;

  const refreshCampaignIndex = useCallback(async () => {
    if (!user?.id) {
      setCampaignIndex([]);
      return;
    }
    setCampaignIndexLoading(true);
    try {
      const result = await listMyCanvasCampaigns();
      setCampaignIndex(result.campaigns);
      const warnings = [];
      if (Number(result.rejected_campaigns) > 0) warnings.push(`${result.rejected_campaigns} campaign record${result.rejected_campaigns === 1 ? '' : 's'} failed lifecycle verification and were hidden.`);
      if (result.truncated) warnings.push('Only the newest 500 campaign records are shown.');
      setCampaignIndexError(warnings.join(' '));
    } catch (error) {
      setCampaignIndexError(error.message || 'Canvas campaigns could not be loaded.');
    } finally {
      setCampaignIndexLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    try {
      localStorage.removeItem('fk_canvasCampaignSprint1');
      localStorage.removeItem('fk_canvasRosterSprint1');
    } catch {}
  }, []);

  useEffect(() => {
    refreshCampaignIndex();
  }, [refreshCampaignIndex]);

  useEffect(() => {
    if (otherActiveCampaigns.some((campaign) => campaign.session_id === selectedIndexedCampaignId)) return;
    setSelectedIndexedCampaignId(otherActiveCampaigns[0]?.session_id || '');
  }, [otherActiveCampaigns, selectedIndexedCampaignId]);

  useEffect(() => {
    const validIds = new Set(activeTeamMembers.map((member) => String(member.id)));
    setSelectedTeamMemberIds((current) => current.filter((id) => validIds.has(String(id))));
    if (deployed) return;
    setPlan((current) => {
      const reconciliation = reconcileCanvasPlanWithEligibleTeam(current, activeTeamMembers);
      if (!reconciliation.changed) return current;
      deploymentAttemptRef.current = null;
      if (reconciliation.requiresRegeneration) {
        setPlanStaleReason('The selected-rep roster changed; regenerate the areas before deployment.');
      }
      return reconciliation.plan;
    });
  }, [activeTeamMembers, deployed]);

  useEffect(() => {
    if (previousPolygonKey.current === polygonKey) return;
    previousPolygonKey.current = polygonKey;
    setPlan(null);
    setServerSession(null);
    setSelectedZoneNumber(null);
    setEditZoneNumber(null);
    if (opportunityAnalysis?.plannerPolygonKey !== polygonKey) setOpportunityAnalysis(null);
  }, [opportunityAnalysis?.plannerPolygonKey, polygonKey]);

  useEffect(() => {
    saveCanvasAnalysis(opportunityAnalysis, user?.id);
  }, [opportunityAnalysis, user?.id]);

  useEffect(() => {
    if (!polygon.length) {
      setRoadNetwork(null);
      setRoadFetchStatus('idle');
      return undefined;
    }
    let cancelled = false;
    setRoadFetchStatus('loading');
    setRoadNetwork(null);
    fetchOverpassRoadNetwork(polygon, { highwayFilter: CANVAS_HIGHWAY_FILTER })
      .then((network) => {
        if (cancelled) return;
        if (network?.elements?.length) {
          setRoadNetwork(network);
          setRoadFetchStatus('ready');
        } else {
          setRoadNetwork(null);
          setRoadFetchStatus('unavailable');
        }
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn('[FK] Canvas road network unavailable:', error?.message || error);
        setRoadNetwork(null);
        setRoadFetchStatus('unavailable');
      });
    return () => { cancelled = true; };
  }, [polygonKey, roadFetchNonce]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('fk-canvas-zones-updated', { detail: { zones, previewOnly: !deployed } }));
  }, [deployed, zones]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('fk-canvas-zone-selected', { detail: { zoneNumber: selectedZoneNumber } }));
  }, [selectedZoneNumber]);

  useEffect(() => {
    const handleMapSelection = (event) => {
      const zoneNumber = Number(event.detail?.zoneNumber);
      if (Number.isFinite(zoneNumber)) setSelectedZoneNumber(zoneNumber);
    };
    window.addEventListener('fk-canvas-zone-selected', handleMapSelection);
    return () => window.removeEventListener('fk-canvas-zone-selected', handleMapSelection);
  }, []);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('fk-canvas-zone-edit-changed', { detail: { zoneNumber: editZoneNumber } }));
  }, [editZoneNumber]);

  useEffect(() => {
    const handleManualAdjustment = (event) => {
      const nextZones = event.detail?.zones;
      if (!Array.isArray(nextZones) || !plan || deployed) return;
      setPlan((current) => ({
        ...current,
        planning_method: 'preview_only',
        assignment_basis: 'legacy_geometry',
        zones: nextZones,
        qa: initialQa(['Manual boundary edits invalidate atomic street-work-unit QA. Regenerate before deployment.']),
      }));
      setPlanStaleReason('Manual boundary edits require regeneration.');
      deploymentAttemptRef.current = null;
    };
    window.addEventListener('fk-canvas-zones-manually-adjusted', handleManualAdjustment);
    return () => window.removeEventListener('fk-canvas-zones-manually-adjusted', handleManualAdjustment);
  }, [deployed, plan]);

  const markPlanStale = (message) => {
    if (plan && !deployed) {
      setPlanStaleReason(message);
      deploymentAttemptRef.current = null;
    }
  };

  const analyzeTerritory = async () => {
    if (!polygon.length) return toast.error('Draw a Canvas territory first.');
    if (deployed) return toast.info('This deployed session is immutable. Start a new Canvas session to re-analyze.');
    setAnalysisLoading(true);
    const toastId = toast.loading('Discovering stable home opportunities...');
    try {
      const response = await base44.functions.invoke('canvasAnalyzeTerritory', { polygon });
      const analysis = response?.data;
      if (analysis?.error) throw new Error(analysis.message || analysis.error);
      const nextAnalysis = { ...analysis, plannerPolygonKey: polygonKey };
      setOpportunityAnalysis(nextAnalysis);
      setPlan(null);
      setServerSession(null);
      setPlanStaleReason('');
      toast.success(`${Number(analysis?.totalOpportunities || 0).toLocaleString()} stable home opportunities found`, { id: toastId });
    } catch (error) {
      toast.error(error?.response?.data?.message || error?.response?.data?.error || error?.message || 'Canvas analysis failed.', { id: toastId });
    } finally {
      setAnalysisLoading(false);
    }
  };

  const submitAnalysisFeedback = async (feedback) => {
    if (!opportunityAnalysis?.analysisId) return;
    try {
      await base44.functions.invoke('canvasFeedback', { analysisId: opportunityAnalysis.analysisId, feedback });
      toast.success('Analysis feedback saved.');
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not save analysis feedback.');
    }
  };

  const toggleTeamMember = (teamMemberId) => {
    if (deployed) return;
    const id = String(teamMemberId);
    setSelectedTeamMemberIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
    if (workloadBasis === 'selected_reps') markPlanStale('The selected-rep split changed; regenerate the areas.');
  };

  const changeSessionName = (value) => {
    if (deployed) return;
    setSessionName(value);
    deploymentAttemptRef.current = null;
  };

  const refreshRoadData = () => {
    clearOverpassRoadNetworkCache(polygon, CANVAS_HIGHWAY_FILTER);
    setRoadFetchNonce((value) => value + 1);
  };

  const generatePlan = async () => {
    const blockers = [...generationBlockers];
    if (typeof generateStreetPlan !== 'function') blockers.push('The street-work-unit planner is not available in this build.');
    if (blockers.length) {
      toast.error(blockers[0]);
      return;
    }
    setGenerating(true);
    const toastId = toast.loading('Building street-aware work areas...');
    try {
      const result = await generateStreetPlan({
        polygon,
        roadNetwork,
        doors: opportunities.map((opportunity) => ({
          ...opportunity,
          stable_door_id: opportunity.id,
        })),
        workload_basis: workloadBasis,
        zoneCount: splitTarget.requestedZoneCount,
        selectedRepIds: selectedTeamMemberIds,
        targetHomesPerZone: splitTarget.targetHomesPerArea,
        requested_zone_count: splitTarget.requestedZoneCount,
        target_homes_per_area: splitTarget.targetHomesPerArea,
        selected_team_member_ids: selectedTeamMemberIds,
        analysis_id: opportunityAnalysis.analysisId,
      });
      const plannerFailure = getCanvasPlannerFailureMessage(result);
      if (plannerFailure) throw new Error(plannerFailure);
      const nextPlan = normalizeGeneratedPlan(result, {
        opportunities,
        workloadBasis,
        selectedTeamMemberIds,
        teamMembers: activeTeamMembers,
      });
      if (!nextPlan.zones.length) throw new Error('The planner did not produce any usable areas.');
      setPlan(nextPlan);
      deploymentAttemptRef.current = null;
      setPlanStaleReason('');
      setServerSession(null);
      setSelectedZoneNumber(nextPlan.zones[0]?.zone_number || null);
      toast.success(`${nextPlan.zones.length} Draft Preview areas generated`, { id: toastId });
    } catch (error) {
      toast.error(error?.message || 'Canvas planning failed.', { id: toastId });
    } finally {
      setGenerating(false);
    }
  };

  const autoAssign = () => {
    if (!selectedTeamMemberIds.length) return toast.error('Select team members before auto-assigning.');
    if (!plan || deployed) return;
    setPlan((current) => planWithAssignments(current, selectedTeamMemberIds, activeTeamMembers));
    deploymentAttemptRef.current = null;
    toast.success('Areas assigned by TeamMember ID.');
  };

  const updateZoneAssignment = (zoneNumber, teamMemberId) => {
    if (!plan || deployed) return;
    setPlan((current) => withAssignmentGate({
      ...current,
      zones: current.zones.map((zone) => Number(zone.zone_number) === Number(zoneNumber)
        ? updateCanvasZoneAssignment(zone, teamMemberId, activeTeamMembers)
        : zone),
    }));
    deploymentAttemptRef.current = null;
  };

  const persistDraft = async ({ quiet = false } = {}) => {
    if (!deploymentPlan) {
      toast.error('Generate a Canvas plan first.');
      return null;
    }
    setSaving(true);
    const toastId = quiet ? null : toast.loading('Saving Draft Preview to the server...');
    try {
      const payload = buildCanvasDraftPayload({
        sessionId: serverSession?.session_id,
        expectedVersion: serverSession?.version,
        sessionName,
        polygon,
        analysisId: opportunityAnalysis?.analysisId,
        plan: deploymentPlan,
      });
      const saved = await saveCanvasDraft(payload);
      setServerSession(saved);
      setPlan((current) => current ? { ...current, qa: { ...current.qa, ...(saved.qa || {}) } } : current);
      if (!quiet) toast.success(`Draft Preview saved · version ${saved.version}`, { id: toastId });
      return saved;
    } catch (error) {
      if (!quiet) toast.error(error.message, { id: toastId });
      else toast.error(error.message);
      return null;
    } finally {
      setSaving(false);
    }
  };

  const deployPlan = async () => {
    if (!deployable || deployed) return toast.error('Every production QA gate and TeamMember assignment must pass before deployment.');
    setDeploying(true);
    const toastId = toast.loading('Saving the final revision...');
    try {
      const reusableAttempt = deploymentAttemptRef.current;
      const saved = reusableAttempt
        && reusableAttempt.sessionId === serverSession?.session_id
        && reusableAttempt.version === Number(serverSession?.version)
        ? serverSession
        : await persistDraft({ quiet: true });
      if (!saved) {
        toast.error('Final draft was not saved. Nothing was deployed.', { id: toastId });
        return;
      }
      if (saved.qa?.deployable !== true) {
        toast.error('Server QA did not mark the saved revision deployable. Nothing was sent to reps.', { id: toastId });
        return;
      }
      const attempt = reusableAttempt
        && reusableAttempt.sessionId === saved.session_id
        && reusableAttempt.version === Number(saved.version)
        ? reusableAttempt
        : { sessionId: saved.session_id, version: Number(saved.version), idempotencyKey: makeIdempotencyKey() };
      deploymentAttemptRef.current = attempt;
      toast.loading('Deploying server-authorized assignments...', { id: toastId });
      let deployedSession;
      try {
        deployedSession = await deployCanvasCampaign({
          sessionId: attempt.sessionId,
          expectedVersion: attempt.version,
          idempotencyKey: attempt.idempotencyKey,
        });
      } catch (error) {
        const conflictDetails = error?.details?.details || error?.details || {};
        const conflictIds = conflictDetails.required_supersede_session_ids || conflictDetails.conflicting_session_ids || [];
        if (!['canvas_deployment_overlap', 'canvas_overlap_conflict'].includes(error?.code) || !conflictIds.length) throw error;
        const confirmed = window.confirm(formatCanvasOverlapConfirmation(conflictDetails));
        if (!confirmed) throw new Error('Deployment canceled. The existing Canvas campaign remains active.');
        deployedSession = await deployCanvasCampaign({
          sessionId: attempt.sessionId,
          expectedVersion: attempt.version,
          idempotencyKey: attempt.idempotencyKey,
          supersedeSessionIds: conflictIds,
        });
      }
      setServerSession((current) => ({ ...current, ...deployedSession, session_name: current?.session_name || sessionName }));
      deploymentAttemptRef.current = null;
      refreshCampaignIndex();
      const repCount = deployedSession.rep_team_member_ids?.length || deployedSession.delivery_count || 0;
      toast.success(`Deployed ${zones.length} areas · ${deploymentPlan.doors.length} homes · ${repCount} reps`, { id: toastId });
    } catch (error) {
      const streetDataChanged = error?.code === 'topology_data_version_mismatch';
      if (streetDataChanged) {
        clearOverpassRoadNetworkCache(polygon, CANVAS_HIGHWAY_FILTER);
        deploymentAttemptRef.current = null;
        setPlanStaleReason('Street data changed on the server; wait for the fresh street layout, then regenerate the areas.');
        setRoadFetchNonce((value) => value + 1);
      }
      const retryHint = deploymentAttemptRef.current && !['canvas_deployment_overlap', 'canvas_overlap_conflict'].includes(error?.code)
        ? ' Retry Deploy to safely reuse the same request key.'
        : '';
      const recoveryHint = streetDataChanged ? ' Fresh street data is loading; regenerate before deploying.' : '';
      toast.error(`${error.message}${retryHint}${recoveryHint}`, { id: toastId });
    } finally {
      setDeploying(false);
    }
  };

  const closeCampaign = async (action, campaign = serverSession) => {
    if (campaign?.status !== 'deployed' || closing) return;
    const actionLabel = action === 'complete' ? 'mark this campaign complete' : 'recall this campaign immediately';
    const confirmed = window.confirm(`Are you sure you want to ${actionLabel}: “${campaign.session_name || 'Canvas Campaign'}”? Its areas will be removed from every rep's Canvas map.`);
    if (!confirmed) return;
    const reusableAttempt = closeAttemptRef.current;
    const attempt = reusableAttempt
      && reusableAttempt.sessionId === campaign.session_id
      && reusableAttempt.version === Number(campaign.version)
      && reusableAttempt.action === action
      ? reusableAttempt
      : {
          sessionId: campaign.session_id,
          version: Number(campaign.version),
          action,
          idempotencyKey: makeIdempotencyKey(),
        };
    closeAttemptRef.current = attempt;
    setClosing(true);
    const toastId = toast.loading(action === 'complete' ? 'Completing Canvas campaign...' : 'Recalling Canvas campaign...');
    try {
      const closed = await closeCanvasCampaign({
        sessionId: attempt.sessionId,
        expectedVersion: attempt.version,
        idempotencyKey: attempt.idempotencyKey,
        action: attempt.action,
      });
      setServerSession((current) => current?.session_id === closed.session_id ? { ...current, ...closed } : current);
      setCampaignIndex((current) => current.map((item) => item.session_id === closed.session_id ? { ...item, ...closed } : item));
      closeAttemptRef.current = null;
      deploymentAttemptRef.current = null;
      toast.success(action === 'complete' ? 'Campaign completed. Rep assignments are no longer active.' : 'Campaign recalled. Rep assignments are no longer active.', { id: toastId });
    } catch (error) {
      toast.error(`${error.message} Retry the same action to safely reuse the close request.`, { id: toastId });
    } finally {
      setClosing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[2000] pointer-events-none lg:flex">
      <div className="hidden lg:block pointer-events-auto h-full w-[410px] bg-[#09090f]/95 border-r border-purple-500/20 shadow-2xl pt-[env(safe-area-inset-top)]">
        <BuilderContent {...{
          sessionName, changeSessionName, polygon, hasDrawnArea, onDraw, onClearPolygon, onClose,
          workloadBasis, setWorkloadBasis, selectedTeamMemberIds, toggleTeamMember, activeTeamMembers, teamExclusions: teamEligibility.excluded,
          homesPerArea, setHomesPerArea, opportunities, splitTarget, roadFetchStatus,
          retryRoadFetch: refreshRoadData,
          opportunityAnalysis, analysisLoading, analyzeTerritory, submitAnalysisFeedback,
          generationBlockers, generatePlan, generating, plan, planStaleReason, plannerQa,
          zones, assignedZoneCount, selectedZone, selectedZoneNumber, setSelectedZoneNumber,
          editZoneNumber, setEditZoneNumber, autoAssign, updateZoneAssignment, membersById,
          persistDraft, deployPlan, closeCampaign, saving, deploying, closing, deployable, serverSession, deployed, activeDeployment, closedDeployment,
          otherActiveCampaigns, selectedIndexedCampaign, selectedIndexedCampaignId, setSelectedIndexedCampaignId, campaignIndexLoading, campaignIndexError, refreshCampaignIndex,
          markPlanStale,
        }} />
      </div>
      <div className={`lg:hidden pointer-events-auto absolute left-0 right-0 bottom-0 rounded-t-3xl bg-[#09090f]/98 border-t border-purple-500/25 shadow-2xl overflow-hidden pb-[env(safe-area-inset-bottom)] transition-[height] ${mobileCollapsed ? 'h-16' : 'h-[82dvh] max-h-[82vh]'}`}>
        <button type="button" onClick={() => setMobileCollapsed((value) => !value)} className="flex h-10 w-full items-center justify-center gap-2 text-[11px] font-bold text-purple-200" aria-expanded={!mobileCollapsed}>
          {mobileCollapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          {mobileCollapsed ? 'Open Canvas planner' : 'Collapse to inspect map'}
        </button>
        {!mobileCollapsed && (
          <BuilderContent compact {...{
            sessionName, changeSessionName, polygon, hasDrawnArea, onDraw, onClearPolygon, onClose,
            workloadBasis, setWorkloadBasis, selectedTeamMemberIds, toggleTeamMember, activeTeamMembers, teamExclusions: teamEligibility.excluded,
            homesPerArea, setHomesPerArea, opportunities, splitTarget, roadFetchStatus,
            retryRoadFetch: refreshRoadData,
            opportunityAnalysis, analysisLoading, analyzeTerritory, submitAnalysisFeedback,
            generationBlockers, generatePlan, generating, plan, planStaleReason, plannerQa,
            zones, assignedZoneCount, selectedZone, selectedZoneNumber, setSelectedZoneNumber,
            editZoneNumber, setEditZoneNumber, autoAssign, updateZoneAssignment, membersById,
            persistDraft, deployPlan, closeCampaign, saving, deploying, closing, deployable, serverSession, deployed, activeDeployment, closedDeployment,
            otherActiveCampaigns, selectedIndexedCampaign, selectedIndexedCampaignId, setSelectedIndexedCampaignId, campaignIndexLoading, campaignIndexError, refreshCampaignIndex,
            markPlanStale,
          }} />
        )}
      </div>
    </div>
  );
}

function BuilderContent(props) {
  const {
    sessionName, changeSessionName, polygon, hasDrawnArea, onDraw, onClearPolygon, onClose,
    workloadBasis, setWorkloadBasis, selectedTeamMemberIds, toggleTeamMember, activeTeamMembers, teamExclusions,
    homesPerArea, setHomesPerArea, opportunities, splitTarget, roadFetchStatus, retryRoadFetch,
    opportunityAnalysis, analysisLoading, analyzeTerritory, submitAnalysisFeedback,
    generationBlockers, generatePlan, generating, plan, planStaleReason, plannerQa,
    zones, assignedZoneCount, selectedZone, selectedZoneNumber, setSelectedZoneNumber,
    editZoneNumber, setEditZoneNumber, autoAssign, updateZoneAssignment, membersById,
    persistDraft, deployPlan, closeCampaign, saving, deploying, closing, deployable, serverSession, deployed, activeDeployment, closedDeployment,
    otherActiveCampaigns, selectedIndexedCampaign, selectedIndexedCampaignId, setSelectedIndexedCampaignId, campaignIndexLoading, campaignIndexError, refreshCampaignIndex,
    markPlanStale, compact = false,
  } = props;

  return (
    <div className="h-full flex flex-col text-white">
      <div className="p-4 border-b border-white/10 flex items-center justify-between shrink-0">
        <div>
          <h2 className="flex items-center gap-2 font-extrabold tracking-wide text-purple-300"><MapIcon className="w-5 h-5" /> CANVAS PLANNER</h2>
          <p className="text-[10px] text-gray-500 mt-1">Cold area → street work units → verified rep handoff</p>
        </div>
        <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-colors"><X className="w-5 h-5 text-gray-300" /></button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-4 pb-36">
        {serverSession?.status === 'deployed' && (
          <div className="rounded-2xl border border-green-500/30 bg-green-500/10 p-3">
            <p className="text-sm font-bold text-green-300">Campaign deployed by the server</p>
            <p className="text-[11px] text-green-100/70">Version {serverSession.version} · {serverSession.delivery_count} delivered assignments · immutable</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button disabled={closing} onClick={() => closeCampaign('complete')} className="h-9 bg-green-500/15 text-green-100 border border-green-400/25 hover:bg-green-500/25"><CheckCircle2 className="h-4 w-4" /> Complete</Button>
              <Button disabled={closing} onClick={() => closeCampaign('recall')} className="h-9 bg-red-500/15 text-red-100 border border-red-400/25 hover:bg-red-500/25"><AlertTriangle className="h-4 w-4" /> Recall</Button>
            </div>
          </div>
        )}
        {closedDeployment && (
          <div className="rounded-2xl border border-white/15 bg-white/5 p-3">
            <p className="text-sm font-bold text-white">Campaign {serverSession.status}</p>
            <p className="text-[11px] text-gray-400">Rep assignments were removed at {serverSession.closed_at ? new Date(serverSession.closed_at).toLocaleString() : 'the recorded close time'}.</p>
          </div>
        )}
        {(otherActiveCampaigns.length > 0 || campaignIndexLoading || campaignIndexError) && (
          <section className="rounded-2xl border border-purple-400/20 bg-purple-500/[0.06] p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-black text-purple-200">Other active Canvas campaigns</p>
              <button type="button" disabled={campaignIndexLoading} onClick={refreshCampaignIndex} className="text-[10px] font-bold text-purple-300 hover:text-purple-200">Refresh</button>
            </div>
            {campaignIndexLoading && !otherActiveCampaigns.length && <p className="text-[11px] text-gray-400">Loading active campaigns…</p>}
            {campaignIndexError && <p className="text-[11px] text-amber-300">{campaignIndexError}</p>}
            {selectedIndexedCampaign && (
              <>
                <Select value={selectedIndexedCampaign.session_id} onValueChange={setSelectedIndexedCampaignId}>
                  <SelectTrigger className="h-10 border-white/10 bg-black/30 text-white"><SelectValue /></SelectTrigger>
                  <SelectContent className="z-[4000] border-white/10 bg-black text-white">
                    {otherActiveCampaigns.map((campaign) => (
                      <SelectItem key={campaign.session_id} value={campaign.session_id}>{campaign.session_name} · {campaign.zone_count} areas · {campaign.target_homes} homes</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="grid grid-cols-2 gap-2">
                  <Button disabled={closing} onClick={() => closeCampaign('complete', selectedIndexedCampaign)} className="h-9 bg-green-500/15 text-green-100 border border-green-400/25 hover:bg-green-500/25"><CheckCircle2 className="h-4 w-4" /> Complete</Button>
                  <Button disabled={closing} onClick={() => closeCampaign('recall', selectedIndexedCampaign)} className="h-9 bg-red-500/15 text-red-100 border border-red-400/25 hover:bg-red-500/25"><AlertTriangle className="h-4 w-4" /> Recall</Button>
                </div>
              </>
            )}
          </section>
        )}

        <section className="space-y-3">
          <StepLabel number="1" label="Draw and analyze" />
          <Input disabled={deployed} value={sessionName} onChange={(event) => changeSessionName(event.target.value)} className="bg-[#151520] border-white/10 text-white h-11 font-bold" />
          <div className="grid grid-cols-2 gap-2">
            <Button disabled={deployed} onClick={onDraw} className="h-10 bg-purple-600 hover:bg-purple-500 text-white"><Pencil className="w-4 h-4" /> {hasDrawnArea ? 'Redraw area' : 'Draw area'}</Button>
            <Button disabled={!hasDrawnArea || deployed} onClick={onClearPolygon} className="h-10 bg-white/10 hover:bg-white/15 text-white border border-white/10">Clear</Button>
          </div>
          <TruthRow
            icon={MapPin}
            tone={polygon.length ? 'good' : 'idle'}
            title={polygon.length ? 'Freehand boundary ready' : 'No boundary drawn'}
            detail={polygon.length ? `${polygon.length} boundary points` : 'No demo or substitute territory is used.'}
          />
          <TruthRow
            icon={Network}
            tone={roadFetchStatus === 'ready' ? 'good' : roadFetchStatus === 'loading' ? 'loading' : roadFetchStatus === 'unavailable' ? 'bad' : 'idle'}
            title={roadFetchStatus === 'ready' ? 'Street input loaded' : roadFetchStatus === 'loading' ? 'Loading street input' : roadFetchStatus === 'unavailable' ? 'Street input unavailable' : 'Street input waits for a boundary'}
            detail={roadFetchStatus === 'ready' ? 'Loaded road topology is an input; alignment is confirmed only by planner QA.' : 'Rectangular fallback is not treated as production-ready.'}
          />
          {roadFetchStatus === 'unavailable' && (
            <Button disabled={deployed} onClick={retryRoadFetch} className="h-10 w-full border border-white/10 bg-white/5 text-white hover:bg-white/10">
              <Network className="h-4 w-4" /> Retry street data
            </Button>
          )}
        </section>

        <CanvasOpportunityReview
          analysis={opportunityAnalysis}
          loading={analysisLoading}
          onAnalyze={analyzeTerritory}
          onFeedback={submitAnalysisFeedback}
          hasDrawnArea={hasDrawnArea}
        />

        <section className="space-y-3">
          <StepLabel number="2" label="Choose how to divide the work" />
          <div className="grid grid-cols-2 gap-2">
            <ChoiceButton active={workloadBasis === 'selected_reps'} onClick={() => { if (!deployed) { setWorkloadBasis('selected_reps'); markPlanStale('The workload basis changed; regenerate the areas.'); } }} icon={Users} title="Selected reps" detail="One balanced area per rep" />
            <ChoiceButton active={workloadBasis === 'homes_per_area'} onClick={() => { if (!deployed) { setWorkloadBasis('homes_per_area'); markPlanStale('The workload basis changed; regenerate the areas.'); } }} icon={Home} title="Homes / area" detail="Target a fixed workload" />
          </div>
          {workloadBasis === 'homes_per_area' && (
            <NumberField label="Target homes per area" value={homesPerArea} min={1} max={1000} disabled={deployed} onChange={(value) => { setHomesPerArea(value); markPlanStale('The homes-per-area target changed; regenerate the areas.'); }} />
          )}
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
            <div className="flex items-center justify-between gap-3 mb-2">
              <p className="text-xs font-bold text-gray-300">Actual team roster</p>
              <button disabled={deployed} onClick={() => {
                const allIds = activeTeamMembers.map((member) => String(member.id));
                if (selectedTeamMemberIds.length === allIds.length) allIds.forEach((id) => selectedTeamMemberIds.includes(id) && toggleTeamMember(id));
                else allIds.filter((id) => !selectedTeamMemberIds.includes(id)).forEach(toggleTeamMember);
              }} className="text-[10px] font-black text-purple-300 disabled:opacity-40">{selectedTeamMemberIds.length === activeTeamMembers.length && activeTeamMembers.length ? 'Clear' : 'Select active'}</button>
            </div>
            <div className="space-y-1.5 max-h-40 overflow-y-auto">
              {activeTeamMembers.map((member) => {
                const selected = selectedTeamMemberIds.includes(String(member.id));
                return (
                  <button disabled={deployed} key={member.id} onClick={() => toggleTeamMember(member.id)} className={`w-full rounded-xl border p-2.5 text-left flex items-center gap-3 ${selected ? 'border-purple-400/60 bg-purple-500/15' : 'border-white/10 bg-black/20'}`}>
                    <span className={`h-4 w-4 rounded border flex items-center justify-center ${selected ? 'border-purple-300 bg-purple-500' : 'border-white/20'}`}>{selected && <CheckCircle2 className="h-3 w-3" />}</span>
                    <span className="min-w-0 flex-1"><span className="block text-xs font-bold text-white truncate">{member.name || member.email}</span><span className="block text-[10px] text-gray-500 truncate">TeamMember ID · {String(member.id).slice(-8)}</span></span>
                  </button>
                );
              })}
              {!activeTeamMembers.length && <p className="text-xs text-amber-300">No active TeamMember records are available. Free-text names are not accepted.</p>}
            </div>
            {(teamExclusions.non_rep > 0 || teamExclusions.unlinked > 0) && <p className="mt-2 text-[10px] text-amber-300">Active roster records excluded: {teamExclusions.non_rep} non-rep role · {teamExclusions.unlinked} rep invite{teamExclusions.unlinked === 1 ? '' : 's'} not linked to an account. Finish the invite/link before assigning.</p>}
            {teamExclusions.inactive > 0 && <p className="mt-1 text-[10px] text-gray-500">{teamExclusions.inactive} inactive roster record{teamExclusions.inactive === 1 ? '' : 's'} omitted.</p>}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Metric label="Stable homes" value={opportunities.length} />
            <Metric label="Requested areas" value={splitTarget.requestedZoneCount} />
            <Metric label="Homes / area" value={`~${splitTarget.targetHomesPerArea}`} />
          </div>
          {generationBlockers.length > 0 && (
            <IssueList title="Before generation" issues={generationBlockers} tone="blocking" />
          )}
          <Button disabled={deployed || generating || generationBlockers.length > 0} onClick={generatePlan} className="h-12 w-full bg-purple-600 hover:bg-purple-500 disabled:bg-gray-800 disabled:text-gray-500 text-white font-black">
            {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />} Generate street-aware Draft Preview
          </Button>
        </section>

        {plan && (
          <section className="space-y-3">
            <StepLabel number="3" label="Review planner QA" />
            <PlannerQaPanel plan={plan} plannerQa={plannerQa} staleReason={planStaleReason} />
          </section>
        )}

        {zones.length > 0 && (
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <StepLabel number="4" label="Assign and preview" />
              <Button disabled={deployed || !selectedTeamMemberIds.length} onClick={autoAssign} size="sm" className="bg-purple-600 text-white"><Wand2 className="w-4 h-4" /> Auto-assign</Button>
            </div>
            <p className="text-[11px] text-gray-500">Assignments use immutable TeamMember IDs. Selecting a name only changes the display label.</p>
            <div className={`grid gap-2 ${compact ? 'max-h-52' : 'max-h-64'} overflow-y-auto pr-1`}>
              {zones.map((zone) => {
                const member = membersById.get(String(zone.assigned_team_member_id || ''));
                return (
                  <button key={zone.zone_id || zone.zone_number} onClick={() => setSelectedZoneNumber(zone.zone_number)} className={`rounded-xl border p-3 text-left flex items-center gap-3 ${selectedZoneNumber === zone.zone_number ? 'border-purple-400 bg-purple-500/15' : 'border-white/10 bg-[#12121a]'}`}>
                    <span className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-xs font-extrabold shrink-0" style={{ background: member ? ASSIGNED_ZONE_COLOR : UNASSIGNED_ZONE_COLOR }}>{zone.zone_number}</span>
                    <span className="flex-1 min-w-0"><span className="block text-sm font-bold text-white">Zone {zone.zone_number} · {zone.stable_door_ids?.length ?? zone.estimated_doors ?? 0} homes</span><span className={`block text-[10px] truncate ${member ? 'text-gray-400' : 'text-red-300'}`}>{member?.name || member?.email || 'Unassigned'}</span></span>
                  </button>
                );
              })}
            </div>
            {selectedZone && (
              <ZoneDetail
                zone={selectedZone}
                teamMembers={workloadBasis === 'selected_reps'
                  ? activeTeamMembers.filter((member) => selectedTeamMemberIds.includes(String(member.id)))
                  : activeTeamMembers}
                disabled={deployed}
                isEditingBoundary={editZoneNumber === selectedZone.zone_number}
                onEditBoundary={() => setEditZoneNumber(editZoneNumber === selectedZone.zone_number ? null : selectedZone.zone_number)}
                onAssignment={(teamMemberId) => updateZoneAssignment(selectedZone.zone_number, teamMemberId)}
              />
            )}
          </section>
        )}
      </div>

      <div className="absolute bottom-0 left-0 right-0 p-4 bg-[#09090f] border-t border-white/10 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        <div className="mb-2 flex items-center justify-between text-[10px] text-gray-500">
          <span>{zones.length ? `${assignedZoneCount}/${zones.length} areas assigned` : 'No Draft Preview generated'}</span>
          <span>{serverSession?.session_id ? `Server v${serverSession.version}` : 'Not saved to server'}</span>
        </div>
        <div className="flex gap-2">
          <Button disabled={!plan || saving || deploying || closing || deployed} onClick={() => persistDraft()} className="h-12 px-4 bg-white/10 hover:bg-white/15 text-white border border-white/10"><Save className="w-4 h-4" /> Draft Preview</Button>
          <Button disabled={!deployable || saving || deploying || closing || deployed} onClick={deployPlan} className="flex-1 h-12 bg-purple-600 hover:bg-purple-500 disabled:bg-gray-800 disabled:text-gray-500 text-white font-extrabold">
            {deploying || closing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />} {closedDeployment ? `Campaign ${serverSession.status}` : activeDeployment ? 'Deployed' : 'Deploy to reps'}
          </Button>
        </div>
        {!deployable && plan && !deployed && <p className="mt-2 text-[10px] text-amber-300">Deployment remains disabled until strict street-work-unit QA and every TeamMember assignment pass.</p>}
      </div>
    </div>
  );
}

function StepLabel({ number, label }) {
  return <div className="flex items-center gap-2"><span className="h-6 w-6 rounded-full bg-purple-500/20 border border-purple-400/30 flex items-center justify-center text-[10px] font-black text-purple-200">{number}</span><h3 className="text-xs font-black uppercase tracking-wide text-gray-300">{label}</h3></div>;
}

function ChoiceButton({ active, onClick, icon: Icon, title, detail }) {
  return <button onClick={onClick} className={`rounded-xl border p-3 text-left ${active ? 'border-purple-400 bg-purple-500/15' : 'border-white/10 bg-[#151520]'}`}><Icon className={`h-4 w-4 mb-2 ${active ? 'text-purple-300' : 'text-gray-500'}`} /><span className="block text-xs font-black text-white">{title}</span><span className="block text-[10px] text-gray-500 mt-1">{detail}</span></button>;
}

function TruthRow({ icon: Icon, tone, title, detail }) {
  const colors = tone === 'good' ? 'border-green-500/20 bg-green-500/10 text-green-300' : tone === 'bad' ? 'border-red-500/20 bg-red-500/10 text-red-300' : tone === 'loading' ? 'border-blue-500/20 bg-blue-500/10 text-blue-300' : 'border-white/10 bg-white/[0.03] text-gray-400';
  return <div className={`rounded-xl border p-3 flex items-start gap-3 ${colors}`}><Icon className={`h-4 w-4 mt-0.5 shrink-0 ${tone === 'loading' ? 'animate-pulse' : ''}`} /><div><p className="text-xs font-bold">{title}</p><p className="text-[10px] opacity-70 mt-0.5">{detail}</p></div></div>;
}

function Metric({ label, value }) {
  return <div className="rounded-xl border border-white/10 bg-black/30 p-2.5"><p className="text-[9px] uppercase font-bold text-gray-500">{label}</p><p className="text-sm font-black text-white mt-1">{value}</p></div>;
}

function NumberField({ label, value, min, max, disabled, onChange }) {
  return <div><label className="text-[10px] font-bold text-gray-400 uppercase">{label}</label><Input disabled={disabled} type="number" min={min} max={max} value={value} onChange={(event) => onChange(Math.max(min, Math.min(max, Number(event.target.value) || min)))} className="mt-1 bg-[#151520] border-white/10 text-white h-10 font-bold" /></div>;
}

function IssueList({ title, issues, tone = 'warning' }) {
  const blocking = tone === 'blocking';
  const messages = (issues || []).map((issue) => typeof issue === 'string' ? issue : issue?.message || issue?.code).filter(Boolean);
  return <div className={`rounded-xl border p-3 ${blocking ? 'border-red-400/20 bg-red-400/10' : 'border-amber-400/20 bg-amber-400/10'}`}><p className={`text-[10px] font-black uppercase mb-1 ${blocking ? 'text-red-300' : 'text-amber-300'}`}>{title}</p>{messages.map((message, index) => <p key={`${message}:${index}`} className="text-[11px] text-gray-300">• {message}</p>)}</div>;
}

function PlannerQaPanel({ plan, plannerQa, staleReason }) {
  const qa = plan.qa || initialQa();
  const gates = [
    ['Stable-door coverage', qa.coverage_complete],
    ['No duplicate homes', qa.no_duplicate_doors],
    ['No missing homes', qa.no_missing_doors],
    ['Connected areas', qa.connected_zones],
    ['Atomic street / cul-de-sac units', qa.atomic_work_units],
  ];
  const status = staleReason ? 'blocked' : plannerQa?.status || 'blocked';
  const statusClass = status === 'ready' ? 'bg-green-500/15 text-green-300' : status === 'degraded' ? 'bg-amber-500/15 text-amber-300' : 'bg-red-500/15 text-red-300';
  return (
    <div className="rounded-2xl border border-white/10 bg-[#12121a] p-4 space-y-3">
      <div className="flex items-center justify-between gap-3"><div><p className="text-sm font-black text-white">{plan.planning_method === 'street_work_units' ? 'Street work-unit plan' : 'Preview-only geometry'}</p><p className="text-[10px] text-gray-500">Identity: {plan.assignment_basis || 'unverified'} · workload: {plan.workload_basis || 'unverified'}</p></div><Badge className={`border-none capitalize ${statusClass}`}>{status}</Badge></div>
      <div className="grid grid-cols-1 gap-1.5">
        {gates.map(([label, passed]) => <div key={label} className="flex items-center justify-between rounded-lg bg-black/25 px-3 py-2 text-xs"><span className="text-gray-300">{label}</span>{passed ? <ShieldCheck className="h-4 w-4 text-green-300" /> : <AlertTriangle className="h-4 w-4 text-amber-300" />}</div>)}
      </div>
      <p className="text-[10px] text-gray-500">Data quality: {qa.data_quality_status || 'unverified'}. A loaded road network alone is never reported as proof of street alignment or cul-de-sac integrity.</p>
      {staleReason && <IssueList title="Regeneration required" issues={[staleReason]} tone="blocking" />}
      {plannerQa?.blockingIssues?.length > 0 && <IssueList title="Blocking QA" issues={plannerQa.blockingIssues} tone="blocking" />}
      {plannerQa?.degradedIssues?.length > 0 && <IssueList title="QA warnings" issues={plannerQa.degradedIssues} />}
      {qa.warnings?.length > 0 && <IssueList title="Planner warnings" issues={qa.warnings} />}
    </div>
  );
}

function ZoneDetail({ zone, teamMembers, disabled, isEditingBoundary, onEditBoundary, onAssignment }) {
  const assignmentId = zone.assigned_team_member_id || '';
  return (
    <section className="rounded-2xl border border-white/10 bg-[#12121a] p-4 space-y-3">
      <div className="flex items-center justify-between gap-3"><div><p className="text-sm font-black text-white">Zone {zone.zone_number}</p><p className="text-[11px] text-gray-500">{zone.stable_door_ids?.length ?? zone.estimated_doors ?? 0} stable homes · {(zone.parts || [zone.geometry]).length} map part(s)</p></div><span className="w-9 h-9 rounded-xl shrink-0" style={{ background: assignmentId ? ASSIGNED_ZONE_COLOR : UNASSIGNED_ZONE_COLOR }} /></div>
      <Select disabled={disabled} value={assignmentId || '__unassigned__'} onValueChange={(value) => onAssignment(value === '__unassigned__' ? '' : value)}>
        <SelectTrigger className="w-full h-10 rounded-xl bg-black/40 border border-white/10 text-sm text-white px-3"><SelectValue placeholder="Assign by TeamMember ID" /></SelectTrigger>
        <SelectContent className="z-[4000] bg-black border-white/10 text-white"><SelectItem value="__unassigned__">Unassigned</SelectItem>{teamMembers.map((member) => <SelectItem key={member.id} value={String(member.id)}>{member.name || member.email}</SelectItem>)}</SelectContent>
      </Select>
      <Button disabled={disabled} onClick={onEditBoundary} size="sm" className={`w-full border ${isEditingBoundary ? 'bg-white text-black border-white hover:bg-gray-100' : 'bg-white/10 text-white border-white/10 hover:bg-white/15'}`}><Pencil className="w-4 h-4" /> {isEditingBoundary ? 'Boundary edit active' : 'Edit Draft Preview boundary'}</Button>
      <p className="text-[10px] text-amber-300">Manual boundary changes make the plan preview-only and require regeneration before deployment.</p>
    </section>
  );
}
