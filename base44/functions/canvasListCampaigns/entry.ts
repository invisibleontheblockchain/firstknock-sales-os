import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { verifyCanvasLifecycleSession } from './canvasLifecycleSignature.js';

const CAMPAIGN_PAGE_SIZE = 100;
const MAX_CAMPAIGNS = 500;

function normalized(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

function canManageCanvas(user: any) {
  const appRole = normalized(user?.app_role || user?.data?.app_role);
  const accountRole = normalized(user?.role || user?.data?.role);
  return ['manager', 'admin'].includes(appRole) || ['manager', 'admin'].includes(accountRole);
}

function asArray(value: any) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

function deploymentSigningSecret() {
  const secret = Deno.env.get('CANVAS_DEPLOYMENT_SIGNING_SECRET') || '';
  return secret.length >= 32 ? secret : null;
}

Deno.serve(async (req: Request) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageCanvas(user)) return Response.json({ error: 'Manager access required' }, { status: 403 });

    // CanvasSession read RLS remains in force. The explicit manager filter and
    // post-filter prevent this index from becoming a cross-tenant discovery API.
    const sessions = [];
    for (let offset = 0; offset < MAX_CAMPAIGNS; offset += CAMPAIGN_PAGE_SIZE) {
      const page = asArray(await base44.entities.CanvasSession.filter(
        { manager_id: user.id },
        '-updated_date',
        CAMPAIGN_PAGE_SIZE,
        offset
      ));
      sessions.push(...page);
      if (page.length < CAMPAIGN_PAGE_SIZE) break;
    }

    const signingSecret = deploymentSigningSecret();
    const campaigns = [];
    let rejectedCampaigns = 0;
    for (const session of sessions) {
      if (String(session?.manager_id || '') !== String(user.id || '')) continue;
      if (session.status !== 'draft') {
        if (!signingSecret) {
          return Response.json({
            error: 'canvas_signing_unavailable',
            message: 'Canvas lifecycle signing is not configured. Active campaign records cannot be trusted.'
          }, { status: 503 });
        }
        const requiredState = session.status === 'deployed' ? 'active' : session.status;
        if (!await verifyCanvasLifecycleSession(signingSecret, session, requiredState)) {
          rejectedCampaigns += 1;
          continue;
        }
      }
      campaigns.push({
        session_id: session.id,
        session_name: session.session_name || 'Canvas Campaign',
        status: session.status || 'draft',
        lifecycle_state: session.lifecycle_state || (session.status === 'deployed' ? 'active' : null),
        version: Number(session.version || 0),
        zone_count: asArray(session.zones).length,
        target_homes: Math.max(0, Number(session.target_homes) || 0),
        rep_count: Math.max(0, Number(session.rep_count) || 0),
        draft_saved_at: session.draft_saved_at || null,
        deployed_at: session.deployed_at || null,
        closed_at: session.closed_at || null,
        close_action: session.close_action || null,
        integrity_status: session.status === 'draft' ? 'draft' : 'verified'
      });
    }

    return Response.json({
      success: true,
      campaigns,
      rejected_campaigns: rejectedCampaigns,
      truncated: sessions.length >= MAX_CAMPAIGNS
    });
  } catch (error: any) {
    console.error('[canvasListCampaigns]', error?.message || error);
    return Response.json({
      error: 'canvas_campaign_list_failed',
      message: 'Canvas campaigns could not be loaded.'
    }, { status: 503 });
  }
});
