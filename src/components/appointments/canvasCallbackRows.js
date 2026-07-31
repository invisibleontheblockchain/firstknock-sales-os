import { base44 } from '@/api/base44Client';

// Canvas field logging lives in its own pin ledger (CanvasHousePin), not in
// InteractionLog, so a rep tapping "Callback" or "Appointment" on a Canvas door
// never reached this page. Pins are read through the role-aware campaign map
// function — managers see the whole campaign, reps only their zones — because
// CanvasHousePin is service-role/manager scoped at the entity level.
const CALLBACK_OUTCOMES = new Set(['callback', 'appointment']);
const MAX_CAMPAIGNS = 8;

async function campaignIdsForManager() {
    const response = await base44.functions.invoke('canvasListCampaigns', {});
    return (Array.isArray(response.data?.campaigns) ? response.data.campaigns : [])
        .filter((campaign) => campaign.status === 'deployed' || campaign.lifecycle_state === 'active')
        .map((campaign) => campaign.session_id)
        .filter(Boolean);
}

async function campaignIdsForRep() {
    const response = await base44.functions.invoke('canvasGetMyAssignments', {});
    const assignments = Array.isArray(response.data?.assignments) ? response.data.assignments : [];
    return [...new Set(assignments
        .map((assignment) => assignment.session_id || assignment.campaign_id)
        .filter(Boolean))];
}

function rowFromPin(pin, campaignName, managerId) {
    const scheduled = pin.latest_client_recorded_at || pin.last_event_at || null;
    return {
        id: `canvas-pin-${pin.pin_id}`,
        _source: 'canvas_pin',
        address_hash: null,
        manager_id: managerId,
        full_address: pin.address || `Canvas pin ${String(pin.pin_id).slice(0, 8)}`,
        is_unresolved_callback: !pin.address,
        homeowner_name: null,
        phone: null,
        // Canvas records when the decision happened, not a future slot, so the
        // pin's own timestamp is the only honest scheduled value available.
        scheduled_date: scheduled,
        industry: 'other',
        status: 'scheduled',
        outcome: pin.latest_outcome === 'appointment' ? 'pending' : 'follow_up',
        route_id: null,
        route_name: campaignName || 'Canvas campaign',
        zip_code: null,
        lat: pin.lat ?? null,
        lng: pin.lng ?? null,
        notes: pin.latest_note || (pin.latest_outcome === 'appointment' ? 'Appointment set in Canvas' : 'Callback set in Canvas'),
        created_date: pin.last_event_at || null,
    };
}

// Returns Canvas callback/appointment pins shaped like appointment rows.
// Canvas is optional per account, so any failure resolves to an empty list
// rather than blocking the appointments list.
export async function fetchCanvasCallbackRows({ isManager, managerId }) {
    const campaignIds = await (isManager ? campaignIdsForManager() : campaignIdsForRep()).catch(() => []);
    if (!campaignIds.length) return [];

    const maps = await Promise.all(campaignIds.slice(0, MAX_CAMPAIGNS).map((campaignId) =>
        base44.functions.invoke('canvasGetCampaignMap', { campaign_id: campaignId })
            .then((response) => response.data)
            .catch(() => null)
    ));

    return maps.filter(Boolean).flatMap((map) => {
        const campaignName = map.campaign?.session_name || map.session_name || null;
        return (Array.isArray(map.pins) ? map.pins : [])
            .filter((pin) => CALLBACK_OUTCOMES.has(String(pin.latest_outcome || '')))
            .map((pin) => rowFromPin(pin, campaignName, managerId));
    });
}