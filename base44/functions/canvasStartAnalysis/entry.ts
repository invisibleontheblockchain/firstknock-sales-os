import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

const MAX_REQUEST_BYTES = 512_000;
const MAX_RESPONSE_BYTES = 512_000;
const MAX_POLYGON_POINTS = 10_000;
const MAX_AREA_SQ_MI = 1_000;
const MAX_AREA_COUNT = 250;
const MAX_TILE_IDS = 5_000;
const SERVICE_TIMEOUT_MS = 12_000;
const JOB_ID_PATTERN = /^canvas_analysis_job_[a-f0-9]{64}$/;
const RELEASE_ID_PATTERN = /^cer1_[a-f0-9]{64}$/;
const TILE_ID_PATTERN = /^cet1_[a-f0-9]{64}$/;
const JOB_STATUSES = new Set(["queued", "running", "finalizing", "complete", "failed", "cancelled"]);

class HttpError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
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

function requiredString(value: unknown, field: string, maxLength = 256, pattern?: RegExp) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > maxLength || (pattern && !pattern.test(result))) {
    throw new HttpError(502, "canvas_analysis_service_invalid_response", `Canvas analysis returned an invalid ${field}.`);
  }
  return result;
}

function configuration() {
  const rawUrl = String(Deno.env.get("CANVAS_ANALYSIS_SERVICE_URL") || "").trim();
  const token = String(Deno.env.get("CANVAS_ANALYSIS_SERVICE_TOKEN") || "").trim();
  if (!rawUrl || token.length < 32) {
    throw new HttpError(503, "canvas_analysis_service_unavailable", "Canvas residential analysis is not configured.");
  }
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

function assertExactBody(body: any) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "invalid_analysis_request", "Canvas analysis requires a polygon and area count.");
  }
  const allowed = new Set(["polygon", "area_count", "retry_failed_job"]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new HttpError(400, "invalid_analysis_request", "Canvas analysis accepts only polygon and area-count controls.");
  }
  if (body.retry_failed_job !== undefined && typeof body.retry_failed_job !== "boolean") {
    throw new HttpError(400, "invalid_analysis_request", "retry_failed_job must be true or false.");
  }
}

function roundedCoordinate(value: unknown, min: number, max: number, field: string) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < min || numeric > max) {
    throw new HttpError(400, "invalid_polygon", `${field} contains an invalid coordinate.`);
  }
  return Number(numeric.toFixed(7));
}

function samePoint(left: any, right: any) {
  return left.lat === right.lat && left.lng === right.lng;
}

function minimalRotation(points: Array<{ lat: number; lng: number }>) {
  let best = points;
  let bestKey = JSON.stringify(points);
  for (let index = 1; index < points.length; index += 1) {
    const candidate = [...points.slice(index), ...points.slice(0, index)];
    const key = JSON.stringify(candidate);
    if (key < bestKey) {
      best = candidate;
      bestKey = key;
    }
  }
  return { points: best, key: bestKey };
}

function canonicalPolygon(input: any) {
  if (!Array.isArray(input) || input.length < 3 || input.length > MAX_POLYGON_POINTS) {
    throw new HttpError(400, "invalid_polygon", `polygon must contain 3-${MAX_POLYGON_POINTS} points.`);
  }
  const normalizedPoints = input.map((point, index) => ({
    lat: roundedCoordinate(point?.lat ?? point?.latitude, -90, 90, `polygon[${index}]`),
    lng: roundedCoordinate(point?.lng ?? point?.lon ?? point?.longitude, -180, 180, `polygon[${index}]`),
  }));
  const points = normalizedPoints.filter((point, index) => index === 0 || !samePoint(point, normalizedPoints[index - 1]));
  if (points.length > 3 && samePoint(points[0], points[points.length - 1])) points.pop();
  if (new Set(points.map((point) => `${point.lat}:${point.lng}`)).size < 3) {
    throw new HttpError(400, "invalid_polygon", "polygon needs at least three distinct points.");
  }
  const forward = minimalRotation(points);
  const reverse = minimalRotation([...points].reverse());
  return forward.key <= reverse.key ? forward.points : reverse.points;
}

function polygonAreaSqMi(points: Array<{ lat: number; lng: number }>) {
  const averageLat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const latScale = 69;
  const lngScale = 69 * Math.cos(averageLat * Math.PI / 180);
  const origin = points[0];
  const projected = points.map((point) => ({
    x: (point.lng - origin.lng) * lngScale,
    y: (point.lat - origin.lat) * latScale,
  }));
  let area = 0;
  for (let index = 0; index < projected.length; index += 1) {
    const next = projected[(index + 1) % projected.length];
    area += projected[index].x * next.y - next.x * projected[index].y;
  }
  return Math.abs(area) / 2;
}

function canonicalize(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

async function sha256(value: any) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readBoundedJson(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(502, "canvas_analysis_service_response_too_large", "Canvas analysis returned an oversized response.");
  }
  if (!response.body) throw new HttpError(502, "canvas_analysis_service_invalid_response", "Canvas analysis returned no response body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
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

async function callAnalysisService(config: any, path: string, body: any, jobId: string, retryFailed: boolean) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SERVICE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(new URL(path, config.url), {
      method: "POST",
      headers: {
        "accept": "application/json",
        "authorization": `Bearer ${config.token}`,
        "content-type": "application/json",
        "idempotency-key": jobId,
        "x-firstknock-retry-failed": retryFailed ? "true" : "false",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "error",
    });
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw new HttpError(504, "canvas_analysis_service_timeout", "Canvas residential analysis timed out. Retry safely.");
    }
    throw new HttpError(503, "canvas_analysis_service_unavailable", "Canvas residential analysis is temporarily unavailable.");
  } finally {
    clearTimeout(timeout);
  }
  const payload = await readBoundedJson(response, MAX_RESPONSE_BYTES);
  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      throw new HttpError(503, "canvas_analysis_service_unavailable", "Canvas residential analysis is temporarily unavailable.");
    }
    throw new HttpError(502, "canvas_analysis_service_rejected", "Canvas residential analysis rejected the server request.");
  }
  return payload;
}

function normalizeServiceJob(payload: any, expected: { jobId: string; managerId: string }) {
  const source = payload?.job && typeof payload.job === "object" ? payload.job : payload;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new HttpError(502, "canvas_analysis_service_invalid_response", "Canvas analysis returned an invalid job.");
  }
  const jobId = requiredString(source.job_id, "job ID", 96, JOB_ID_PATTERN);
  const managerId = requiredString(source.manager_id, "manager ID", 256);
  if (jobId !== expected.jobId || managerId !== expected.managerId) {
    throw new HttpError(502, "canvas_analysis_service_scope_mismatch", "Canvas analysis returned a job outside this workspace.");
  }
  const status = requiredString(source.status, "status", 32);
  if (!JOB_STATUSES.has(status)) throw new HttpError(502, "canvas_analysis_service_invalid_response", "Canvas analysis returned an unknown status.");
  const tileIds = asArray(source.tile_ids).map((id: unknown) => requiredString(id, "tile ID", 72, TILE_ID_PATTERN));
  if (tileIds.length < 1 || tileIds.length > MAX_TILE_IDS || new Set(tileIds).size !== tileIds.length) {
    throw new HttpError(502, "canvas_analysis_service_invalid_response", "Canvas analysis returned an invalid tile set.");
  }
  tileIds.sort();
  const tileCount = Number(source.tile_count);
  const completedTileCount = Number(source.completed_tile_count ?? 0);
  const failedTileCount = Number(source.failed_tile_count ?? 0);
  const progressPct = Number(source.progress_pct ?? 0);
  if (!Number.isInteger(tileCount) || tileCount !== tileIds.length
    || !Number.isInteger(completedTileCount) || completedTileCount < 0 || completedTileCount > tileCount
    || !Number.isInteger(failedTileCount) || failedTileCount < 0 || failedTileCount > tileCount
    || !Number.isFinite(progressPct) || progressPct < 0 || progressPct > 100) {
    throw new HttpError(502, "canvas_analysis_service_invalid_response", "Canvas analysis returned invalid progress totals.");
  }
  return {
    job_id: jobId,
    worker_job_id: requiredString(source.worker_job_id, "worker job ID", 256, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/),
    manager_id: managerId,
    status,
    provider: requiredString(source.provider, "provider", 128),
    release_id: requiredString(source.release_id, "release ID", 72, RELEASE_ID_PATTERN),
    manifest_hash: requiredString(source.manifest_hash, "manifest hash", 64, /^[a-f0-9]{64}$/),
    tile_scheme: requiredString(source.tile_scheme, "tile scheme", 128),
    tile_ids: tileIds,
    tile_count: tileCount,
    completed_tile_count: completedTileCount,
    failed_tile_count: failedTileCount,
    progress_pct: progressPct,
    worker_status_cursor: source.worker_status_cursor ? requiredString(source.worker_status_cursor, "status cursor", 512) : null,
    evidence_id: source.evidence_id ? requiredString(source.evidence_id, "evidence ID", 96, /^canvas_evidence_[a-f0-9]{64}$/) : null,
    snapshot_hash: source.snapshot_hash ? requiredString(source.snapshot_hash, "snapshot hash", 64, /^[a-f0-9]{64}$/) : null,
    summary: source.summary && typeof source.summary === "object" && !Array.isArray(source.summary) ? source.summary : {},
    error_code: source.error_code ? requiredString(source.error_code, "error code", 128, /^[a-z0-9_:-]+$/) : null,
    error_message: status === "failed" ? "Canvas residential analysis failed. Retry if the job is marked retryable." : null,
    retryable: source.retryable !== false,
  };
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
    poll_after_ms: ["queued", "running", "finalizing"].includes(job.status) ? 2_000 : null,
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
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      throw new HttpError(413, "analysis_request_too_large", "Canvas analysis request is too large.");
    }
    const body = await req.json().catch(() => {
      throw new HttpError(400, "invalid_analysis_request", "Canvas analysis requires valid JSON.");
    });
    if (new TextEncoder().encode(JSON.stringify(body)).byteLength > MAX_REQUEST_BYTES) {
      throw new HttpError(413, "analysis_request_too_large", "Canvas analysis request is too large.");
    }
    assertExactBody(body);
    const polygon = canonicalPolygon(body.polygon);
    const areaCount = Number(body.area_count);
    if (!Number.isInteger(areaCount) || areaCount < 1 || areaCount > MAX_AREA_COUNT) {
      throw new HttpError(400, "invalid_area_count", `area_count must be an integer from 1 through ${MAX_AREA_COUNT}.`);
    }
    const areaSqMi = polygonAreaSqMi(polygon);
    if (!Number.isFinite(areaSqMi) || areaSqMi <= 0 || areaSqMi > MAX_AREA_SQ_MI) {
      throw new HttpError(400, "invalid_polygon", `polygon area must be greater than zero and at most ${MAX_AREA_SQ_MI} square miles.`);
    }
    const identity = {
      purpose: "firstknock-canvas-analysis-v1",
      manager_id: String(user.id),
      polygon,
      area_count: areaCount,
    };
    const requestHash = await sha256(identity);
    const jobId = `canvas_analysis_job_${requestHash}`;
    const existingRows = asArray(await base44.asServiceRole.entities.CanvasAnalysisJob.filter({
      job_id: jobId,
      manager_id: user.id,
    }, "-created_at", 2));
    if (existingRows.length > 1) throw new HttpError(409, "duplicate_analysis_job", "Canvas analysis requires support review before it can continue.");
    const existing = existingRows[0] || null;
    const retryFailed = body.retry_failed_job === true && ["failed", "cancelled"].includes(existing?.status);
    if (existing && !retryFailed) return Response.json(publicJob(existing));

    const servicePayload = await callAnalysisService(config, "v1/canvas/analyses", {
      job_id: jobId,
      request_hash: requestHash,
      manager_id: String(user.id),
      polygon,
      area_count: areaCount,
      area_sq_mi: Number(areaSqMi.toFixed(6)),
      retry_failed_job: retryFailed,
    }, jobId, retryFailed);
    const serviceJob = normalizeServiceJob(servicePayload, { jobId, managerId: String(user.id) });
    const now = new Date().toISOString();
    const record = {
      job_id: jobId,
      request_hash: requestHash,
      manager_id: String(user.id),
      created_by_user_id: String(user.id),
      created_at: existing?.created_at || now,
      updated_at: now,
      status: serviceJob.status,
      version: Number(existing?.version || 0) + 1,
      polygon,
      area_sq_mi: Number(areaSqMi.toFixed(6)),
      provider: serviceJob.provider,
      release_id: serviceJob.release_id,
      manifest_hash: serviceJob.manifest_hash,
      tile_scheme: serviceJob.tile_scheme,
      tile_ids: serviceJob.tile_ids,
      tile_count: serviceJob.tile_count,
      completed_tile_count: serviceJob.completed_tile_count,
      failed_tile_count: serviceJob.failed_tile_count,
      progress_pct: serviceJob.progress_pct,
      worker_job_id: serviceJob.worker_job_id,
      worker_status_cursor: serviceJob.worker_status_cursor,
      evidence_id: serviceJob.evidence_id,
      snapshot_hash: serviceJob.snapshot_hash,
      summary: { ...serviceJob.summary, requested_area_count: areaCount },
      error_code: serviceJob.error_code,
      error_message: serviceJob.error_message,
      retryable: serviceJob.retryable,
    };
    let saved;
    if (existing) {
      const mutation = await base44.asServiceRole.entities.CanvasAnalysisJob.updateMany({
        id: existing.id,
        manager_id: user.id,
        job_id: jobId,
        version: Number(existing.version),
      }, { $set: record });
      if (mutation?.success !== true || Number(mutation?.updated) !== 1 || mutation?.has_more === true) {
        throw new HttpError(409, "analysis_job_changed", "Canvas analysis changed while retrying. Reload its status.");
      }
      saved = await base44.asServiceRole.entities.CanvasAnalysisJob.get(existing.id).catch(() => null);
    } else {
      saved = await base44.asServiceRole.entities.CanvasAnalysisJob.create(record);
    }
    if (!saved || saved.job_id !== jobId || String(saved.manager_id) !== String(user.id) || saved.request_hash !== requestHash) {
      throw new HttpError(503, "analysis_job_commit_unverified", "Canvas analysis started but its local receipt could not be verified. Retry safely.");
    }
    const duplicates = asArray(await base44.asServiceRole.entities.CanvasAnalysisJob.filter({
      job_id: jobId,
      manager_id: user.id,
    }, "-created_at", 2));
    if (duplicates.length !== 1) throw new HttpError(409, "duplicate_analysis_job", "Canvas analysis requires support review before it can continue.");
    return Response.json(publicJob(saved));
  } catch (error: any) {
    if (error instanceof HttpError) {
      return Response.json({ error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }, { status: error.status });
    }
    console.error("[canvasStartAnalysis]", error?.name || "unexpected_error");
    return Response.json({ error: "canvas_analysis_start_failed", message: "Canvas residential analysis could not be started." }, { status: 500 });
  }
});
