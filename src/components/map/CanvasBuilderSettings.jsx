import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  getCanvasPlannerFailureMessage,
  getCanvasTeamMemberEligibility,
  reconcileCanvasPlanWithEligibleTeam,
  restoreCanvasDraftPlan,
  updateCanvasZoneAssignment,
  validateCanvasBoundary,
} from '@/components/canvas/canvasPlannerUtils';
import {
  closeCanvasCampaign,
  deployCanvasCampaign,
  getCanvasCampaignMap,
  listMyCanvasCampaigns,
  saveCanvasDraft,
} from '@/components/canvas/canvasProductionClient';
import { canvasZoneLoggedCount, formatCanvasDistance, getCanvasOutcome } from '@/components/canvas/canvasOutcomeUtils';
import { clearOverpassRoadNetworkCache, fetchOverpassRoadNetwork } from '@/components/logic/overpassRoadNetwork';
import { planCanvasTerritories } from '@/components/logic/canvasStreetTerritoryPlanner';

const UNASSIGNED_ZONE_COLOR = '#A855F7';
const ASSIGNED_ZONE_COLOR = '#64748B';
const TERRITORY_COLORS = ['#A855F7', '#2563EB', '#059669', '#EA580C', '#DB2777', '#0891B2', '#CA8A04', '#7C3AED'];
const CANVAS_HIGHWAY_FILTER = 'primary|secondary|tertiary|unclassified|residential|living_street';
const CAMPAIGN_REFRESH_MS = 15_000;

const polygonKeyFor = (polygon = []) => polygon
  .map((point) => `${Number(point?.lat).toFixed(7)},${Number(point?.lng).toFixed(7)}`)
  .join('|');

const initialQa = (warnings = []) => ({
  deployable: false,
  street_coverage_complete: false,
  no_duplicate_work_units: false,
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

function normalizeGeneratedPlan(result, { divisionBasis, selectedTeamMemberIds, teamMembers, targetWorkloadMeters }) {
  const rawZones = Array.isArray(result?.zones) ? result.zones : Array.isArray(result) ? result : [];
  const qa = normalizeQa(result?.qa, result?.warnings || []);
  const plan = {
    ...(Array.isArray(result) ? {} : result),
    planning_method: result?.planning_method || 'street_workload',
    assignment_basis: result?.assignment_basis || 'street_work_unit_ids',
    workload_basis: result?.workload_basis || 'street_length',
    division_basis: divisionBasis,
    selected_team_member_ids: divisionBasis === 'selected_reps' ? [...new Set(selectedTeamMemberIds)] : [],
    target_workload: divisionBasis === 'street_workload_target' ? Number(result?.target_workload ?? targetWorkloadMeters) : null,
    road_aligned: true,
    zones: rawZones.map((zone, index) => ({
      ...zone,
      zone_id: zone.zone_id || zone.id || `canvas_area_${index + 1}`,
      zone_number: Number(zone.zone_number) || index + 1,
      street_length_meters: Number(zone.street_length_meters ?? zone.workload_meters ?? 0),
      color: zone.color || TERRITORY_COLORS[index % TERRITORY_COLORS.length],
    })),
    qa,
  };
  const assignmentPool = divisionBasis === 'selected_reps' ? selectedTeamMemberIds : [];
  return assignmentPool.length ? planWithAssignments(plan, assignmentPool, teamMembers) : withAssignmentGate(plan);
}

function campaignId(campaign) {
  return String(campaign?.campaign_id || campaign?.session_id || campaign?.id || '');
}

function campaignZones(campaignMap) {
  const campaign = campaignMap?.campaign || {};
  const zones = campaign.zones || campaign.plan?.zones || campaign.canonical_plan?.zones || campaignMap?.zones;
  return Array.isArray(zones) ? zones : [];
}

function isTerritoryPlanDeployable(plan, eligibleTeamIds) {
  if (!plan?.qa?.deployable || plan.assignment_basis !== 'street_work_unit_ids') return false;
  const zones = Array.isArray(plan.zones) ? plan.zones : [];
  return zones.length > 0 && zones.every((zone) => eligibleTeamIds.has(String(zone.assigned_team_member_id || '')));
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
  generateStreetPlan = planCanvasTerritories,
}) {
  const polygon = useMemo(() => hasDrawnArea && drawnPolygon?.length > 2 ? drawnPolygon : [], [drawnPolygon, hasDrawnArea]);
  const polygonKey = useMemo(() => polygonKeyFor(polygon), [polygon]);
  const teamEligibility = useMemo(() => getCanvasTeamMemberEligibility(teamMembers), [teamMembers]);
  const activeTeamMembers = teamEligibility.eligible;
  const membersById = useMemo(() => new Map(activeTeamMembers.map((member) => [String(member.id), member])), [activeTeamMembers]);
  const rosterMembersById = useMemo(() => new Map(teamMembers.map((member) => [String(member.id), member])), [teamMembers]);
  const eligibleTeamIds = useMemo(() => new Set(activeTeamMembers.map((member) => String(member.id))), [activeTeamMembers]);
  const [sessionName, setSessionName] = useState('Canvas Cold Area');
  const [divisionBasis, setDivisionBasis] = useState('selected_reps');
  const [selectedTeamMemberIds, setSelectedTeamMemberIds] = useState([]);
  const [requestedAreaCount, setRequestedAreaCount] = useState(4);
  const [targetStreetWorkloadMiles, setTargetStreetWorkloadMiles] = useState(1.5);
  const [roadNetwork, setRoadNetwork] = useState(null);
  const [roadFetchStatus, setRoadFetchStatus] = useState('idle');
  const [roadFetchNonce, setRoadFetchNonce] = useState(0);
  const [mobileCollapsed, setMobileCollapsed] = useState(false);
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
  const [selectedDraftId, setSelectedDraftId] = useState('');
  const [resumingDraft, setResumingDraft] = useState(false);
  const [liveCampaignMap, setLiveCampaignMap] = useState(null);
  const [liveMapLoading, setLiveMapLoading] = useState(false);
  const [liveMapError, setLiveMapError] = useState('');
  const [serverSession, setServerSession] = useState(null);
  const [selectedZoneNumber, setSelectedZoneNumber] = useState(null);
  const previousPolygonKey = useRef(polygonKey);
  const deploymentAttemptRef = useRef(null);
  const closeAttemptRef = useRef(null);

  const targetWorkloadMeters = Math.max(0, Number(targetStreetWorkloadMiles) || 0) * 1609.344;
  const requestedZoneCount = divisionBasis === 'selected_reps'
    ? new Set(selectedTeamMemberIds).size
    : divisionBasis === 'area_count'
      ? Math.max(1, Math.min(250, Number(requestedAreaCount) || 1))
      : plan?.division_basis === 'street_workload_target' ? plan.zones?.length || 0 : 0;
  const zones = plan?.zones || [];
  const selectedZone = zones.find((zone) => Number(zone.zone_number) === Number(selectedZoneNumber)) || null;
  const deploymentPlan = useMemo(() => planStaleReason ? {
    ...plan,
    qa: { ...(plan?.qa || initialQa()), deployable: false, warnings: [...new Set([...(plan?.qa?.warnings || []), planStaleReason])] },
  } : plan, [plan, planStaleReason]);
  const deployable = isTerritoryPlanDeployable(deploymentPlan, eligibleTeamIds);
  const activeDeployment = serverSession?.status === 'deployed';
  const closedDeployment = ['completed', 'recalled'].includes(serverSession?.status);
  const deployed = activeDeployment || closedDeployment;
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

  const generationBlockers = useMemo(() => {
    const blockers = [];
    const boundary = validateCanvasBoundary(polygon);
    if (!boundary.valid) blockers.push(boundary.message);
    if (roadFetchStatus === 'loading') blockers.push('Wait for the street network to finish loading.');
    if (roadFetchStatus === 'unavailable') blockers.push('Street data is unavailable. Retry before dividing this area.');
    if (roadFetchStatus !== 'ready' && boundary.valid && roadFetchStatus !== 'loading' && roadFetchStatus !== 'unavailable') blockers.push('Street data loads after you draw the global area.');
    if (divisionBasis === 'selected_reps' && requestedZoneCount < 1) blockers.push('Select at least one active rep. Canvas creates one territory per selected rep.');
    if (divisionBasis === 'selected_reps' && requestedZoneCount > 250) blockers.push('Canvas supports at most 250 territories in one campaign.');
    if (divisionBasis === 'area_count' && (requestedAreaCount < 1 || requestedAreaCount > 250)) blockers.push('Choose between 1 and 250 territories.');
    if (divisionBasis === 'street_workload_target' && (targetStreetWorkloadMiles < 0.1 || targetStreetWorkloadMiles > 25)) blockers.push('Choose an approximate street workload between 0.1 and 25 miles per territory.');
    return blockers;
  }, [divisionBasis, polygon, requestedAreaCount, requestedZoneCount, roadFetchStatus, targetStreetWorkloadMiles]);

  const refreshCampaignIndex = useCallback(async () => {
    if (!user?.id) return setCampaignIndex([]);
    setCampaignIndexLoading(true);
    try {
      const result = await listMyCanvasCampaigns();
      setCampaignIndex(result.campaigns);
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

  const loadCampaignMap = useCallback(async (campaign, { quiet = false } = {}) => {
    const id = campaignId(campaign);
    if (!id) return;
    if (!quiet) setLiveMapLoading(true);
    try {
      const result = await getCanvasCampaignMap({ campaignId: id });
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
        pins: (result.pins || []).map((pin) => ({
          ...pin,
          last_actor_name: rosterMembersById.get(String(pin.last_actor_team_member_id || ''))?.name || '',
        })),
      };
      setLiveCampaignMap(visibleResult);
      setLiveMapError('');
      window.dispatchEvent(new CustomEvent('fk-canvas-zones-updated', { detail: { zones: resultZones, workUnits: result.campaign?.work_units || [], previewOnly: false } }));
      window.dispatchEvent(new CustomEvent('fk-canvas-campaign-map-updated', { detail: visibleResult }));
      if (!quiet) toast.success('Shared campaign map loaded.');
    } catch (error) {
      setLiveMapError(error.message || 'The shared campaign map could not be loaded.');
      if (!quiet) toast.error(error.message || 'The shared campaign map could not be loaded.');
    } finally {
      if (!quiet) setLiveMapLoading(false);
    }
  }, [rosterMembersById]);

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
    const refresh = () => loadCampaignMap(campaign, { quiet: true });
    const interval = window.setInterval(refresh, CAMPAIGN_REFRESH_MS);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [liveCampaignMap?.campaign, loadCampaignMap]);

  useEffect(() => {
    const validIds = new Set(activeTeamMembers.map((member) => String(member.id)));
    setSelectedTeamMemberIds((current) => current.filter((id) => validIds.has(String(id))));
    if (deployed) return;
    setPlan((current) => {
      const reconciliation = reconcileCanvasPlanWithEligibleTeam(current, activeTeamMembers);
      if (!reconciliation.changed) return current;
      deploymentAttemptRef.current = null;
      if (reconciliation.requiresRegeneration) setPlanStaleReason('The selected-rep roster changed; regenerate the territories before deployment.');
      return reconciliation.plan;
    });
  }, [activeTeamMembers, deployed]);

  useEffect(() => {
    if (previousPolygonKey.current === polygonKey) return;
    previousPolygonKey.current = polygonKey;
    setPlan(null);
    setServerSession(null);
    setSelectedZoneNumber(null);
    setLiveCampaignMap(null);
    window.dispatchEvent(new CustomEvent('fk-canvas-campaign-map-updated', { detail: null }));
  }, [polygonKey]);

  useEffect(() => {
    if (!polygon.length) {
      setRoadNetwork(null);
      setRoadFetchStatus('idle');
      return undefined;
    }
    const boundary = validateCanvasBoundary(polygon);
    if (!boundary.valid) {
      setRoadNetwork(null);
      setRoadFetchStatus('invalid');
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
          setRoadFetchStatus('unavailable');
        }
      })
      .catch(() => { if (!cancelled) setRoadFetchStatus('unavailable'); });
    return () => { cancelled = true; };
  }, [polygonKey, roadFetchNonce]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('fk-canvas-zones-updated', { detail: { zones, workUnits: plan?.work_units || [], previewOnly: !deployed } }));
  }, [deployed, plan?.work_units, zones]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('fk-canvas-zone-selected', { detail: { zoneNumber: selectedZoneNumber } }));
  }, [selectedZoneNumber]);

  useEffect(() => {
    const handleSelection = (event) => {
      const zoneNumber = Number(event.detail?.zoneNumber);
      if (Number.isFinite(zoneNumber)) setSelectedZoneNumber(zoneNumber);
    };
    window.addEventListener('fk-canvas-zone-selected', handleSelection);
    return () => window.removeEventListener('fk-canvas-zone-selected', handleSelection);
  }, []);

  const markPlanStale = (message) => {
    if (!plan || deployed) return;
    setPlanStaleReason(message);
    deploymentAttemptRef.current = null;
  };

  const toggleTeamMember = (teamMemberId) => {
    if (deployed) return;
    const id = String(teamMemberId);
    setSelectedTeamMemberIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
    if (divisionBasis === 'selected_reps') markPlanStale('The selected reps changed; regenerate one territory per rep.');
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
    if (generationBlockers.length) return toast.error(generationBlockers[0]);
    if (typeof generateStreetPlan !== 'function') return toast.error('The street territory planner is unavailable.');
    setGenerating(true);
    const toastId = toast.loading('Dividing the global area along connected streets...');
    try {
      const result = await generateStreetPlan({
        polygon,
        roadNetwork,
        workload_basis: 'street_length',
        ...(divisionBasis === 'selected_reps'
          ? { selected_team_member_ids: selectedTeamMemberIds }
          : divisionBasis === 'area_count'
            ? { requested_zone_count: requestedZoneCount }
            : { target_street_workload_meters_per_area: targetWorkloadMeters }),
      });
      const failure = getCanvasPlannerFailureMessage(result);
      if (failure) throw new Error(failure);
      const nextPlan = normalizeGeneratedPlan(result, {
        divisionBasis,
        selectedTeamMemberIds,
        teamMembers: activeTeamMembers,
        targetWorkloadMeters,
      });
      if (!nextPlan.zones.length) throw new Error('The planner did not produce any connected territories.');
      if (nextPlan.zones.length > 250) throw new Error('This workload size creates more than 250 territories. Increase the approximate street miles per territory and generate again.');
      setPlan(nextPlan);
      setPlanStaleReason('');
      setServerSession(null);
      setLiveCampaignMap(null);
      deploymentAttemptRef.current = null;
      setSelectedZoneNumber(nextPlan.zones[0]?.zone_number || null);
      toast.success(`${nextPlan.zones.length} connected territories are ready to review.`, { id: toastId });
    } catch (error) {
      toast.error(error.message || 'Canvas planning failed.', { id: toastId });
    } finally {
      setGenerating(false);
    }
  };

  const autoAssign = () => {
    if (!plan || deployed) return;
    const assignmentPool = divisionBasis === 'selected_reps' ? selectedTeamMemberIds : activeTeamMembers.map((member) => String(member.id));
    if (!assignmentPool.length) return toast.error('No active reps are available for assignment.');
    setPlan((current) => planWithAssignments(current, assignmentPool, activeTeamMembers));
    deploymentAttemptRef.current = null;
    toast.success('Territories assigned by TeamMember ID.');
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
    if (!deploymentPlan) return null;
    setSaving(true);
    const toastId = quiet ? null : toast.loading('Saving the territory draft...');
    try {
      const payload = buildCanvasDraftPayload({
        sessionId: serverSession?.session_id,
        expectedVersion: serverSession?.version,
        sessionName,
        polygon,
        plan: deploymentPlan,
      });
      const saved = await saveCanvasDraft(payload);
      setServerSession(saved);
      setPlan((current) => current ? { ...current, qa: { ...current.qa, ...(saved.qa || {}) } } : current);
      refreshCampaignIndex();
      if (!quiet) toast.success(`Territory draft saved · version ${saved.version}`, { id: toastId });
      return saved;
    } catch (error) {
      toast.error(error.message, toastId ? { id: toastId } : undefined);
      return null;
    } finally {
      setSaving(false);
    }
  };

  const resumeDraft = async (draft = selectedDraft) => {
    const id = campaignId(draft);
    if (!id || resumingDraft) return;
    if (!teamMembersReady) return toast.error('Wait for the current Canvas rep roster to finish loading before resuming this draft.');
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
      setSelectedTeamMemberIds(divisionMode === 'selected_reps' ? restoredPlan.selected_team_member_ids || [] : []);
      setRequestedAreaCount(restoredPlan.zones.length);
      if (divisionMode === 'street_workload_target' && Number(restoredPlan.target_workload) > 0) {
        setTargetStreetWorkloadMiles(Number((Number(restoredPlan.target_workload) / 1609.344).toFixed(2)));
      }
      setPlan(restoredPlan);
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
      window.dispatchEvent(new CustomEvent('fk-canvas-campaign-map-updated', { detail: null }));
      toast.success(`Draft restored · server version ${campaign.version}`, { id: toastId });
    } catch (error) {
      toast.error(error.message || 'Canvas draft could not be restored.', { id: toastId });
    } finally {
      setResumingDraft(false);
    }
  };

  const deployPlan = async () => {
    if (!deployable || deployed) return toast.error('Assign every territory and clear all street QA blockers before deployment.');
    setDeploying(true);
    const toastId = toast.loading('Saving the final territory revision...');
    try {
      const reusableAttempt = deploymentAttemptRef.current;
      const saved = reusableAttempt
        && reusableAttempt.sessionId === serverSession?.session_id
        && reusableAttempt.version === Number(serverSession?.version)
        ? serverSession
        : await persistDraft({ quiet: true });
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
      toast.success(`Deployed ${zones.length} exclusive territories to ${deployedSession.rep_team_member_ids?.length || deployedSession.delivery_count || 0} reps.`, { id: toastId });
      loadCampaignMap(nextSession, { quiet: true });
    } catch (error) {
      const streetDataChanged = error?.code === 'topology_data_version_mismatch';
      if (streetDataChanged) {
        clearOverpassRoadNetworkCache(polygon, CANVAS_HIGHWAY_FILTER);
        deploymentAttemptRef.current = null;
        setPlanStaleReason('Street data changed on the server. Wait for fresh streets, then regenerate.');
        setRoadFetchNonce((value) => value + 1);
      }
      toast.error(error.message || 'Canvas campaign could not be deployed.', { id: toastId });
    } finally {
      setDeploying(false);
    }
  };

  const closeCampaign = async (action, campaign = serverSession) => {
    if (campaign?.status !== 'deployed' || closing) return;
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
      toast.success(action === 'complete' ? 'Campaign completed.' : 'Campaign recalled.', { id: toastId });
    } catch (error) {
      toast.error(`${error.message} Retry the same action to safely reuse the request.`, { id: toastId });
    } finally {
      setClosing(false);
    }
  };

  const startAnotherArea = () => {
    setPlan(null);
    setPlanStaleReason('');
    setServerSession(null);
    setSelectedZoneNumber(null);
    setLiveCampaignMap(null);
    setLiveMapError('');
    setSessionName('Canvas Cold Area');
    deploymentAttemptRef.current = null;
    closeAttemptRef.current = null;
    window.dispatchEvent(new CustomEvent('fk-canvas-zones-updated', { detail: { zones: [], workUnits: [], previewOnly: true } }));
    window.dispatchEvent(new CustomEvent('fk-canvas-campaign-map-updated', { detail: null }));
    onDraw();
  };

  const contentProps = {
    sessionName, changeSessionName, polygon, hasDrawnArea, onDraw, onClearPolygon, onClose,
    divisionBasis, setDivisionBasis, selectedTeamMemberIds, toggleTeamMember, activeTeamMembers, teamExclusions: teamEligibility.excluded,
    requestedAreaCount, setRequestedAreaCount, targetStreetWorkloadMiles, setTargetStreetWorkloadMiles, requestedZoneCount, roadFetchStatus, refreshRoadData,
    generationBlockers, generatePlan, generating, plan, planStaleReason,
    zones, assignedZoneCount, selectedZone, selectedZoneNumber, setSelectedZoneNumber,
    autoAssign, updateZoneAssignment, membersById,
    persistDraft, deployPlan, closeCampaign, saving, deploying, closing, deployable, serverSession, deployed, activeDeployment, closedDeployment,
    startAnotherArea,
    savedDrafts, selectedDraft, selectedDraftId, setSelectedDraftId, resumeDraft, resumingDraft,
    otherActiveCampaigns, selectedIndexedCampaign, selectedIndexedCampaignId, setSelectedIndexedCampaignId, campaignIndexLoading, campaignIndexError, refreshCampaignIndex,
    liveCampaignMap, liveMapLoading, liveMapError, loadCampaignMap, markPlanStale,
  };

  return (
    <div className="fixed inset-0 z-[2000] pointer-events-none lg:flex">
      <div className="hidden lg:block pointer-events-auto h-full w-[410px] bg-[#09090f]/95 border-r border-purple-500/20 shadow-2xl pt-[env(safe-area-inset-top)]"><BuilderContent {...contentProps} /></div>
      <div className={`lg:hidden pointer-events-auto absolute left-0 right-0 bottom-0 rounded-t-3xl bg-[#09090f]/98 border-t border-purple-500/25 shadow-2xl overflow-hidden pb-[env(safe-area-inset-bottom)] transition-[height] ${mobileCollapsed ? 'h-16' : 'h-[82dvh] max-h-[82vh]'}`}>
        <button type="button" onClick={() => setMobileCollapsed((value) => !value)} className="flex h-10 w-full items-center justify-center gap-2 text-[11px] font-bold text-purple-200" aria-expanded={!mobileCollapsed}>
          {mobileCollapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}{mobileCollapsed ? 'Open Canvas planner' : 'Collapse to inspect map'}
        </button>
        {!mobileCollapsed && <BuilderContent compact {...contentProps} />}
      </div>
    </div>
  );
}

function BuilderContent(props) {
  const {
    sessionName, changeSessionName, polygon, hasDrawnArea, onDraw, onClearPolygon, onClose,
    divisionBasis, setDivisionBasis, selectedTeamMemberIds, toggleTeamMember, activeTeamMembers, teamExclusions,
    requestedAreaCount, setRequestedAreaCount, targetStreetWorkloadMiles, setTargetStreetWorkloadMiles, requestedZoneCount, roadFetchStatus, refreshRoadData,
    generationBlockers, generatePlan, generating, plan, planStaleReason,
    zones, assignedZoneCount, selectedZone, selectedZoneNumber, setSelectedZoneNumber,
    autoAssign, updateZoneAssignment, membersById,
    persistDraft, deployPlan, closeCampaign, saving, deploying, closing, deployable, serverSession, deployed, activeDeployment, closedDeployment,
    startAnotherArea,
    savedDrafts, selectedDraft, selectedDraftId, setSelectedDraftId, resumeDraft, resumingDraft,
    otherActiveCampaigns, selectedIndexedCampaign, selectedIndexedCampaignId, setSelectedIndexedCampaignId, campaignIndexLoading, campaignIndexError, refreshCampaignIndex,
    liveCampaignMap, liveMapLoading, liveMapError, loadCampaignMap, markPlanStale, compact = false,
  } = props;

  return (
    <div className="h-full flex flex-col text-white">
      <div className="p-4 border-b border-white/10 flex items-center justify-between shrink-0">
        <div><h2 className="flex items-center gap-2 font-extrabold tracking-wide text-purple-300"><MapIcon className="w-5 h-5" /> CANVAS PLANNER</h2><p className="text-[10px] text-gray-500 mt-1">Global area → connected streets → exclusive rep territories</p></div>
        <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full"><X className="w-5 h-5 text-gray-300" /></button>
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
          <section className="rounded-2xl border border-amber-400/20 bg-amber-500/[0.06] p-3 space-y-2">
            <div className="flex items-center justify-between"><div><p className="text-xs font-black text-amber-100">Saved Canvas drafts</p><p className="text-[10px] text-gray-500">Resume the exact boundary, street plan, assignments, and server version.</p></div><button type="button" disabled={campaignIndexLoading} onClick={refreshCampaignIndex} className="text-[10px] font-bold text-amber-200">Refresh</button></div>
            <Select value={campaignId(selectedDraft)} onValueChange={setSelectedDraftId}><SelectTrigger className="h-10 border-white/10 bg-black/30 text-white"><SelectValue /></SelectTrigger><SelectContent className="z-[4000] border-white/10 bg-black text-white">{savedDrafts.map((draft) => <SelectItem key={campaignId(draft)} value={campaignId(draft)}>{draft.session_name} · {draft.zone_count} territories · v{draft.version}</SelectItem>)}</SelectContent></Select>
            <Button disabled={!selectedDraft || resumingDraft || !teamMembersReady} onClick={() => resumeDraft(selectedDraft)} className="h-10 w-full border border-amber-300/20 bg-amber-500/15 text-amber-50 hover:bg-amber-500/25">{resumingDraft || !teamMembersReady ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} {teamMembersReady ? 'Resume draft' : 'Loading rep roster…'}</Button>
          </section>
        )}

        {(otherActiveCampaigns.length > 0 || campaignIndexLoading || campaignIndexError) && (
          <section className="rounded-2xl border border-purple-400/20 bg-purple-500/[0.06] p-3 space-y-2">
            <div className="flex items-center justify-between"><p className="text-xs font-black text-purple-200">Active Canvas campaigns</p><button type="button" disabled={campaignIndexLoading} onClick={refreshCampaignIndex} className="text-[10px] font-bold text-purple-300">Refresh</button></div>
            {campaignIndexLoading && !otherActiveCampaigns.length && <p className="text-[11px] text-gray-400">Loading campaigns…</p>}
            {campaignIndexError && <p className="text-[11px] text-amber-300">{campaignIndexError}</p>}
            {selectedIndexedCampaign && <>
              <Select value={campaignId(selectedIndexedCampaign)} onValueChange={setSelectedIndexedCampaignId}><SelectTrigger className="h-10 border-white/10 bg-black/30 text-white"><SelectValue /></SelectTrigger><SelectContent className="z-[4000] border-white/10 bg-black text-white">{otherActiveCampaigns.map((campaign) => <SelectItem key={campaignId(campaign)} value={campaignId(campaign)}>{campaign.session_name} · {campaign.zone_count} territories</SelectItem>)}</SelectContent></Select>
              <div className="grid grid-cols-3 gap-2"><Button disabled={liveMapLoading} onClick={() => loadCampaignMap(selectedIndexedCampaign)} className="h-9 bg-purple-500/20 text-purple-100 border border-purple-400/25"><Eye className="h-4 w-4" /> Map</Button><Button disabled={closing} onClick={() => closeCampaign('complete', selectedIndexedCampaign)} className="h-9 bg-green-500/15 text-green-100 border border-green-400/25"><CheckCircle2 className="h-4 w-4" /> Done</Button><Button disabled={closing} onClick={() => closeCampaign('recall', selectedIndexedCampaign)} className="h-9 bg-red-500/15 text-red-100 border border-red-400/25"><AlertTriangle className="h-4 w-4" /> Recall</Button></div>
            </>}
          </section>
        )}

        {liveCampaignMap && <CampaignProgress map={liveCampaignMap} loading={liveMapLoading} error={liveMapError} onRefresh={() => loadCampaignMap(liveCampaignMap.campaign)} />}

        <section className="space-y-3">
          <StepLabel number="1" label="Draw the global area" />
          <Input disabled={deployed} value={sessionName} onChange={(event) => changeSessionName(event.target.value)} className="bg-[#151520] border-white/10 text-white h-11 font-bold" />
          <div className="grid grid-cols-2 gap-2"><Button disabled={deployed} onClick={onDraw} className="h-10 bg-purple-600 hover:bg-purple-500 text-white"><Pencil className="w-4 h-4" /> {hasDrawnArea ? 'Redraw area' : 'Draw area'}</Button><Button disabled={!hasDrawnArea || deployed} onClick={onClearPolygon} className="h-10 bg-white/10 text-white border border-white/10">Clear</Button></div>
          <TruthRow icon={MapPin} tone={polygon.length ? 'good' : 'idle'} title={polygon.length ? 'Global boundary ready' : 'Draw one freehand boundary'} detail={polygon.length ? 'This territory—not a house list—is the source of truth.' : 'Outline the entire cold area your team will work.'} />
          <TruthRow icon={Network} tone={roadFetchStatus === 'ready' ? 'good' : roadFetchStatus === 'loading' ? 'loading' : ['unavailable', 'invalid'].includes(roadFetchStatus) ? 'bad' : 'idle'} title={roadFetchStatus === 'ready' ? 'Street network loaded' : roadFetchStatus === 'loading' ? 'Reading streets' : roadFetchStatus === 'unavailable' ? 'Street network unavailable' : roadFetchStatus === 'invalid' ? 'Boundary needs changes' : 'Streets load after drawing'} detail={roadFetchStatus === 'ready' ? 'Canvas can now divide connected street work while protecting cul-de-sacs.' : roadFetchStatus === 'invalid' ? 'Canvas did not request street data for this unsupported boundary.' : 'Canvas will not substitute square grid areas.'} />
          {roadFetchStatus === 'unavailable' && <Button disabled={deployed} onClick={refreshRoadData} className="h-10 w-full border border-white/10 bg-white/5 text-white"><RefreshCw className="h-4 w-4" /> Retry street data</Button>}
        </section>

        <section className="space-y-3">
          <StepLabel number="2" label="Choose how to divide it" />
          <div className="grid grid-cols-2 gap-2">
            <ChoiceButton active={divisionBasis === 'selected_reps'} onClick={() => { if (!deployed) { setDivisionBasis('selected_reps'); markPlanStale('The division method changed; regenerate territories.'); } }} icon={Users} title="Selected reps" detail="Recommended · one each" />
            <ChoiceButton active={divisionBasis === 'street_workload_target'} onClick={() => { if (!deployed) { setDivisionBasis('street_workload_target'); markPlanStale('The workload size changed; regenerate territories.'); } }} icon={Network} title="Workload size" detail="Approx street miles each" />
          </div>
          <button type="button" disabled={deployed} onClick={() => { setDivisionBasis('area_count'); markPlanStale('The division method changed; regenerate territories.'); }} className={`w-full rounded-xl border px-3 py-2 text-left text-[10px] ${divisionBasis === 'area_count' ? 'border-purple-400 bg-purple-500/15 text-purple-100' : 'border-white/10 bg-white/[0.03] text-gray-400'}`}>Advanced · choose an exact number of territories</button>
          {divisionBasis === 'area_count' && <NumberField label="Number of territories" value={requestedAreaCount} min={1} max={250} disabled={deployed} onChange={(value) => { setRequestedAreaCount(value); markPlanStale('The territory count changed; regenerate.'); }} />}
          {divisionBasis === 'street_workload_target' && <><NumberField label="Approximate street workload per territory (miles)" value={targetStreetWorkloadMiles} min={0.1} max={25} step={0.1} disabled={deployed} onChange={(value) => { setTargetStreetWorkloadMiles(value); markPlanStale('The workload size changed; regenerate.'); }} /><p className="text-[10px] leading-relaxed text-gray-500">Canvas uses class-weighted, knockable street distance—not home counts. The final territory count is calculated after reading the streets and can be assigned across your reps.</p></>}
          {divisionBasis === 'selected_reps' && <RosterPicker activeTeamMembers={activeTeamMembers} selectedIds={selectedTeamMemberIds} toggle={toggleTeamMember} disabled={deployed} exclusions={teamExclusions} />}
          <div className="grid grid-cols-2 gap-2"><Metric label={divisionBasis === 'street_workload_target' ? 'Territories calculated' : 'Territories requested'} value={divisionBasis === 'street_workload_target' && !requestedZoneCount ? 'After generation' : requestedZoneCount} /><Metric label="Balance method" value="Street workload" /></div>
          {generationBlockers.length > 0 && <IssueList title="Before generation" issues={generationBlockers} tone="blocking" />}
          <Button disabled={deployed || generating || generationBlockers.length > 0} onClick={generatePlan} className="h-12 w-full bg-purple-600 hover:bg-purple-500 disabled:bg-gray-800 disabled:text-gray-500 text-white font-black">{generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />} Generate connected territories</Button>
        </section>

        {plan && <section className="space-y-3"><StepLabel number="3" label="Review street quality" /><PlannerQaPanel plan={plan} staleReason={planStaleReason} /></section>}

        {zones.length > 0 && (
          <section className="space-y-3">
            <div className="flex items-center justify-between"><StepLabel number="4" label="Assign and deploy" /><Button disabled={deployed || !activeTeamMembers.length} onClick={autoAssign} size="sm" className="bg-purple-600 text-white"><Wand2 className="w-4 h-4" /> Auto-assign</Button></div>
            <p className="text-[11px] text-gray-500">Each territory is exclusive. House decisions are created later by reps tapping their field map.</p>
            <div className={`grid gap-2 ${compact ? 'max-h-52' : 'max-h-64'} overflow-y-auto pr-1`}>{zones.map((zone) => { const member = membersById.get(String(zone.assigned_team_member_id || '')); return <button key={zone.zone_id || zone.zone_number} onClick={() => setSelectedZoneNumber(zone.zone_number)} className={`rounded-xl border p-3 text-left flex items-center gap-3 ${selectedZoneNumber === zone.zone_number ? 'border-purple-400 bg-purple-500/15' : 'border-white/10 bg-[#12121a]'}`}><span className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-xs font-extrabold" style={{ background: member ? zone.color || ASSIGNED_ZONE_COLOR : UNASSIGNED_ZONE_COLOR }}>{zone.zone_number}</span><span className="flex-1 min-w-0"><span className="block text-sm font-bold text-white">Territory {zone.zone_number}</span><span className={`block text-[10px] truncate ${member ? 'text-gray-400' : 'text-red-300'}`}>{formatCanvasDistance(zone.street_length_meters)} · {member?.name || member?.email || 'Unassigned'}</span></span></button>; })}</div>
            {selectedZone && <ZoneDetail zone={selectedZone} teamMembers={divisionBasis === 'selected_reps' ? activeTeamMembers.filter((member) => selectedTeamMemberIds.includes(String(member.id))) : activeTeamMembers} disabled={deployed} onAssignment={(teamMemberId) => updateZoneAssignment(selectedZone.zone_number, teamMemberId)} />}
          </section>
        )}
      </div>

      <div className="absolute bottom-0 left-0 right-0 p-4 bg-[#09090f] border-t border-white/10 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        <div className="mb-2 flex items-center justify-between text-[10px] text-gray-500"><span>{zones.length ? `${assignedZoneCount}/${zones.length} territories assigned` : 'No territory preview yet'}</span><span>{serverSession?.session_id ? `Server v${serverSession.version}` : 'Not saved'}</span></div>
        <div className="flex gap-2"><Button disabled={!plan || saving || deploying || closing || deployed} onClick={() => persistDraft()} className="h-12 px-4 bg-white/10 text-white border border-white/10"><Save className="w-4 h-4" /> Save draft</Button><Button disabled={!deployable || saving || deploying || closing || deployed} onClick={deployPlan} className="flex-1 h-12 bg-purple-600 hover:bg-purple-500 disabled:bg-gray-800 disabled:text-gray-500 text-white font-extrabold">{deploying || closing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />} {activeDeployment ? 'Deployed' : 'Deploy to reps'}</Button></div>
        {!deployable && plan && !deployed && <p className="mt-2 text-[10px] text-amber-300">Assign every territory and resolve street QA blockers before deployment.</p>}
      </div>
    </div>
  );
}

function RosterPicker({ activeTeamMembers, selectedIds, toggle, disabled, exclusions }) {
  return <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3"><div className="flex items-center justify-between mb-2"><p className="text-xs font-bold text-gray-300">Reps receiving one territory each</p><button disabled={disabled} onClick={() => { const allIds = activeTeamMembers.map((member) => String(member.id)); if (selectedIds.length === allIds.length) allIds.filter((id) => selectedIds.includes(id)).forEach(toggle); else allIds.filter((id) => !selectedIds.includes(id)).forEach(toggle); }} className="text-[10px] font-black text-purple-300">{selectedIds.length === activeTeamMembers.length && activeTeamMembers.length ? 'Clear' : 'Select active'}</button></div><div className="space-y-1.5 max-h-40 overflow-y-auto">{activeTeamMembers.map((member) => { const selected = selectedIds.includes(String(member.id)); return <button disabled={disabled} key={member.id} onClick={() => toggle(member.id)} className={`w-full rounded-xl border p-2.5 text-left flex items-center gap-3 ${selected ? 'border-purple-400/60 bg-purple-500/15' : 'border-white/10 bg-black/20'}`}><span className={`h-4 w-4 rounded border flex items-center justify-center ${selected ? 'border-purple-300 bg-purple-500' : 'border-white/20'}`}>{selected && <CheckCircle2 className="h-3 w-3" />}</span><span className="text-xs font-bold text-white truncate">{member.name || member.email}</span></button>; })}{!activeTeamMembers.length && <p className="text-xs text-amber-300">No active linked reps are available.</p>}</div>{(exclusions.non_rep > 0 || exclusions.unlinked > 0 || exclusions.inactive > 0) && <p className="mt-2 text-[10px] text-gray-500">Ineligible roster records are omitted until their role, account link, and active status are valid.</p>}</div>;
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
function ChoiceButton({ active, onClick, icon: Icon, title, detail }) { return <button onClick={onClick} className={`rounded-xl border p-3 text-left ${active ? 'border-purple-400 bg-purple-500/15' : 'border-white/10 bg-[#151520]'}`}><Icon className={`h-4 w-4 mb-2 ${active ? 'text-purple-300' : 'text-gray-500'}`} /><span className="block text-xs font-black text-white">{title}</span><span className="block text-[10px] text-gray-500 mt-1">{detail}</span></button>; }
function TruthRow({ icon: Icon, tone, title, detail }) { const colors = tone === 'good' ? 'border-green-500/20 bg-green-500/10 text-green-300' : tone === 'bad' ? 'border-red-500/20 bg-red-500/10 text-red-300' : tone === 'loading' ? 'border-blue-500/20 bg-blue-500/10 text-blue-300' : 'border-white/10 bg-white/[0.03] text-gray-400'; return <div className={`rounded-xl border p-3 flex items-start gap-3 ${colors}`}><Icon className={`h-4 w-4 mt-0.5 shrink-0 ${tone === 'loading' ? 'animate-pulse' : ''}`} /><div><p className="text-xs font-bold">{title}</p><p className="text-[10px] opacity-70 mt-0.5">{detail}</p></div></div>; }
function Metric({ label, value }) { return <div className="rounded-xl border border-white/10 bg-black/30 p-2.5"><p className="text-[9px] uppercase font-bold text-gray-500">{label}</p><p className="text-sm font-black text-white mt-1">{value}</p></div>; }
function NumberField({ label, value, min, max, step = 1, disabled, onChange }) { return <div><label className="text-[10px] font-bold text-gray-400 uppercase">{label}</label><Input disabled={disabled} type="number" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Math.max(min, Math.min(max, Number(event.target.value) || min)))} className="mt-1 bg-[#151520] border-white/10 text-white h-10 font-bold" /></div>; }
function IssueList({ title, issues, tone = 'warning' }) { const blocking = tone === 'blocking'; return <div className={`rounded-xl border p-3 ${blocking ? 'border-red-400/20 bg-red-400/10' : 'border-amber-400/20 bg-amber-400/10'}`}><p className={`text-[10px] font-black uppercase mb-1 ${blocking ? 'text-red-300' : 'text-amber-300'}`}>{title}</p>{(issues || []).map((issue, index) => <p key={`${issue}:${index}`} className="text-[11px] text-gray-300">• {typeof issue === 'string' ? issue : issue?.message || issue?.code}</p>)}</div>; }

function PlannerQaPanel({ plan, staleReason }) {
  const qa = normalizeQa(plan.qa);
  const gates = [['All street units covered', qa.street_coverage_complete], ['No duplicated street units', qa.no_duplicate_work_units], ['Territories stay connected', qa.connected_zones], ['Streets remain atomic', qa.atomic_work_units], ['Cul-de-sacs stay intact', qa.protected_units_intact]];
  const ready = !staleReason && qa.deployable !== false && gates.every(([, passed]) => passed);
  const workloadScores = (plan.zones || []).map((zone) => Number(zone.workload_score || 0)).filter((value) => value > 0);
  const shortest = workloadScores.length ? Math.min(...workloadScores) : 0;
  const longest = workloadScores.length ? Math.max(...workloadScores) : 0;
  const deviation = Number(qa.max_workload_deviation_percent ?? plan.diagnostics?.max_workload_deviation_percent ?? 0);
  const protectedOversize = (plan.zones || []).filter((zone) => zone.protected_unit_over_target === true).map((zone) => `Area ${zone.zone_number}`).join(', ');
  return <div className="rounded-2xl border border-white/10 bg-[#12121a] p-4 space-y-3"><div className="flex items-center justify-between"><div><p className="text-sm font-black text-white">Street-workload territory plan</p><p className="text-[10px] text-gray-500">Balanced by connected street distance—not a preloaded house list</p></div><Badge className={`border-none ${ready ? 'bg-green-500/15 text-green-300' : 'bg-amber-500/15 text-amber-300'}`}>{ready ? 'ready' : 'review'}</Badge></div>{workloadScores.length > 0 && <div className="grid grid-cols-3 gap-1.5"><Metric label="Shortest" value={formatCanvasDistance(shortest).replace(' of streets', '')} /><Metric label="Longest" value={formatCanvasDistance(longest).replace(' of streets', '')} /><Metric label="Max deviation" value={`${deviation}%`} /></div>}{protectedOversize && <p className="rounded-xl border border-amber-400/20 bg-amber-400/10 p-3 text-[11px] text-amber-100">{protectedOversize} exceeds the target because an atomic cul-de-sac or connected street component cannot be split safely.</p>}<div className="grid gap-1.5">{gates.map(([label, passed]) => <div key={label} className="flex items-center justify-between rounded-lg bg-black/25 px-3 py-2 text-xs"><span className="text-gray-300">{label}</span>{passed ? <ShieldCheck className="h-4 w-4 text-green-300" /> : <AlertTriangle className="h-4 w-4 text-amber-300" />}</div>)}</div>{staleReason && <IssueList title="Regeneration required" issues={[staleReason]} tone="blocking" />}{qa.warnings?.length > 0 && <IssueList title="Planner notes" issues={qa.warnings} />}</div>;
}

function ZoneDetail({ zone, teamMembers, disabled, onAssignment }) {
  const assignmentId = zone.assigned_team_member_id || '';
  return <section className="rounded-2xl border border-white/10 bg-[#12121a] p-4 space-y-3"><div className="flex items-center justify-between"><div><p className="text-sm font-black text-white">Territory {zone.zone_number}</p><p className="text-[11px] text-gray-500">{formatCanvasDistance(zone.street_length_meters)} · {zone.work_unit_ids?.length || 0} connected street units</p></div><span className="w-9 h-9 rounded-xl" style={{ background: assignmentId ? zone.color || ASSIGNED_ZONE_COLOR : UNASSIGNED_ZONE_COLOR }} /></div><Select disabled={disabled} value={assignmentId || '__unassigned__'} onValueChange={(value) => onAssignment(value === '__unassigned__' ? '' : value)}><SelectTrigger className="w-full h-10 rounded-xl bg-black/40 border border-white/10 text-sm text-white px-3"><SelectValue placeholder="Assign rep" /></SelectTrigger><SelectContent className="z-[4000] bg-black border-white/10 text-white"><SelectItem value="__unassigned__">Unassigned</SelectItem>{teamMembers.map((member) => <SelectItem key={member.id} value={String(member.id)}>{member.name || member.email}</SelectItem>)}</SelectContent></Select><p className="text-[10px] text-gray-500">To rebalance safely, change the reps or territory count and regenerate whole street units.</p></section>;
}
