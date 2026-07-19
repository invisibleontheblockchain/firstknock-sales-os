import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const PROCESSOR_REKICK_COOLDOWN_MS = 2_000;
const PROCESSOR_ACCEPT_WAIT_MS = 500;

class HttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function normalized(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

function canManageCanvas(user: any) {
  const appRole = normalized(user?.app_role || user?.data?.app_role);
  const accountRole = normalized(user?.role || user?.data?.role);
  return user?.is_owner === true || ['manager', 'admin'].includes(appRole) || ['manager', 'admin'].includes(accountRole);
}

function asArray(value: any) {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}

function requiredJobId(value: unknown) {
  const jobId = String(value || '').trim();
  if (!/^canvas_analysis_job_[a-f0-9]{64}$/.test(jobId)) throw new HttpError(400, 'invalid_canvas_analysis_job', 'job_id is invalid.');
  return jobId;
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function timestamp(value: unknown) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

async function kickIfStalled(base44: any, job: any) {
  if (!['queued', 'running', 'finalizing'].includes(job.status) || !job.processor_token) return false;
  const now = Date.now();
  const lockExpiresAt = timestamp(job.lock_expires_at);
  const activeLease = Boolean(job.lock_token) && lockExpiresAt > now;
  const recentlyKicked = now - timestamp(job.last_processor_kick_at || job.updated_at || job.created_at) < PROCESSOR_REKICK_COOLDOWN_MS;
  if (activeLease || recentlyKicked) return false;
  const invocation = base44.asServiceRole.functions.invoke('canvasStartAnalysis', {
    internal_action: 'process_large_analysis_job',
    job_id: job.job_id,
    processor_token: job.processor_token
  }).catch((error: any) => console.warn(`[canvasGetAnalysisStatus] processor re-kick failed for ${job.job_id}: ${error?.message || error}`));
  await Promise.race([invocation, sleep(PROCESSOR_ACCEPT_WAIT_MS)]);
  return true;
}

function responseForJob(job: any, processorRekicked: boolean) {
  const terminal = ['complete', 'failed', 'cancelled'].includes(job.status);
  return {
    success: true,
    job_id: job.job_id,
    status: job.status,
    progress_pct: job.status === 'complete' ? 100 : Number(job.progress_pct || 0),
    completed_tile_count: Number(job.completed_tile_count || 0),
    failed_tile_count: Number(job.failed_tile_count || 0),
    tile_count: Number(job.tile_count || 0),
    area_sq_mi: Number(job.area_sq_mi || 0),
    provider: job.provider || null,
    extraction_version: job.extraction_version || null,
    classifier_version: job.classifier_version || null,
    processor_rekicked: processorRekicked,
    poll_after_ms: terminal ? null : 1_500,
    ...(job.status === 'complete' ? {
      evidence_id: job.evidence_id,
      snapshot_hash: job.snapshot_hash,
      summary: job.summary || null
    } : {}),
    ...(job.status === 'failed' ? {
      error: job.error_code || 'canvas_large_analysis_failed',
      message: job.error_message || 'Large Canvas analysis failed.',
      retryable: job.retryable === true
    } : {}),
    ...(job.status === 'cancelled' ? {
      message: 'Large Canvas analysis was cancelled by the manager.',
      retryable: true,
      cancelled_at: job.cancelled_at || null,
    } : {})
  };
}

Deno.serve(async (req: Request) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageCanvas(user)) return Response.json({ error: 'manager_access_required' }, { status: 403 });
    const body = await req.json().catch(() => ({}));
    const jobId = requiredJobId(body?.job_id);
    let jobs = asArray(await base44.asServiceRole.entities.CanvasAnalysisJob.filter({ job_id: jobId, manager_id: user.id }, null, 2, 0));
    if (jobs.length !== 1 || jobs[0].manager_id !== String(user.id)) throw new HttpError(404, 'canvas_analysis_job_not_found', 'The Canvas analysis job was not found in this manager tenant.');
    const processorRekicked = await kickIfStalled(base44, jobs[0]);
    if (processorRekicked) {
      jobs = asArray(await base44.asServiceRole.entities.CanvasAnalysisJob.filter({ job_id: jobId, manager_id: user.id }, null, 2, 0));
      if (jobs.length !== 1) throw new HttpError(409, 'canvas_analysis_job_identity_collision', 'The Canvas analysis job identity became ambiguous.');
    }
    return Response.json(responseForJob(jobs[0], processorRekicked));
  } catch (error: any) {
    if (error instanceof HttpError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    console.error('[canvasGetAnalysisStatus]', error?.message || error);
    return Response.json({ error: 'canvas_analysis_status_unavailable', message: 'Canvas analysis progress is temporarily unavailable.' }, { status: 503 });
  }
});
