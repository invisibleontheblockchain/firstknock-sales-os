import { randomUUID } from 'node:crypto';

import { Pool, neonConfig } from '@neondatabase/serverless';
import WebSocket from 'ws';

import { ServiceError } from './errors.mjs';

neonConfig.webSocketConstructor = WebSocket;

const TERMINAL = new Set(['complete', 'failed', 'cancelled']);

function parsed(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

function normalizeJob(row) {
  if (!row) return null;
  return {
    ...row,
    polygon: parsed(row.polygon, []),
    tile_ids: parsed(row.tile_ids, []),
    summary: parsed(row.summary, {}),
    area_sq_mi: Number(row.area_sq_mi),
    area_count: Number(row.area_count),
    tile_count: Number(row.tile_count),
    completed_tile_count: Number(row.completed_tile_count),
    failed_tile_count: Number(row.failed_tile_count),
    progress_pct: Number(row.progress_pct),
    attempt: Number(row.attempt),
  };
}

function normalizeResult(row) {
  if (!row) return null;
  return { ...row, result_json: parsed(row.result_json, null), result_bytes: Number(row.result_bytes) };
}

export class PostgresStore {
  constructor(databaseUrl, { pool = null, maxConnections = 10 } = {}) {
    if (!databaseUrl && !pool) throw new ServiceError(503, 'database_not_configured', 'CANVAS_DATABASE_URL is required.');
    this.pool = pool || new Pool({ connectionString: databaseUrl, max: maxConnections });
    this.ownsPool = !pool;
    this.pool.on?.('error', () => console.error('[canvas-analysis-database] pool_error'));
  }

  async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS canvas_analysis_jobs (
        job_id text PRIMARY KEY,
        request_hash text NOT NULL,
        manager_id text NOT NULL,
        worker_job_id text NOT NULL UNIQUE,
        polygon jsonb NOT NULL,
        area_count integer NOT NULL CHECK (area_count BETWEEN 1 AND 250),
        area_sq_mi double precision NOT NULL CHECK (area_sq_mi > 0 AND area_sq_mi <= 1000),
        provider text NOT NULL,
        release_id text NOT NULL,
        manifest_hash text NOT NULL,
        tile_scheme text NOT NULL,
        tile_ids jsonb NOT NULL,
        tile_count integer NOT NULL CHECK (tile_count > 0),
        status text NOT NULL CHECK (status IN ('queued','running','finalizing','complete','failed','cancelled')),
        completed_tile_count integer NOT NULL DEFAULT 0,
        failed_tile_count integer NOT NULL DEFAULT 0,
        progress_pct double precision NOT NULL DEFAULT 0,
        worker_status_cursor text,
        evidence_id text,
        snapshot_hash text,
        summary jsonb NOT NULL DEFAULT '{}'::jsonb,
        error_code text,
        error_message text,
        retryable boolean NOT NULL DEFAULT true,
        cancel_requested boolean NOT NULL DEFAULT false,
        attempt integer NOT NULL DEFAULT 0,
        lease_token text,
        lease_owner text,
        lease_expires_at timestamptz,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        completed_at timestamptz,
        cancelled_at timestamptz
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS canvas_analysis_jobs_queue_idx
      ON canvas_analysis_jobs (status, created_at)
      WHERE status = 'queued'
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS canvas_analysis_jobs_manager_idx
      ON canvas_analysis_jobs (manager_id, updated_at DESC)
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS canvas_analysis_results (
        evidence_id text PRIMARY KEY,
        job_id text NOT NULL UNIQUE REFERENCES canvas_analysis_jobs(job_id),
        manager_id text NOT NULL,
        snapshot_hash text NOT NULL,
        result_hash text NOT NULL,
        result_bytes integer NOT NULL CHECK (result_bytes BETWEEN 1 AND 5500000),
        result_json jsonb NOT NULL,
        created_at timestamptz NOT NULL
      )
    `);
  }

  async enqueue(job, { retryFailed = false } = {}) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existingResult = await client.query('SELECT * FROM canvas_analysis_jobs WHERE job_id = $1 FOR UPDATE', [job.job_id]);
      const existing = normalizeJob(existingResult.rows[0]);
      if (existing) {
        if (existing.request_hash !== job.request_hash || existing.manager_id !== job.manager_id) {
          throw new ServiceError(409, 'job_identity_conflict', 'Canvas analysis job identity conflicts with an existing request.');
        }
        if (retryFailed && ['failed', 'cancelled'].includes(existing.status)) {
          const retried = await client.query(`
            UPDATE canvas_analysis_jobs SET
              status = 'queued', completed_tile_count = 0, failed_tile_count = 0,
              progress_pct = 0, worker_status_cursor = NULL, evidence_id = NULL,
              snapshot_hash = NULL, summary = '{}'::jsonb, error_code = NULL,
              error_message = NULL, retryable = true, cancel_requested = false,
              lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
              cancelled_at = NULL, updated_at = $2
            WHERE job_id = $1 RETURNING *
          `, [job.job_id, job.updated_at]);
          await client.query('COMMIT');
          return normalizeJob(retried.rows[0]);
        }
        await client.query('COMMIT');
        return existing;
      }
      const inserted = await client.query(`
        INSERT INTO canvas_analysis_jobs (
          job_id, request_hash, manager_id, worker_job_id, polygon, area_count,
          area_sq_mi, provider, release_id, manifest_hash, tile_scheme, tile_ids,
          tile_count, status, completed_tile_count, failed_tile_count, progress_pct,
          summary, retryable, cancel_requested, attempt, created_at, updated_at
        ) VALUES (
          $1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,'queued',0,0,0,
          '{}'::jsonb,true,false,0,$14,$14
        ) RETURNING *
      `, [
        job.job_id, job.request_hash, job.manager_id, job.worker_job_id,
        JSON.stringify(job.polygon), job.area_count, job.area_sq_mi, job.provider,
        job.release_id, job.manifest_hash, job.tile_scheme, JSON.stringify(job.tile_ids),
        job.tile_count, job.created_at,
      ]);
      await client.query('COMMIT');
      return normalizeJob(inserted.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async getJobByJobId(jobId, managerId) {
    const result = await this.pool.query('SELECT * FROM canvas_analysis_jobs WHERE job_id = $1 AND manager_id = $2', [jobId, managerId]);
    return normalizeJob(result.rows[0]);
  }

  async getJobByWorkerId(workerJobId, managerId, jobId = null) {
    const result = await this.pool.query(`
      SELECT * FROM canvas_analysis_jobs
      WHERE worker_job_id = $1 AND manager_id = $2 AND ($3::text IS NULL OR job_id = $3)
    `, [workerJobId, managerId, jobId]);
    return normalizeJob(result.rows[0]);
  }

  async claimNextJob(workerId, leaseMs = 60_000) {
    const leaseToken = randomUUID();
    const result = await this.pool.query(`
      WITH candidate AS (
        SELECT job_id, status FROM canvas_analysis_jobs
        WHERE (status = 'queued' OR (status IN ('running','finalizing') AND lease_expires_at < now()))
          AND cancel_requested = false
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE canvas_analysis_jobs AS job SET
        status = CASE WHEN candidate.status = 'finalizing' THEN 'finalizing' ELSE 'running' END,
        lease_token = $1, lease_owner = $2,
        lease_expires_at = now() + ($3::bigint * interval '1 millisecond'),
        attempt = attempt + 1, updated_at = now(), error_code = NULL, error_message = NULL
      FROM candidate WHERE job.job_id = candidate.job_id
      RETURNING job.*
    `, [leaseToken, workerId, leaseMs]);
    const claimed = normalizeJob(result.rows[0]);
    if (claimed) claimed.lease_ms = leaseMs;
    return claimed;
  }

  async updateProgress(job, completed, total) {
    const progress = Number(((completed / total) * 90).toFixed(3));
    const result = await this.pool.query(`
      UPDATE canvas_analysis_jobs SET completed_tile_count = GREATEST(completed_tile_count, $3), progress_pct = GREATEST(progress_pct, $4),
        worker_status_cursor = $5, lease_expires_at = now() + ($6::bigint * interval '1 millisecond'),
        updated_at = now()
      WHERE job_id = $1 AND lease_token = $2 AND status IN ('running','finalizing') AND cancel_requested = false
      RETURNING job_id
    `, [job.job_id, job.lease_token, completed, progress, `tiles:${completed}/${total}`, job.lease_ms || 120_000]);
    return result.rowCount === 1;
  }

  async markFinalizing(job) {
    const result = await this.pool.query(`
      UPDATE canvas_analysis_jobs SET status = 'finalizing', progress_pct = 95,
        worker_status_cursor = 'finalizing', lease_expires_at = now() + ($3::bigint * interval '1 millisecond'), updated_at = now()
      WHERE job_id = $1 AND lease_token = $2 AND status IN ('running','finalizing') AND cancel_requested = false
      RETURNING *
    `, [job.job_id, job.lease_token, job.lease_ms || 120_000]);
    return normalizeJob(result.rows[0]);
  }

  async isCancelled(job) {
    const result = await this.pool.query('SELECT status, cancel_requested, lease_token FROM canvas_analysis_jobs WHERE job_id = $1', [job.job_id]);
    const current = result.rows[0];
    return !current || current.status === 'cancelled' || current.cancel_requested === true || current.lease_token !== job.lease_token;
  }

  async completeJob(job, snapshot) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(`
        SELECT * FROM canvas_analysis_jobs
        WHERE job_id = $1 AND lease_token = $2 AND status = 'finalizing' AND cancel_requested = false
        FOR UPDATE
      `, [job.job_id, job.lease_token]);
      if (!locked.rows[0]) throw new ServiceError(409, 'job_lease_lost', 'Canvas analysis job lease was lost.');
      const existingResult = await client.query('SELECT * FROM canvas_analysis_results WHERE evidence_id = $1 FOR UPDATE', [snapshot.evidence_id]);
      if (existingResult.rows[0] && existingResult.rows[0].snapshot_hash !== snapshot.snapshot_hash) {
        throw new ServiceError(409, 'result_identity_conflict', 'Canvas analysis result identity conflicts with an existing snapshot.');
      }
      if (!existingResult.rows[0]) {
        await client.query(`
          INSERT INTO canvas_analysis_results (
            evidence_id, job_id, manager_id, snapshot_hash, result_hash,
            result_bytes, result_json, created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
        `, [
          snapshot.evidence_id, job.job_id, job.manager_id, snapshot.snapshot_hash,
          snapshot.result_hash, snapshot.result_bytes, JSON.stringify(snapshot), snapshot.created_at,
        ]);
      }
      const updated = await client.query(`
        UPDATE canvas_analysis_jobs SET status = 'complete', progress_pct = 100,
          completed_tile_count = tile_count, failed_tile_count = 0,
          worker_status_cursor = 'complete', evidence_id = $3, snapshot_hash = $4,
          summary = $5::jsonb, error_code = NULL, error_message = NULL,
          retryable = false, lease_token = NULL, lease_owner = NULL,
          lease_expires_at = NULL, completed_at = $6, updated_at = $6
        WHERE job_id = $1 AND lease_token = $2 RETURNING *
      `, [job.job_id, job.lease_token, snapshot.evidence_id, snapshot.snapshot_hash, JSON.stringify(snapshot.summary), snapshot.created_at]);
      if (!updated.rows[0]) throw new ServiceError(409, 'job_lease_lost', 'Canvas analysis job lease was lost.');
      await client.query('COMMIT');
      return normalizeJob(updated.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async failJob(job, code, message, retryable) {
    const result = await this.pool.query(`
      UPDATE canvas_analysis_jobs SET status = 'failed', failed_tile_count = GREATEST(failed_tile_count, 1),
        error_code = $3, error_message = $4, retryable = $5,
        lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
        updated_at = now()
      WHERE job_id = $1 AND lease_token = $2 AND status IN ('running','finalizing')
      RETURNING *
    `, [job.job_id, job.lease_token, code, message, retryable]);
    return normalizeJob(result.rows[0]);
  }

  async cancel(workerJobId, managerId, jobId, cancelledAt) {
    const result = await this.pool.query(`
      UPDATE canvas_analysis_jobs SET status = CASE WHEN status = 'complete' THEN status ELSE 'cancelled' END,
        cancel_requested = CASE WHEN status = 'complete' THEN cancel_requested ELSE true END,
        retryable = CASE WHEN status = 'complete' THEN retryable ELSE true END,
        lease_token = CASE WHEN status = 'complete' THEN lease_token ELSE NULL END,
        lease_owner = CASE WHEN status = 'complete' THEN lease_owner ELSE NULL END,
        lease_expires_at = CASE WHEN status = 'complete' THEN lease_expires_at ELSE NULL END,
        cancelled_at = CASE WHEN status = 'complete' THEN cancelled_at ELSE $4 END,
        updated_at = $4
      WHERE worker_job_id = $1 AND manager_id = $2 AND job_id = $3
      RETURNING *
    `, [workerJobId, managerId, jobId, cancelledAt]);
    return normalizeJob(result.rows[0]);
  }

  async getResult(evidenceId, managerId) {
    const result = await this.pool.query('SELECT * FROM canvas_analysis_results WHERE evidence_id = $1 AND manager_id = $2', [evidenceId, managerId]);
    return normalizeResult(result.rows[0]);
  }

  async getResultForJob(jobId, managerId) {
    const result = await this.pool.query('SELECT * FROM canvas_analysis_results WHERE job_id = $1 AND manager_id = $2', [jobId, managerId]);
    return normalizeResult(result.rows[0]);
  }

  async health() {
    await this.pool.query('SELECT 1');
    return true;
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }
}

export class MemoryStore {
  constructor() {
    this.jobs = new Map();
    this.results = new Map();
  }

  async migrate() {}

  async enqueue(job, { retryFailed = false } = {}) {
    const existing = this.jobs.get(job.job_id);
    if (existing) {
      if (existing.request_hash !== job.request_hash || existing.manager_id !== job.manager_id) throw new ServiceError(409, 'job_identity_conflict', 'Canvas analysis job identity conflict.');
      if (retryFailed && ['failed', 'cancelled'].includes(existing.status)) {
        Object.assign(existing, {
          status: 'queued', completed_tile_count: 0, failed_tile_count: 0, progress_pct: 0,
          worker_status_cursor: null, evidence_id: null, snapshot_hash: null, summary: {},
          error_code: null, error_message: null, retryable: true, cancel_requested: false,
          lease_token: null, lease_owner: null, lease_expires_at: null, cancelled_at: null,
          updated_at: job.updated_at,
        });
      }
      return structuredClone(existing);
    }
    const stored = {
      ...structuredClone(job), status: 'queued', completed_tile_count: 0, failed_tile_count: 0,
      progress_pct: 0, worker_status_cursor: null, evidence_id: null, snapshot_hash: null,
      summary: {}, error_code: null, error_message: null, retryable: true,
      cancel_requested: false, attempt: 0, lease_token: null,
    };
    this.jobs.set(job.job_id, stored);
    return structuredClone(stored);
  }

  async getJobByJobId(jobId, managerId) {
    const job = this.jobs.get(jobId);
    return job?.manager_id === managerId ? structuredClone(job) : null;
  }

  async getJobByWorkerId(workerJobId, managerId, jobId = null) {
    const job = [...this.jobs.values()].find((candidate) => candidate.worker_job_id === workerJobId
      && candidate.manager_id === managerId && (!jobId || candidate.job_id === jobId));
    return job ? structuredClone(job) : null;
  }

  async claimNextJob(workerId, leaseMs = 60_000) {
    const job = [...this.jobs.values()].filter((candidate) => candidate.status === 'queued' && !candidate.cancel_requested)
      .sort((left, right) => left.created_at.localeCompare(right.created_at))[0];
    if (!job) return null;
    Object.assign(job, {
      status: 'running', lease_token: randomUUID(), lease_owner: workerId,
      lease_expires_at: new Date(Date.now() + leaseMs).toISOString(), attempt: job.attempt + 1,
      lease_ms: leaseMs,
      updated_at: new Date().toISOString(), error_code: null, error_message: null,
    });
    return structuredClone(job);
  }

  current(job) {
    const current = this.jobs.get(job.job_id);
    return current && current.lease_token === job.lease_token ? current : null;
  }

  async updateProgress(job, completed, total) {
    const current = this.current(job);
    if (!current || current.status !== 'running' || current.cancel_requested) return false;
    Object.assign(current, {
      completed_tile_count: Math.max(current.completed_tile_count, completed),
      progress_pct: Math.max(current.progress_pct, Number(((completed / total) * 90).toFixed(3))),
      worker_status_cursor: `tiles:${completed}/${total}`,
      lease_expires_at: new Date(Date.now() + (job.lease_ms || 120_000)).toISOString(),
    });
    return true;
  }

  async markFinalizing(job) {
    const current = this.current(job);
    if (!current || current.status !== 'running' || current.cancel_requested) return null;
    Object.assign(current, {
      status: 'finalizing', progress_pct: 95, worker_status_cursor: 'finalizing',
      lease_expires_at: new Date(Date.now() + (job.lease_ms || 120_000)).toISOString(),
    });
    return structuredClone(current);
  }

  async isCancelled(job) {
    const current = this.current(job);
    return !current || current.status === 'cancelled' || current.cancel_requested;
  }

  async completeJob(job, snapshot) {
    const current = this.current(job);
    if (!current || current.status !== 'finalizing' || current.cancel_requested) throw new ServiceError(409, 'job_lease_lost', 'Canvas analysis job lease was lost.');
    const existing = this.results.get(snapshot.evidence_id);
    if (existing && existing.snapshot_hash !== snapshot.snapshot_hash) throw new ServiceError(409, 'result_identity_conflict', 'Canvas analysis result identity conflict.');
    this.results.set(snapshot.evidence_id, {
      evidence_id: snapshot.evidence_id, job_id: job.job_id, manager_id: job.manager_id,
      snapshot_hash: snapshot.snapshot_hash, result_hash: snapshot.result_hash,
      result_bytes: snapshot.result_bytes, result_json: structuredClone(snapshot), created_at: snapshot.created_at,
    });
    Object.assign(current, {
      status: 'complete', progress_pct: 100, completed_tile_count: current.tile_count,
      failed_tile_count: 0, worker_status_cursor: 'complete', evidence_id: snapshot.evidence_id,
      snapshot_hash: snapshot.snapshot_hash, summary: structuredClone(snapshot.summary), retryable: false,
      lease_token: null, lease_owner: null, lease_expires_at: null,
      completed_at: snapshot.created_at, updated_at: snapshot.created_at,
    });
    return structuredClone(current);
  }

  async failJob(job, code, message, retryable) {
    const current = this.current(job);
    if (!current || TERMINAL.has(current.status)) return null;
    Object.assign(current, { status: 'failed', failed_tile_count: Math.max(current.failed_tile_count, 1), error_code: code, error_message: message, retryable, lease_token: null });
    return structuredClone(current);
  }

  async cancel(workerJobId, managerId, jobId, cancelledAt) {
    const current = [...this.jobs.values()].find((job) => job.worker_job_id === workerJobId && job.manager_id === managerId && job.job_id === jobId);
    if (!current) return null;
    if (current.status !== 'complete') Object.assign(current, { status: 'cancelled', cancel_requested: true, retryable: true, lease_token: null, cancelled_at: cancelledAt, updated_at: cancelledAt });
    return structuredClone(current);
  }

  async getResult(evidenceId, managerId) {
    const result = this.results.get(evidenceId);
    return result?.manager_id === managerId ? structuredClone(result) : null;
  }

  async getResultForJob(jobId, managerId) {
    const result = [...this.results.values()].find((candidate) => candidate.job_id === jobId && candidate.manager_id === managerId);
    return result ? structuredClone(result) : null;
  }

  async health() { return true; }
  async close() {}
}
