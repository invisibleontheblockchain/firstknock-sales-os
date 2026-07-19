import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";
import { neon } from "npm:@neondatabase/serverless@0.9.0";

const json = (body: unknown, status = 200) => Response.json(body, { status });

function constantTimeEqual(left: string, right: string) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a[index] || 0) ^ (b[index] || 0);
  return difference === 0;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    // Base44 account admins are tenant admins, not platform operators. DDL also
    // requires an independently managed migration secret.
    if (String(user?.role || user?.data?.role || "").toLowerCase() !== "admin") {
      return json({ error: "forbidden", message: "Platform administrator access is required." }, 403);
    }
    const configuredMigrationSecret = Deno.env.get("FIELDROUTES_MIGRATION_SECRET") || "";
    const suppliedMigrationSecret = req.headers.get("x-fieldroutes-migration-secret") || "";
    if (configuredMigrationSecret.length < 32 || !constantTimeEqual(configuredMigrationSecret, suppliedMigrationSecret)) {
      return json({ error: "forbidden", message: "Platform migration authorization failed." }, 403);
    }

    const databaseUrl = Deno.env.get("DATABASE_URL") || "";
    if (!databaseUrl) return json({ error: "database_unavailable", message: "DATABASE_URL is not configured." }, 503);
    const sql = neon(databaseUrl);

    await sql`
      CREATE TABLE IF NOT EXISTS fieldroutes_connections (
        manager_id TEXT PRIMARY KEY,
        environment TEXT NOT NULL,
        subdomain TEXT,
        base_url TEXT NOT NULL,
        credential_envelope JSONB,
        default_service_type_id TEXT,
        default_service_type_name TEXT,
        office_id TEXT,
        source_id TEXT,
        appointment_duration_minutes INTEGER NOT NULL DEFAULT 60,
        connection_status TEXT NOT NULL DEFAULT 'unverified',
        config_revision INTEGER NOT NULL DEFAULT 1,
        verified_at TIMESTAMPTZ,
        disabled_at TIMESTAMPTZ,
        last_error_code TEXT,
        last_error_at TIMESTAMPTZ,
        last_token_usage JSONB,
        token_usage_observed_at TIMESTAMPTZ,
        worker_lease_token TEXT,
        worker_lease_acquired_at TIMESTAMPTZ,
        worker_lease_expires_at TIMESTAMPTZ,
        worker_next_claim_at TIMESTAMPTZ,
        created_by_user_id TEXT NOT NULL,
        updated_by_user_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS fieldroutes_inspection_requests (
        id TEXT PRIMARY KEY,
        manager_id TEXT NOT NULL REFERENCES fieldroutes_connections(manager_id),
        actor_user_id TEXT NOT NULL,
        actor_team_member_id TEXT,
        source_kind TEXT NOT NULL,
        source_reference TEXT NOT NULL,
        route_id TEXT,
        campaign_id TEXT,
        zone_id TEXT,
        pin_id TEXT,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        business_key TEXT NOT NULL,
        payload_envelope JSONB NOT NULL,
        address_validation_envelope JSONB,
        address_validation_input_hash TEXT,
        address_validation_receipt_hash TEXT,
        address_validation_version TEXT,
        address_validation_attempt_count INTEGER NOT NULL DEFAULT 0,
        address_validated_at TIMESTAMPTZ,
        state TEXT NOT NULL DEFAULT 'queued',
        checkpoint TEXT NOT NULL DEFAULT 'outbox_persisted',
        fieldroutes_customer_id TEXT,
        fieldroutes_appointment_id TEXT,
        appointment_marker TEXT NOT NULL,
        used_existing_customer BOOLEAN,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        reconciliation_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        retry_deadline_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
        lease_token TEXT,
        lease_acquired_at TIMESTAMPTZ,
        lease_expires_at TIMESTAMPTZ,
        last_http_status INTEGER,
        last_error_code TEXT,
        last_error_message TEXT,
        token_usage JSONB,
        supersedes_request_id TEXT,
        superseded_by_request_id TEXT,
        superseded_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        UNIQUE (manager_id, idempotency_key)
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS fieldroutes_sync_attempts (
        id TEXT PRIMARY KEY,
        manager_id TEXT NOT NULL,
        request_id TEXT NOT NULL REFERENCES fieldroutes_inspection_requests(id) ON DELETE CASCADE,
        operation TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        provider_http_status INTEGER,
        error_code TEXT,
        error_message TEXT,
        token_usage JSONB,
        response_metadata JSONB,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (request_id, operation, attempt_number)
      )
    `;

    // Additive upgrades for an installation that previously received a partial
    // version of the migration. No existing application/global table is altered.
    const additiveStatements = [
      "ALTER TABLE fieldroutes_connections ADD COLUMN IF NOT EXISTS config_revision INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE fieldroutes_connections ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ",
      "ALTER TABLE fieldroutes_connections ADD COLUMN IF NOT EXISTS last_error_code TEXT",
      "ALTER TABLE fieldroutes_connections ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMPTZ",
      "ALTER TABLE fieldroutes_connections ADD COLUMN IF NOT EXISTS default_service_type_name TEXT",
      "ALTER TABLE fieldroutes_connections ADD COLUMN IF NOT EXISTS last_token_usage JSONB",
      "ALTER TABLE fieldroutes_connections ADD COLUMN IF NOT EXISTS token_usage_observed_at TIMESTAMPTZ",
      "ALTER TABLE fieldroutes_connections ADD COLUMN IF NOT EXISTS worker_lease_token TEXT",
      "ALTER TABLE fieldroutes_connections ADD COLUMN IF NOT EXISTS worker_lease_acquired_at TIMESTAMPTZ",
      "ALTER TABLE fieldroutes_connections ADD COLUMN IF NOT EXISTS worker_lease_expires_at TIMESTAMPTZ",
      "ALTER TABLE fieldroutes_connections ADD COLUMN IF NOT EXISTS worker_next_claim_at TIMESTAMPTZ",
      "ALTER TABLE fieldroutes_inspection_requests ADD COLUMN IF NOT EXISTS reconciliation_count INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE fieldroutes_inspection_requests ADD COLUMN IF NOT EXISTS source_reference TEXT",
      "ALTER TABLE fieldroutes_inspection_requests ADD COLUMN IF NOT EXISTS appointment_marker TEXT",
      "ALTER TABLE fieldroutes_inspection_requests ADD COLUMN IF NOT EXISTS payload_envelope JSONB",
      "ALTER TABLE fieldroutes_inspection_requests ADD COLUMN IF NOT EXISTS address_validation_envelope JSONB",
      "ALTER TABLE fieldroutes_inspection_requests ADD COLUMN IF NOT EXISTS address_validation_input_hash TEXT",
      "ALTER TABLE fieldroutes_inspection_requests ADD COLUMN IF NOT EXISTS address_validation_receipt_hash TEXT",
      "ALTER TABLE fieldroutes_inspection_requests ADD COLUMN IF NOT EXISTS address_validation_version TEXT",
      "ALTER TABLE fieldroutes_inspection_requests ADD COLUMN IF NOT EXISTS address_validation_attempt_count INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE fieldroutes_inspection_requests ADD COLUMN IF NOT EXISTS address_validated_at TIMESTAMPTZ",
      "ALTER TABLE fieldroutes_inspection_requests ADD COLUMN IF NOT EXISTS retry_deadline_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')",
      "ALTER TABLE fieldroutes_inspection_requests ADD COLUMN IF NOT EXISTS lease_token TEXT",
      "ALTER TABLE fieldroutes_inspection_requests ADD COLUMN IF NOT EXISTS lease_acquired_at TIMESTAMPTZ",
      "ALTER TABLE fieldroutes_inspection_requests ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ",
      "ALTER TABLE fieldroutes_inspection_requests ADD COLUMN IF NOT EXISTS token_usage JSONB",
      "ALTER TABLE fieldroutes_inspection_requests ADD COLUMN IF NOT EXISTS supersedes_request_id TEXT",
      "ALTER TABLE fieldroutes_inspection_requests ADD COLUMN IF NOT EXISTS superseded_by_request_id TEXT",
      "ALTER TABLE fieldroutes_inspection_requests ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ",
      "ALTER TABLE fieldroutes_sync_attempts ADD COLUMN IF NOT EXISTS response_metadata JSONB"
    ];
    for (const statement of additiveStatements) await sql(statement);
    await sql`ALTER TABLE fieldroutes_connections ALTER COLUMN credential_envelope DROP NOT NULL`;
    await sql`
      DO $$
      DECLARE unique_name TEXT;
      BEGIN
        FOR unique_name IN
          SELECT constraint_row.conname
            FROM pg_constraint constraint_row
           WHERE constraint_row.conrelid = 'fieldroutes_inspection_requests'::regclass
             AND constraint_row.contype = 'u'
             AND ARRAY(
               SELECT attribute_row.attname::TEXT
                 FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key_row(attnum, position)
                 JOIN pg_attribute attribute_row
                   ON attribute_row.attrelid = constraint_row.conrelid
                  AND attribute_row.attnum = key_row.attnum
                ORDER BY key_row.position
             ) = ARRAY['manager_id', 'business_key']::TEXT[]
        LOOP
          EXECUTE format('ALTER TABLE fieldroutes_inspection_requests DROP CONSTRAINT %I', unique_name);
        END LOOP;
      END $$
    `;
    await sql`ALTER TABLE fieldroutes_inspection_requests DROP CONSTRAINT IF EXISTS fieldroutes_request_state_check`;

    const indexStatements = [
      "CREATE INDEX IF NOT EXISTS idx_fieldroutes_connections_status ON fieldroutes_connections(connection_status, updated_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_fieldroutes_requests_tenant_created ON fieldroutes_inspection_requests(manager_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_fieldroutes_requests_tenant_source ON fieldroutes_inspection_requests(manager_id, source_kind, source_reference)",
      "CREATE INDEX IF NOT EXISTS idx_fieldroutes_requests_queue ON fieldroutes_inspection_requests(state, next_retry_at, lease_expires_at)",
      "CREATE INDEX IF NOT EXISTS idx_fieldroutes_requests_actor ON fieldroutes_inspection_requests(manager_id, actor_user_id, created_at DESC)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_fieldroutes_requests_active_business ON fieldroutes_inspection_requests(manager_id, business_key) WHERE state <> 'superseded'",
      "CREATE INDEX IF NOT EXISTS idx_fieldroutes_attempts_request ON fieldroutes_sync_attempts(manager_id, request_id, started_at DESC)"
    ];
    for (const statement of indexStatements) await sql(statement);

    await sql`
      CREATE OR REPLACE FUNCTION fieldroutes_reject_manager_id_change()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.manager_id IS DISTINCT FROM OLD.manager_id THEN
          RAISE EXCEPTION 'manager_id is immutable';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `;

    for (const [tableName, triggerName] of [
      ["fieldroutes_connections", "fieldroutes_connections_manager_immutable"],
      ["fieldroutes_inspection_requests", "fieldroutes_requests_manager_immutable"],
      ["fieldroutes_sync_attempts", "fieldroutes_attempts_manager_immutable"]
    ]) {
      await sql(`DROP TRIGGER IF EXISTS ${triggerName} ON ${tableName}`);
      await sql(`CREATE TRIGGER ${triggerName} BEFORE UPDATE OF manager_id ON ${tableName} FOR EACH ROW EXECUTE FUNCTION fieldroutes_reject_manager_id_change()`);
    }

    // Constraints are installed idempotently because PostgreSQL does not support
    // ADD CONSTRAINT IF NOT EXISTS on all deployed Neon versions.
    await sql`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fieldroutes_connections_environment_check') THEN
          ALTER TABLE fieldroutes_connections ADD CONSTRAINT fieldroutes_connections_environment_check
            CHECK (environment IN ('production', 'legacy_staging'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fieldroutes_connections_status_check') THEN
          ALTER TABLE fieldroutes_connections ADD CONSTRAINT fieldroutes_connections_status_check
            CHECK (connection_status IN ('unverified', 'connected', 'error', 'disconnected'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fieldroutes_duration_check') THEN
          ALTER TABLE fieldroutes_connections ADD CONSTRAINT fieldroutes_duration_check
            CHECK (appointment_duration_minutes BETWEEN 5 AND 480);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fieldroutes_request_source_check') THEN
          ALTER TABLE fieldroutes_inspection_requests ADD CONSTRAINT fieldroutes_request_source_check
            CHECK (source_kind IN ('precision', 'canvas'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fieldroutes_request_state_check') THEN
          ALTER TABLE fieldroutes_inspection_requests ADD CONSTRAINT fieldroutes_request_state_check
            CHECK (state IN ('queued', 'processing', 'retry_wait', 'customer_reconcile', 'appointment_reconcile', 'synced', 'review_required', 'failed', 'superseded'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fieldroutes_request_hash_check') THEN
          ALTER TABLE fieldroutes_inspection_requests ADD CONSTRAINT fieldroutes_request_hash_check
            CHECK (request_hash ~ '^[a-f0-9]{64}$' AND business_key ~ '^[a-f0-9]{64}$');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fieldroutes_request_tenant_identity_unique') THEN
          ALTER TABLE fieldroutes_inspection_requests ADD CONSTRAINT fieldroutes_request_tenant_identity_unique
            UNIQUE (id, manager_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fieldroutes_attempt_request_tenant_fk') THEN
          ALTER TABLE fieldroutes_sync_attempts ADD CONSTRAINT fieldroutes_attempt_request_tenant_fk
            FOREIGN KEY (request_id, manager_id)
            REFERENCES fieldroutes_inspection_requests(id, manager_id) ON DELETE CASCADE;
        END IF;
      END $$
    `;

    return json({
      success: true,
      migration: "fieldroutes_phase_1_v1",
      tables: ["fieldroutes_connections", "fieldroutes_inspection_requests", "fieldroutes_sync_attempts"],
      global_property_tables_changed: false
    });
  } catch (error) {
    console.error("[setupFieldRoutesIntegration] migration failed");
    return json({ error: "migration_failed", message: "The FieldRoutes schema could not be prepared." }, 500);
  }
});
