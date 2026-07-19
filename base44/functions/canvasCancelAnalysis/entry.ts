import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const ACTIVE_STATUSES = ['queued', 'running', 'finalizing'];
const MAX_LARGE_TILE_COUNT = 128;
const MAX_TILE_ATTEMPTS = 4;
const INTERMEDIATE_STORAGE_POLICY = 'compact-terminal-intermediates-v1';

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
  if (!/^canvas_analysis_job_[a-f0-9]{64}$/.test(jobId)) {
    throw new HttpError(400, 'invalid_canvas_analysis_job', 'job_id is invalid.');
  }
  return jobId;
}

function mutationCommitted(mutation: any) {
  return mutation?.success === true && Number(mutation?.updated) === 1 && mutation?.has_more !== true;
}

async function compactCancelledIntermediates(base44: any, job: any) {
  if (job.intermediate_storage_compacted_at
    && Number(job.raw_evidence_bytes || 0) === 0
    && Number(job.analysis_result_bytes || 0) === 0) return job;
  const filter = { job_id: job.job_id, manager_id: job.manager_id };
  const evidence = asArray(await base44.asServiceRole.entities.CanvasAnalysisTileEvidence.filter(filter, null, MAX_LARGE_TILE_COUNT * MAX_TILE_ATTEMPTS + 1, 0));
  const tiles = asArray(await base44.asServiceRole.entities.CanvasAnalysisTile.filter(filter, null, MAX_LARGE_TILE_COUNT + 1, 0));
  if (evidence.length > MAX_LARGE_TILE_COUNT * MAX_TILE_ATTEMPTS || tiles.length > MAX_LARGE_TILE_COUNT) {
    throw new HttpError(409, 'canvas_intermediate_storage_ambiguous', 'Canvas refused to compact an intermediate set outside its bounded tile manifest.');
  }
  for (const row of evidence) await base44.asServiceRole.entities.CanvasAnalysisTileEvidence.delete(row.id);
  for (const row of tiles) await base44.asServiceRole.entities.CanvasAnalysisTile.delete(row.id);
  const compactedAt = new Date().toISOString();
  const mutation = await base44.asServiceRole.entities.CanvasAnalysisJob.updateMany({
    id: job.id,
    job_id: job.job_id,
    manager_id: job.manager_id,
    status: 'cancelled',
    version: Number(job.version || 0)
  }, { $set: {
    version: Number(job.version || 0) + 1,
    raw_evidence_bytes: 0,
    analysis_result_bytes: 0,
    intermediate_storage_compacted_at: compactedAt,
    intermediate_storage_policy: INTERMEDIATE_STORAGE_POLICY,
    updated_at: compactedAt
  } });
  if (!mutationCommitted(mutation)) throw new HttpError(409, 'canvas_intermediate_compaction_conflict', 'The cancelled analysis changed before compaction metadata committed.');
  const rows = asArray(await base44.asServiceRole.entities.CanvasAnalysisJob.filter(filter, null, 2, 0));
  if (rows.length !== 1 || rows[0].status !== 'cancelled') throw new HttpError(503, 'canvas_intermediate_compaction_unverified', 'Canvas could not verify cancelled-analysis compaction.');
  return rows[0];
}

Deno.serve(async (req: Request) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageCanvas(user)) return Response.json({ error: 'manager_access_required' }, { status: 403 });
    const body = await req.json().catch(() => ({}));
    const jobId = requiredJobId(body?.job_id);
    const managerId = String(user.id);
    let rows = asArray(await base44.asServiceRole.entities.CanvasAnalysisJob.filter({ job_id: jobId, manager_id: managerId }, null, 2, 0));
    if (rows.length !== 1 || rows[0].manager_id !== managerId) {
      throw new HttpError(404, 'canvas_analysis_job_not_found', 'The Canvas analysis job was not found in this manager tenant.');
    }
    const job = rows[0];
    if (job.status === 'cancelled') {
      await compactCancelledIntermediates(base44, job);
      return Response.json({ success: true, idempotent: true, job_id: jobId, status: 'cancelled' });
    }
    if (['complete', 'failed'].includes(job.status)) {
      throw new HttpError(409, 'canvas_analysis_job_terminal', `A ${job.status} Canvas analysis cannot be cancelled.`);
    }
    if (!ACTIVE_STATUSES.includes(job.status)) {
      throw new HttpError(409, 'canvas_analysis_job_state_invalid', 'The Canvas analysis is not in a cancellable state.');
    }
    const expectedVersion = Number(job.version || 0);
    const now = new Date().toISOString();
    const mutation = await base44.asServiceRole.entities.CanvasAnalysisJob.updateMany({
      id: job.id,
      job_id: jobId,
      manager_id: managerId,
      version: expectedVersion,
      status: { $in: ACTIVE_STATUSES },
    }, {
      $set: {
        status: 'cancelled',
        version: expectedVersion + 1,
        retryable: true,
        cancelled_at: now,
        cancelled_by_user_id: managerId,
        updated_at: now,
      },
      $unset: {
        lock_token: '',
        lock_acquired_at: '',
        lock_expires_at: '',
        processor_token: '',
        processor_token_hash: '',
      },
    });
    if (!mutationCommitted(mutation)) {
      rows = asArray(await base44.asServiceRole.entities.CanvasAnalysisJob.filter({ job_id: jobId, manager_id: managerId }, null, 2, 0));
      if (rows.length === 1 && rows[0].status === 'cancelled') {
        return Response.json({ success: true, idempotent: true, job_id: jobId, status: 'cancelled' });
      }
      throw new HttpError(409, 'canvas_analysis_cancel_conflict', 'The Canvas analysis changed before cancellation committed. Reload its status.');
    }
    rows = asArray(await base44.asServiceRole.entities.CanvasAnalysisJob.filter({ job_id: jobId, manager_id: managerId }, null, 2, 0));
    if (rows.length !== 1 || rows[0].status !== 'cancelled' || Number(rows[0].version) !== expectedVersion + 1) {
      throw new HttpError(503, 'canvas_analysis_cancel_unverified', 'Canvas could not verify that the analysis was cancelled.');
    }
    await compactCancelledIntermediates(base44, rows[0]);
    return Response.json({ success: true, idempotent: false, job_id: jobId, status: 'cancelled' });
  } catch (error: any) {
    if (error instanceof HttpError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    console.error('[canvasCancelAnalysis]', error?.message || error);
    return Response.json({ error: 'canvas_analysis_cancel_failed', message: 'Canvas could not cancel the residential analysis.' }, { status: 503 });
  }
});
