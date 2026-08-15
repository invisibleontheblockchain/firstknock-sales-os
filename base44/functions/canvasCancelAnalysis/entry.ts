import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

const MAX_REQUEST_BYTES = 8_192;
const MAX_RESPONSE_BYTES = 128_000;
const SERVICE_TIMEOUT_MS = 8_000;
const JOB_ID_PATTERN = /^canvas_analysis_job_[a-f0-9]{64}$/;

class HttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

function normalized(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function canManageCanvas(user: any) {
  const appRole = normalized(user?.app_role || user?.data?.app_role);
  const accountRole = normalized(user?.role || user?.data?.role);
  return ["manager", "admin"].includes(appRole) || ["manager", "admin"].includes(accountRole);
}

function asArray(value: any) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

function configuration() {
  const rawUrl = String(Deno.env.get("CANVAS_ANALYSIS_SERVICE_URL") || "").trim();
  const token = String(Deno.env.get("CANVAS_ANALYSIS_SERVICE_TOKEN") || "").trim();
  if (!rawUrl || token.length < 32) throw new HttpError(503, "canvas_analysis_service_unavailable", "Canvas residential analysis is not configured.");
  let url: URL;
  try {
    url = new URL(rawUrl.endsWith("/") ? rawUrl : `${rawUrl}/`);
  } catch {
    throw new HttpError(503, "canvas_analysis_service_unavailable", "Canvas residential analysis is not configured.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new HttpError(503, "canvas_analysis_service_unavailable", "Canvas residential analysis is not configured.");
  }
  return { url, token };
}

function requestId(value: unknown) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!JOB_ID_PATTERN.test(result)) throw new HttpError(400, "invalid_analysis_job_id", "A valid Canvas analysis job ID is required.");
  return result;
}

function serviceString(value: unknown, field: string, maxLength = 256, pattern?: RegExp) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > maxLength || (pattern && !pattern.test(result))) {
    throw new HttpError(502, "canvas_analysis_service_invalid_response", `Canvas analysis returned an invalid ${field}.`);
  }
  return result;
}

async function readBoundedJson(response: Response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new HttpError(502, "canvas_analysis_service_response_too_large", "Canvas analysis returned an oversized response.");
  if (!response.body) throw new HttpError(502, "canvas_analysis_service_invalid_response", "Canvas analysis returned no response body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new HttpError(502, "canvas_analysis_service_response_too_large", "Canvas analysis returned an oversized response.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(502, "canvas_analysis_service_invalid_response", "Canvas analysis returned invalid JSON.");
  }
}

async function cancelServiceJob(config: any, job: any) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SERVICE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(new URL(`v1/canvas/analyses/${encodeURIComponent(job.worker_job_id)}/cancel`, config.url), {
      method: "POST",
      headers: {
        "accept": "application/json",
        "authorization": `Bearer ${config.token}`,
        "content-type": "application/json",
        "idempotency-key": `cancel:${job.job_id}`,
      },
      body: JSON.stringify({ job_id: job.job_id, manager_id: String(job.manager_id) }),
      signal: controller.signal,
      redirect: "error",
    });
  } catch (error: any) {
    if (error?.name === "AbortError") throw new HttpError(504, "canvas_analysis_service_timeout", "Canvas analysis cancellation timed out. Check progress before retrying.");
    throw new HttpError(503, "canvas_analysis_service_unavailable", "Canvas analysis cancellation is temporarily unavailable.");
  } finally {
    clearTimeout(timeout);
  }
  const payload = await readBoundedJson(response);
  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) throw new HttpError(503, "canvas_analysis_service_unavailable", "Canvas analysis cancellation is temporarily unavailable.");
    throw new HttpError(502, "canvas_analysis_service_rejected", "Canvas analysis service rejected the cancellation request.");
  }
  return payload?.job && typeof payload.job === "object" ? payload.job : payload;
}

function publicJob(job: any) {
  return {
    success: true,
    job_id: job.job_id,
    status: job.status,
    progress_pct: Number(job.progress_pct || 0),
    tile_count: Number(job.tile_count || 0),
    completed_tile_count: Number(job.completed_tile_count || 0),
    failed_tile_count: Number(job.failed_tile_count || 0),
    poll_after_ms: null,
    ...(job.evidence_id ? { evidence_id: job.evidence_id } : {}),
    ...(job.snapshot_hash ? { snapshot_hash: job.snapshot_hash } : {}),
    ...(job.error_code ? { error: job.error_code } : {}),
    ...(job.error_message ? { message: job.error_message } : {}),
    retryable: job.retryable !== false,
  };
}

Deno.serve(async (req: Request) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "unauthorized", message: "Authentication required." }, { status: 401 });
    if (!canManageCanvas(user)) return Response.json({ error: "manager_access_required", message: "Manager access required." }, { status: 403 });
    const config = configuration();
    const declaredLength = Number(req.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) throw new HttpError(413, "analysis_request_too_large", "Canvas analysis request is too large.");
    const body = await req.json().catch(() => ({}));
    if (new TextEncoder().encode(JSON.stringify(body)).byteLength > MAX_REQUEST_BYTES) throw new HttpError(413, "analysis_request_too_large", "Canvas analysis request is too large.");
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "job_id")) {
      throw new HttpError(400, "invalid_analysis_request", "Canvas analysis cancellation accepts only a job ID.");
    }
    const jobId = requestId(body.job_id);
    const rows = asArray(await base44.asServiceRole.entities.CanvasAnalysisJob.filter({
      job_id: jobId,
      manager_id: user.id,
    }, "-created_at", 2));
    if (rows.length > 1) throw new HttpError(409, "duplicate_analysis_job", "Canvas analysis requires support review before it can continue.");
    const job = rows[0];
    if (!job) throw new HttpError(404, "analysis_job_not_found", "Canvas analysis job was not found.");
    if (["cancelled", "failed"].includes(job.status)) return Response.json(publicJob(job));
    if (job.status === "complete") throw new HttpError(409, "analysis_already_complete", "Completed Canvas evidence cannot be cancelled.");
    if (!job.worker_job_id) throw new HttpError(503, "analysis_job_invalid", "Canvas analysis job is missing its worker receipt.");

    const source = await cancelServiceJob(config, job);
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new HttpError(502, "canvas_analysis_service_invalid_response", "Canvas analysis returned an invalid cancellation receipt.");
    const returnedJobId = serviceString(source.job_id, "job ID", 96, JOB_ID_PATTERN);
    const returnedManagerId = serviceString(source.manager_id, "manager ID", 256);
    const returnedWorkerId = serviceString(source.worker_job_id, "worker job ID", 256, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
    if (returnedJobId !== jobId || returnedManagerId !== String(user.id) || returnedWorkerId !== job.worker_job_id) {
      throw new HttpError(502, "canvas_analysis_service_scope_mismatch", "Canvas analysis returned a job outside this workspace.");
    }
    if (source.status !== "cancelled") throw new HttpError(502, "canvas_analysis_service_invalid_transition", "Canvas analysis did not confirm cancellation.");
    const completedTileCount = Number(source.completed_tile_count ?? job.completed_tile_count ?? 0);
    const failedTileCount = Number(source.failed_tile_count ?? job.failed_tile_count ?? 0);
    const progressPct = Number(source.progress_pct ?? job.progress_pct ?? 0);
    if (!Number.isInteger(completedTileCount) || completedTileCount < Number(job.completed_tile_count || 0) || completedTileCount > Number(job.tile_count)
      || !Number.isInteger(failedTileCount) || failedTileCount < Number(job.failed_tile_count || 0) || failedTileCount > Number(job.tile_count)
      || !Number.isFinite(progressPct) || progressPct < Number(job.progress_pct || 0) || progressPct > 100) {
      throw new HttpError(502, "canvas_analysis_service_invalid_response", "Canvas analysis returned invalid cancellation totals.");
    }
    const now = new Date().toISOString();
    const nextVersion = Number(job.version || 1) + 1;
    const updates = {
      status: "cancelled",
      completed_tile_count: completedTileCount,
      failed_tile_count: failedTileCount,
      progress_pct: progressPct,
      worker_status_cursor: source.worker_status_cursor ? serviceString(source.worker_status_cursor, "status cursor", 512) : job.worker_status_cursor || null,
      cancelled_at: now,
      cancelled_by_user_id: String(user.id),
      updated_at: now,
      retryable: true,
      version: nextVersion,
    };
    const mutation = await base44.asServiceRole.entities.CanvasAnalysisJob.updateMany({
      id: job.id,
      manager_id: user.id,
      job_id: jobId,
      version: Number(job.version || 1),
    }, { $set: updates });
    if (mutation?.success !== true || Number(mutation?.updated) !== 1 || mutation?.has_more === true) {
      throw new HttpError(409, "analysis_job_changed", "Canvas analysis changed while cancelling. Reload its status.");
    }
    const saved = await base44.asServiceRole.entities.CanvasAnalysisJob.get(job.id).catch(() => null);
    if (!saved || saved.job_id !== jobId || String(saved.manager_id) !== String(user.id) || saved.status !== "cancelled" || Number(saved.version) !== nextVersion) {
      throw new HttpError(503, "analysis_job_commit_unverified", "Canvas analysis cancellation could not be verified. Reload its status.");
    }
    return Response.json(publicJob(saved));
  } catch (error: any) {
    if (error instanceof HttpError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    console.error("[canvasCancelAnalysis]", error?.name || "unexpected_error");
    return Response.json({ error: "canvas_analysis_cancel_failed", message: "Canvas analysis could not be cancelled." }, { status: 500 });
  }
});
