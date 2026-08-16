import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";
import { neon } from "npm:@neondatabase/serverless@0.9.0";

const MIGRATION_VERSION = "canvas_operational_v2_lifecycle";
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
    // A tenant administrator is not sufficient authorization for platform DDL.
    // The independently managed migration secret is required as a second gate.
    if (String(user?.role || user?.data?.role || "").toLowerCase() !== "admin") {
      return json({ error: "forbidden", message: "Platform administrator access is required." }, 403);
    }
    const configuredSecret = Deno.env.get("CANVAS_OPERATIONAL_MIGRATION_SECRET") || "";
    // The secret may arrive via header or JSON body; both are TLS-protected and
    // compared constant-time. The body path exists because some invocation
    // tooling cannot set custom headers.
    const body = await req.json().catch(() => ({}));
    const suppliedSecret = req.headers.get("x-canvas-migration-secret") || String(body?.migration_secret || "");
    if (configuredSecret.length < 32 || !constantTimeEqual(configuredSecret, suppliedSecret)) {
      return json({ error: "forbidden", message: "Canvas migration authorization failed." }, 403);
    }

    // Canvas operations intentionally use their own database boundary. Never
    // fall back to the property/Precision DATABASE_URL.
    const databaseUrl = Deno.env.get("CANVAS_DATABASE_URL") || "";
    if (!databaseUrl) {
      return json({ error: "canvas_database_unavailable", message: "CANVAS_DATABASE_URL is not configured." }, 503);
    }
    const sql = neon(databaseUrl);

    await sql`CREATE EXTENSION IF NOT EXISTS postgis`;

    await sql`
      CREATE TABLE IF NOT EXISTS canvas_operational_schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS canvas_deployments (
        campaign_id TEXT PRIMARY KEY,
        manager_id TEXT NOT NULL,
        plan_version INTEGER NOT NULL,
        plan_hash TEXT NOT NULL,
        lifecycle_version BIGINT NOT NULL DEFAULT 1,
        assignment_index_version BIGINT NOT NULL DEFAULT 1,
        evidence_release_id TEXT,
        classification_revision_id TEXT,
        algorithm_version TEXT,
        status TEXT NOT NULL DEFAULT 'packaging',
        deployed_at TIMESTAMPTZ,
        closed_at TIMESTAMPTZ,
        closed_by_user_id TEXT,
        lifecycle_action TEXT,
        lifecycle_idempotency_key TEXT,
        superseded_by_campaign_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (campaign_id, manager_id),
        CONSTRAINT canvas_deployments_plan_version_check CHECK (plan_version >= 1),
        CONSTRAINT canvas_deployments_plan_hash_check CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
        CONSTRAINT canvas_deployments_lifecycle_version_check CHECK (lifecycle_version >= 1),
        CONSTRAINT canvas_deployments_assignment_index_check CHECK (assignment_index_version >= 1),
        CONSTRAINT canvas_deployments_status_check CHECK (
          status IN ('packaging', 'active', 'completed', 'recalled', 'superseded', 'quarantined')
        )
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS canvas_assignments (
        assignment_id TEXT PRIMARY KEY,
        manager_id TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        zone_id TEXT NOT NULL,
        assignee_user_id TEXT NOT NULL,
        team_member_id TEXT NOT NULL,
        package_version BIGINT NOT NULL DEFAULT 1,
        package_status TEXT NOT NULL DEFAULT 'pending',
        status TEXT NOT NULL DEFAULT 'packaging',
        territory_hash TEXT NOT NULL,
        valid_from TIMESTAMPTZ,
        valid_until TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        revocation_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (assignment_id, manager_id),
        UNIQUE (assignment_id, manager_id, campaign_id, zone_id),
        UNIQUE (manager_id, campaign_id, zone_id, package_version),
        CONSTRAINT canvas_assignments_deployment_fk FOREIGN KEY (campaign_id, manager_id)
          REFERENCES canvas_deployments(campaign_id, manager_id) ON DELETE CASCADE,
        CONSTRAINT canvas_assignments_package_version_check CHECK (package_version >= 1),
        CONSTRAINT canvas_assignments_territory_hash_check CHECK (territory_hash ~ '^[a-f0-9]{64}$'),
        CONSTRAINT canvas_assignments_package_status_check CHECK (
          package_status IN ('pending', 'building', 'ready', 'failed', 'revoked', 'expired')
        ),
        CONSTRAINT canvas_assignments_status_check CHECK (
          status IN ('packaging', 'active', 'completed', 'revoked', 'superseded')
        ),
        CONSTRAINT canvas_assignments_validity_check CHECK (
          valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from
        ),
        CONSTRAINT canvas_assignments_revocation_check CHECK (
          status <> 'revoked' OR (revoked_at IS NOT NULL AND NULLIF(BTRIM(revocation_reason), '') IS NOT NULL)
        )
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS canvas_work_unit_ownership (
        manager_id TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        zone_id TEXT NOT NULL,
        work_unit_id TEXT NOT NULL,
        protected_group_id TEXT,
        geometry geometry(MultiLineString, 4326) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (manager_id, campaign_id, work_unit_id),
        CONSTRAINT canvas_work_units_deployment_fk FOREIGN KEY (campaign_id, manager_id)
          REFERENCES canvas_deployments(campaign_id, manager_id) ON DELETE CASCADE,
        CONSTRAINT canvas_work_units_assignment_fk FOREIGN KEY (assignment_id, manager_id, campaign_id, zone_id)
          REFERENCES canvas_assignments(assignment_id, manager_id, campaign_id, zone_id) ON DELETE CASCADE
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS canvas_changes (
        cursor BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        manager_id TEXT NOT NULL,
        campaign_id TEXT,
        zone_id TEXT,
        assignment_id TEXT,
        change_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        entity_version BIGINT NOT NULL DEFAULT 1,
        payload JSONB NOT NULL DEFAULT '{}'::JSONB,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (cursor, manager_id),
        CONSTRAINT canvas_changes_version_check CHECK (entity_version >= 1),
        CONSTRAINT canvas_changes_type_check CHECK (
          change_type IN (
            'pin_upsert', 'decision_event', 'dnc_upsert', 'dnc_revoke',
            'assignment_replaced', 'assignment_revoked', 'campaign_closed', 'progress_changed'
          )
        )
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS canvas_house_events (
        event_id TEXT PRIMARY KEY,
        manager_id TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        zone_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        actor_team_member_id TEXT,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        change_cursor BIGINT NOT NULL UNIQUE,
        pin_id TEXT NOT NULL,
        opportunity_id TEXT,
        street_unit_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        note TEXT,
        address TEXT,
        building_feature_id TEXT,
        unit_label TEXT,
        point geometry(Point, 4326) NOT NULL,
        client_recorded_at TIMESTAMPTZ NOT NULL,
        server_recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        applied_to_latest BOOLEAN NOT NULL DEFAULT TRUE,
        pin_version BIGINT NOT NULL,
        UNIQUE (event_id, manager_id),
        UNIQUE (event_id, manager_id, campaign_id, zone_id),
        UNIQUE (manager_id, actor_user_id, idempotency_key),
        CONSTRAINT canvas_events_assignment_fk FOREIGN KEY (assignment_id, manager_id, campaign_id, zone_id)
          REFERENCES canvas_assignments(assignment_id, manager_id, campaign_id, zone_id),
        CONSTRAINT canvas_events_change_fk FOREIGN KEY (change_cursor, manager_id)
          REFERENCES canvas_changes(cursor, manager_id),
        CONSTRAINT canvas_events_request_hash_check CHECK (request_hash ~ '^[a-f0-9]{64}$'),
        CONSTRAINT canvas_events_pin_version_check CHECK (pin_version >= 1),
        CONSTRAINT canvas_events_outcome_check CHECK (
          outcome IN ('no_answer', 'not_interested', 'callback', 'appointment', 'sale', 'do_not_knock')
        )
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS canvas_house_pins (
        pin_id TEXT PRIMARY KEY,
        manager_id TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        zone_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        house_key TEXT,
        opportunity_id TEXT,
        street_unit_id TEXT NOT NULL,
        point geometry(Point, 4326) NOT NULL,
        address TEXT,
        normalized_address TEXT,
        building_feature_id TEXT,
        unit_label TEXT,
        normalized_unit_label TEXT,
        latest_outcome TEXT NOT NULL,
        latest_note TEXT,
        latest_event_id TEXT NOT NULL,
        latest_change_cursor BIGINT NOT NULL,
        latest_client_recorded_at TIMESTAMPTZ NOT NULL,
        last_event_at TIMESTAMPTZ NOT NULL,
        last_actor_user_id TEXT NOT NULL,
        last_actor_team_member_id TEXT,
        version BIGINT NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (pin_id, manager_id),
        CONSTRAINT canvas_pins_assignment_fk FOREIGN KEY (assignment_id, manager_id, campaign_id, zone_id)
          REFERENCES canvas_assignments(assignment_id, manager_id, campaign_id, zone_id),
        CONSTRAINT canvas_pins_latest_event_fk FOREIGN KEY (latest_event_id, manager_id, campaign_id, zone_id)
          REFERENCES canvas_house_events(event_id, manager_id, campaign_id, zone_id),
        CONSTRAINT canvas_pins_latest_change_fk FOREIGN KEY (latest_change_cursor, manager_id)
          REFERENCES canvas_changes(cursor, manager_id),
        CONSTRAINT canvas_pins_version_check CHECK (version >= 1),
        CONSTRAINT canvas_pins_outcome_check CHECK (
          latest_outcome IN ('no_answer', 'not_interested', 'callback', 'appointment', 'sale', 'do_not_knock')
        )
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS canvas_dnc_suppressions (
        suppression_id TEXT PRIMARY KEY,
        manager_id TEXT NOT NULL,
        house_key TEXT,
        point geometry(Point, 4326) NOT NULL,
        source_event_id TEXT NOT NULL,
        source_campaign_id TEXT NOT NULL,
        source_zone_id TEXT NOT NULL,
        set_by_user_id TEXT NOT NULL,
        set_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        active BOOLEAN NOT NULL DEFAULT TRUE,
        version BIGINT NOT NULL DEFAULT 1,
        change_cursor BIGINT NOT NULL UNIQUE,
        revoked_by_user_id TEXT,
        revoked_at TIMESTAMPTZ,
        revocation_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (suppression_id, manager_id),
        CONSTRAINT canvas_dnc_source_event_fk FOREIGN KEY (source_event_id, manager_id, source_campaign_id, source_zone_id)
          REFERENCES canvas_house_events(event_id, manager_id, campaign_id, zone_id),
        CONSTRAINT canvas_dnc_change_fk FOREIGN KEY (change_cursor, manager_id)
          REFERENCES canvas_changes(cursor, manager_id),
        CONSTRAINT canvas_dnc_version_check CHECK (version >= 1),
        CONSTRAINT canvas_dnc_revocation_check CHECK (
          (active AND revoked_at IS NULL AND revoked_by_user_id IS NULL AND revocation_reason IS NULL)
          OR
          (NOT active AND revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL
            AND NULLIF(BTRIM(revocation_reason), '') IS NOT NULL)
        )
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS canvas_zone_progress (
        manager_id TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        zone_id TEXT NOT NULL,
        distinct_pin_count BIGINT NOT NULL DEFAULT 0,
        event_count BIGINT NOT NULL DEFAULT 0,
        active_dnc_count BIGINT NOT NULL DEFAULT 0,
        outcome_counts JSONB NOT NULL DEFAULT '{}'::JSONB,
        last_change_cursor BIGINT NOT NULL DEFAULT 0,
        version BIGINT NOT NULL DEFAULT 1,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (manager_id, campaign_id, zone_id),
        CONSTRAINT canvas_progress_deployment_fk FOREIGN KEY (campaign_id, manager_id)
          REFERENCES canvas_deployments(campaign_id, manager_id) ON DELETE CASCADE,
        CONSTRAINT canvas_progress_counts_check CHECK (
          distinct_pin_count >= 0 AND event_count >= 0 AND active_dnc_count >= 0
          AND last_change_cursor >= 0 AND version >= 1
        )
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS canvas_assignment_packages (
        package_id TEXT PRIMARY KEY,
        manager_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        package_version BIGINT NOT NULL,
        publication_idempotency_key TEXT NOT NULL,
        publication_request_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'building',
        manifest_object_key TEXT,
        manifest_hash TEXT,
        manifest_signature TEXT,
        manifest_content BYTEA,
        manifest_byte_size BIGINT NOT NULL DEFAULT 0,
        signing_key_id TEXT,
        evidence_release_id TEXT,
        classification_revision_id TEXT,
        event_cursor BIGINT NOT NULL DEFAULT 0,
        dnc_high_water_cursor BIGINT NOT NULL DEFAULT 0,
        total_bytes BIGINT NOT NULL DEFAULT 0,
        issued_at TIMESTAMPTZ,
        valid_until TIMESTAMPTZ,
        failure_code TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (package_id, manager_id),
        UNIQUE (manager_id, assignment_id, package_version),
        UNIQUE (manager_id, assignment_id, publication_idempotency_key),
        CONSTRAINT canvas_packages_assignment_fk FOREIGN KEY (assignment_id, manager_id)
          REFERENCES canvas_assignments(assignment_id, manager_id) ON DELETE CASCADE,
        CONSTRAINT canvas_packages_version_check CHECK (package_version >= 1),
        CONSTRAINT canvas_packages_request_hash_check CHECK (publication_request_hash ~ '^[a-f0-9]{64}$'),
        CONSTRAINT canvas_packages_cursor_check CHECK (
          event_cursor >= 0 AND dnc_high_water_cursor >= 0 AND total_bytes >= 0
          AND manifest_byte_size >= 0
        ),
        CONSTRAINT canvas_packages_manifest_bytes_check CHECK (
          manifest_content IS NULL OR OCTET_LENGTH(manifest_content) = manifest_byte_size
        ),
        CONSTRAINT canvas_packages_status_check CHECK (
          status IN ('building', 'ready', 'failed', 'revoked', 'expired')
        ),
        CONSTRAINT canvas_packages_ready_check CHECK (
          status <> 'ready' OR (
            manifest_object_key IS NOT NULL
            AND manifest_hash ~ '^[a-f0-9]{64}$'
            AND NULLIF(BTRIM(manifest_signature), '') IS NOT NULL
            AND manifest_content IS NOT NULL
            AND manifest_byte_size > 0
            AND NULLIF(BTRIM(signing_key_id), '') IS NOT NULL
            AND issued_at IS NOT NULL
            AND valid_until IS NOT NULL
            AND valid_until > issued_at
          )
        )
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS canvas_package_artifacts (
        manager_id TEXT NOT NULL,
        package_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        artifact_kind TEXT NOT NULL,
        artifact_ordinal INTEGER NOT NULL DEFAULT 0,
        object_key TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        byte_size BIGINT NOT NULL,
        content_type TEXT NOT NULL,
        content BYTEA NOT NULL,
        required BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (package_id, artifact_kind, artifact_ordinal),
        UNIQUE (package_id, artifact_id),
        CONSTRAINT canvas_artifacts_package_fk FOREIGN KEY (package_id, manager_id)
          REFERENCES canvas_assignment_packages(package_id, manager_id) ON DELETE CASCADE,
        CONSTRAINT canvas_artifacts_ordinal_check CHECK (artifact_ordinal >= 0),
        CONSTRAINT canvas_artifacts_hash_check CHECK (sha256 ~ '^[a-f0-9]{64}$'),
        CONSTRAINT canvas_artifacts_size_check CHECK (byte_size >= 0),
        CONSTRAINT canvas_artifacts_content_size_check CHECK (OCTET_LENGTH(content) = byte_size),
        CONSTRAINT canvas_artifacts_kind_check CHECK (
          artifact_kind IN ('territory', 'context_streets', 'opportunities', 'pins', 'dnc_manifest', 'dnc_shard', 'basemap')
        )
      )
    `;

    // ADD COLUMN keeps this setup function forward-idempotent for databases
    // prepared by the first operational-store revision.
    await sql`ALTER TABLE canvas_assignment_packages ADD COLUMN IF NOT EXISTS publication_idempotency_key TEXT`;
    await sql`ALTER TABLE canvas_assignment_packages ADD COLUMN IF NOT EXISTS publication_request_hash TEXT`;
    await sql`ALTER TABLE canvas_assignment_packages ADD COLUMN IF NOT EXISTS manifest_content BYTEA`;
    await sql`ALTER TABLE canvas_assignment_packages ADD COLUMN IF NOT EXISTS manifest_byte_size BIGINT NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE canvas_package_artifacts ADD COLUMN IF NOT EXISTS artifact_id TEXT`;
    await sql`ALTER TABLE canvas_package_artifacts ADD COLUMN IF NOT EXISTS content BYTEA`;
    // Lifecycle tombstones make campaign closure authoritative even when the
    // deployment was closed before its first assignment package was built.
    // They also bind a supersession retry to the exact replacement campaign.
    await sql`ALTER TABLE canvas_deployments ADD COLUMN IF NOT EXISTS closed_by_user_id TEXT`;
    await sql`ALTER TABLE canvas_deployments ADD COLUMN IF NOT EXISTS lifecycle_action TEXT`;
    await sql`ALTER TABLE canvas_deployments ADD COLUMN IF NOT EXISTS lifecycle_idempotency_key TEXT`;
    await sql`ALTER TABLE canvas_deployments ADD COLUMN IF NOT EXISTS superseded_by_campaign_id TEXT`;
    await sql`
      UPDATE canvas_package_artifacts
      SET artifact_id = artifact_kind || ':' || artifact_ordinal::text
      WHERE artifact_id IS NULL
    `;
    await sql`ALTER TABLE canvas_package_artifacts DROP CONSTRAINT IF EXISTS canvas_artifacts_kind_check`;
    await sql`
      ALTER TABLE canvas_package_artifacts ADD CONSTRAINT canvas_artifacts_kind_check CHECK (
        artifact_kind IN ('territory', 'context_streets', 'opportunities', 'pins', 'dnc_manifest', 'dnc_shard', 'basemap')
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS canvas_dnc_manifests (
        dnc_manifest_id TEXT PRIMARY KEY,
        manager_id TEXT NOT NULL,
        package_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        manifest_version BIGINT NOT NULL,
        high_water_cursor BIGINT NOT NULL,
        scope_hash TEXT NOT NULL,
        root_hash TEXT NOT NULL,
        shard_count INTEGER NOT NULL,
        total_count BIGINT NOT NULL,
        complete BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (dnc_manifest_id, manager_id),
        UNIQUE (manager_id, package_id, manifest_version),
        CONSTRAINT canvas_dnc_manifests_package_fk FOREIGN KEY (package_id, manager_id)
          REFERENCES canvas_assignment_packages(package_id, manager_id) ON DELETE CASCADE,
        CONSTRAINT canvas_dnc_manifests_assignment_fk FOREIGN KEY (assignment_id, manager_id)
          REFERENCES canvas_assignments(assignment_id, manager_id) ON DELETE CASCADE,
        CONSTRAINT canvas_dnc_manifests_version_check CHECK (manifest_version >= 1),
        CONSTRAINT canvas_dnc_manifests_cursor_check CHECK (high_water_cursor >= 0),
        CONSTRAINT canvas_dnc_manifests_scope_hash_check CHECK (scope_hash ~ '^[a-f0-9]{64}$'),
        CONSTRAINT canvas_dnc_manifests_root_hash_check CHECK (root_hash ~ '^[a-f0-9]{64}$'),
        CONSTRAINT canvas_dnc_manifests_counts_check CHECK (
          shard_count >= 0 AND total_count >= 0
        ),
        CONSTRAINT canvas_dnc_manifests_complete_check CHECK (
          NOT complete OR (shard_count > 0 OR total_count = 0)
        )
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS canvas_dnc_manifest_shards (
        manager_id TEXT NOT NULL,
        dnc_manifest_id TEXT NOT NULL,
        shard_ordinal INTEGER NOT NULL,
        object_key TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        suppression_count BIGINT NOT NULL,
        scope JSONB NOT NULL DEFAULT '{}'::JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (dnc_manifest_id, shard_ordinal),
        CONSTRAINT canvas_dnc_shards_manifest_fk FOREIGN KEY (dnc_manifest_id, manager_id)
          REFERENCES canvas_dnc_manifests(dnc_manifest_id, manager_id) ON DELETE CASCADE,
        CONSTRAINT canvas_dnc_shards_ordinal_check CHECK (shard_ordinal >= 0),
        CONSTRAINT canvas_dnc_shards_hash_check CHECK (sha256 ~ '^[a-f0-9]{64}$'),
        CONSTRAINT canvas_dnc_shards_count_check CHECK (suppression_count >= 0)
      )
    `;

    const indexStatements = [
      "CREATE INDEX IF NOT EXISTS idx_canvas_deployments_manager_status ON canvas_deployments(manager_id, status, updated_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_canvas_deployments_assignment_index ON canvas_deployments(manager_id, assignment_index_version)",
      "CREATE INDEX IF NOT EXISTS idx_canvas_assignments_user_active ON canvas_assignments(assignee_user_id, status, package_version DESC)",
      "CREATE INDEX IF NOT EXISTS idx_canvas_assignments_member_active ON canvas_assignments(manager_id, team_member_id, status)",
      "CREATE INDEX IF NOT EXISTS idx_canvas_assignments_campaign_zone ON canvas_assignments(manager_id, campaign_id, zone_id)",
      "CREATE INDEX IF NOT EXISTS idx_canvas_work_units_assignment ON canvas_work_unit_ownership(manager_id, assignment_id, work_unit_id)",
      "CREATE INDEX IF NOT EXISTS idx_canvas_work_units_geometry ON canvas_work_unit_ownership USING GIST(geometry)",
      "CREATE INDEX IF NOT EXISTS idx_canvas_work_units_geography ON canvas_work_unit_ownership USING GIST((geometry::geography))",
      "CREATE INDEX IF NOT EXISTS idx_canvas_changes_assignment_cursor ON canvas_changes(assignment_id, cursor)",
      "CREATE INDEX IF NOT EXISTS idx_canvas_changes_campaign_cursor ON canvas_changes(manager_id, campaign_id, cursor)",
      "CREATE INDEX IF NOT EXISTS idx_canvas_changes_tenant_cursor ON canvas_changes(manager_id, cursor)",
      "CREATE INDEX IF NOT EXISTS idx_canvas_events_assignment_cursor ON canvas_house_events(assignment_id, change_cursor)",
      "CREATE INDEX IF NOT EXISTS idx_canvas_events_campaign_cursor ON canvas_house_events(manager_id, campaign_id, change_cursor)",
      "CREATE INDEX IF NOT EXISTS idx_canvas_events_point ON canvas_house_events USING GIST(point)",
      "CREATE INDEX IF NOT EXISTS idx_canvas_pins_viewport ON canvas_house_pins USING GIST(point)",
      "CREATE INDEX IF NOT EXISTS idx_canvas_pins_zone_cursor ON canvas_house_pins(manager_id, campaign_id, zone_id, latest_change_cursor DESC, pin_id)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_pins_house_key ON canvas_house_pins(manager_id, campaign_id, house_key) WHERE house_key IS NOT NULL",
      "CREATE INDEX IF NOT EXISTS idx_canvas_dnc_active_point ON canvas_dnc_suppressions USING GIST(point) WHERE active",
      "CREATE INDEX IF NOT EXISTS idx_canvas_dnc_active_geography ON canvas_dnc_suppressions USING GIST((point::geography)) WHERE active",
      "CREATE INDEX IF NOT EXISTS idx_canvas_dnc_tenant_cursor ON canvas_dnc_suppressions(manager_id, change_cursor) WHERE active",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_dnc_active_house_key ON canvas_dnc_suppressions(manager_id, house_key) WHERE active AND house_key IS NOT NULL",
      "CREATE INDEX IF NOT EXISTS idx_canvas_progress_campaign ON canvas_zone_progress(manager_id, campaign_id, last_change_cursor)",
      "CREATE INDEX IF NOT EXISTS idx_canvas_packages_assignment ON canvas_assignment_packages(manager_id, assignment_id, package_version DESC)",
      "CREATE INDEX IF NOT EXISTS idx_canvas_packages_ready_expiry ON canvas_assignment_packages(status, valid_until) WHERE status = 'ready'",
      "CREATE INDEX IF NOT EXISTS idx_canvas_artifacts_package ON canvas_package_artifacts(manager_id, package_id)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_artifacts_id ON canvas_package_artifacts(package_id, artifact_id) WHERE artifact_id IS NOT NULL",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_packages_publication_key ON canvas_assignment_packages(manager_id, assignment_id, publication_idempotency_key) WHERE publication_idempotency_key IS NOT NULL",
      "CREATE INDEX IF NOT EXISTS idx_canvas_dnc_manifests_package ON canvas_dnc_manifests(manager_id, package_id, manifest_version DESC)",
      "CREATE INDEX IF NOT EXISTS idx_canvas_dnc_shards_manifest ON canvas_dnc_manifest_shards(manager_id, dnc_manifest_id, shard_ordinal)"
    ];
    for (const statement of indexStatements) await sql(statement);

    await sql`
      CREATE OR REPLACE FUNCTION canvas_reject_manager_id_change()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.manager_id IS DISTINCT FROM OLD.manager_id THEN
          RAISE EXCEPTION 'manager_id is immutable';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `;

    const tenantTables = [
      "canvas_deployments",
      "canvas_assignments",
      "canvas_work_unit_ownership",
      "canvas_changes",
      "canvas_house_events",
      "canvas_house_pins",
      "canvas_dnc_suppressions",
      "canvas_zone_progress",
      "canvas_assignment_packages",
      "canvas_package_artifacts",
      "canvas_dnc_manifests",
      "canvas_dnc_manifest_shards"
    ];
    for (const tableName of tenantTables) {
      const triggerName = `${tableName}_manager_immutable`;
      await sql(`DROP TRIGGER IF EXISTS ${triggerName} ON ${tableName}`);
      await sql(`CREATE TRIGGER ${triggerName} BEFORE UPDATE OF manager_id ON ${tableName} FOR EACH ROW EXECUTE FUNCTION canvas_reject_manager_id_change()`);
    }

    await sql`
      CREATE OR REPLACE FUNCTION canvas_reject_append_only_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
      END;
      $$ LANGUAGE plpgsql
    `;
    for (const tableName of ["canvas_changes", "canvas_house_events"]) {
      const triggerName = `${tableName}_append_only`;
      await sql(`DROP TRIGGER IF EXISTS ${triggerName} ON ${tableName}`);
      await sql(`CREATE TRIGGER ${triggerName} BEFORE UPDATE OR DELETE ON ${tableName} FOR EACH ROW EXECUTE FUNCTION canvas_reject_append_only_mutation()`);
    }

    await sql`
      CREATE OR REPLACE FUNCTION canvas_guard_signed_package_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.package_id IS DISTINCT FROM OLD.package_id
          OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
          OR NEW.package_version IS DISTINCT FROM OLD.package_version
          OR NEW.publication_idempotency_key IS DISTINCT FROM OLD.publication_idempotency_key
          OR NEW.publication_request_hash IS DISTINCT FROM OLD.publication_request_hash
          OR NEW.manifest_object_key IS DISTINCT FROM OLD.manifest_object_key
          OR NEW.manifest_hash IS DISTINCT FROM OLD.manifest_hash
          OR NEW.manifest_signature IS DISTINCT FROM OLD.manifest_signature
          OR NEW.manifest_content IS DISTINCT FROM OLD.manifest_content
          OR NEW.manifest_byte_size IS DISTINCT FROM OLD.manifest_byte_size
          OR NEW.signing_key_id IS DISTINCT FROM OLD.signing_key_id
          OR NEW.evidence_release_id IS DISTINCT FROM OLD.evidence_release_id
          OR NEW.classification_revision_id IS DISTINCT FROM OLD.classification_revision_id
          OR NEW.event_cursor IS DISTINCT FROM OLD.event_cursor
          OR NEW.dnc_high_water_cursor IS DISTINCT FROM OLD.dnc_high_water_cursor
          OR NEW.total_bytes IS DISTINCT FROM OLD.total_bytes
          OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
          OR NEW.valid_until IS DISTINCT FROM OLD.valid_until THEN
          RAISE EXCEPTION 'signed Canvas package content is immutable';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `;
    await sql`DROP TRIGGER IF EXISTS canvas_assignment_packages_signed_immutable ON canvas_assignment_packages`;
    await sql`
      CREATE TRIGGER canvas_assignment_packages_signed_immutable
      BEFORE UPDATE ON canvas_assignment_packages
      FOR EACH ROW EXECUTE FUNCTION canvas_guard_signed_package_mutation()
    `;
    await sql`DROP TRIGGER IF EXISTS canvas_package_artifacts_immutable ON canvas_package_artifacts`;
    await sql`
      CREATE TRIGGER canvas_package_artifacts_immutable
      BEFORE UPDATE OR DELETE ON canvas_package_artifacts
      FOR EACH ROW EXECUTE FUNCTION canvas_reject_append_only_mutation()
    `;

    await sql`
      INSERT INTO canvas_operational_schema_migrations (version)
      VALUES (${MIGRATION_VERSION})
      ON CONFLICT (version) DO NOTHING
    `;

    return json({
      success: true,
      migration: MIGRATION_VERSION,
      database_secret: "CANVAS_DATABASE_URL",
      precision_database_changed: false,
      tables: [
        "canvas_deployments",
        "canvas_assignments",
        "canvas_work_unit_ownership",
        "canvas_changes",
        "canvas_house_events",
        "canvas_house_pins",
        "canvas_dnc_suppressions",
        "canvas_zone_progress",
        "canvas_assignment_packages",
        "canvas_package_artifacts",
        "canvas_dnc_manifests",
        "canvas_dnc_manifest_shards"
      ]
    });
  } catch (error) {
    console.error("[setupCanvasOperationalStore] migration failed");
    return json({ error: "canvas_operational_migration_failed", message: "The Canvas operational schema could not be prepared." }, 500);
  }
});