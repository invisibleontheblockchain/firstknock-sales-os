# FieldRoutes Phase 1 release runbook

Phase 1 turns a rep-confirmed opportunity into an **unassigned initial inspection** in one office-scoped FieldRoutes account. It supports both Precision properties and server-synced Canvas house pins. It does not turn generic FirstKnock callback or appointment outcomes into provider writes, assign a route or technician, or import FieldRoutes customers into FirstKnock.

## Production contract

1. A manager connects one office-scoped FieldRoutes account and chooses one visible initial service type.
2. A rep taps **Schedule Inspection**, reviews the customer name, phone/email, property address, unit, and notes, and explicitly submits.
3. FirstKnock validates source ownership and writes one encrypted, tenant-scoped outbox record. A new request normally returns `202 Accepted`; no FieldRoutes provider call occurs in the browser request.
4. The scheduled worker finds or creates one exact customer and creates an unassigned appointment. Timeouts after writes enter reconciliation; they are never blindly replayed.
5. Precision and Canvas poll the FirstKnock outbox every 15 seconds only while a visible request is non-terminal. A server row always replaces the temporary device/accepted status.
6. FieldRoutes customer and appointment IDs stay in the tenant-scoped integration tables. They are never written to the globally deduplicated `properties` table.

Canvas and Precision have different address trust boundaries:

- A Precision property is an already authorized route property. Any prefilled owner/contact/address value is convenience data only; the rep must review it with the resident before submitting.
- A Canvas pin proves the rep owns that territory location. It is **not postal-address evidence**. Scheduling appears only after `CanvasHousePin` has been acknowledged by the server, and the rep must enter/review the full address and unit.
- Before any Canvas-origin FieldRoutes write, the worker uses BatchData to require one correlated, deliverable (`DPV=Y`) address with matching primary address, state, ZIP, unit semantics, and coordinates within 30 meters of the trusted pin. An unconfigured, ambiguous, undeliverable, or mismatched result stops or retries safely; it is not sent to FieldRoutes.

## Required server secrets

Configure these in the Base44 server environment only. None may use a `VITE_` prefix or enter a browser bundle:

- `DATABASE_URL` — the exact database variable used by both FieldRoutes functions.
- `FIELDROUTES_ENCRYPTION_KEY` — exactly 32 random bytes encoded as 64 hex characters or base64url.
- `FIELDROUTES_MIGRATION_SECRET` — an independent high-entropy value of at least 32 characters.
- `FIELDROUTES_WORKER_SECRET` — an independent high-entropy value of at least 32 characters.
- `BATCH_DATA_API_KEY` — required for Canvas-origin FieldRoutes scheduling; Precision does not use it.
- `CANVAS_DEPLOYMENT_SIGNING_SECRET` — required by the existing Canvas deployment and ownership checks.

Keep all keys independent and store them in the production secret manager. Phase 1 envelopes use one fixed key identifier and do not implement a key ring. Replacing `FIELDROUTES_ENCRYPTION_KEY` makes both saved credentials and queued/historical request envelopes unreadable; reconnecting a manager repairs only that manager's credential envelope. Do not perform a routine live rotation. For an emergency rotation, first stop submissions and the worker, resolve or formally abandon every queued/reconciliation record, follow the data-retention policy for old encrypted records, rotate the key, reconnect each manager, and run the full staging gate again.

## Deployment order

1. Deploy the required Canvas residential territory release and confirm Canvas pin sync/signature checks work.
2. Add the server secrets above. Use a staging BatchData key for staging and the approved production key only in production.
3. Deploy `setupFieldRoutesIntegration`.
4. Invoke that function as a Base44 platform administrator with `x-fieldroutes-migration-secret: <FIELDROUTES_MIGRATION_SECRET>`. Retain only its sanitized success response. The operation is additive and idempotent, but it is still a production migration.
5. Deploy `fieldRoutesIntegration`, then deploy the web app.
6. Configure the scheduled worker exactly as described below.
7. Connect a staging manager from **Integrations**, test the connection, load service types, select and save the intended initial service type, then test the connection again.
8. Run the read-only contract smoke and all credentialed workflow checks.
9. Enable one pilot team, monitor the outbox, reconciliation, rate counters, and duplicates, then expand deliberately.

## Scheduled worker contract

Configure a server-side scheduler against the deployed `fieldRoutesIntegration` function:

- Method: `POST`
- Header: `content-type: application/json`
- Header: `x-fieldroutes-worker-secret: <FIELDROUTES_WORKER_SECRET>`
- Body: `{ "action": "process_queue", "limit": 5 }`
- Cadence: every 60 seconds. Do not run faster than every 20 seconds.
- Scheduler timeout: at least 120 seconds. The function bounds each invocation to at most five tenant candidates, takes at most one candidate per tenant, and uses per-account and per-request leases.

Never put the worker secret in a URL, query string, browser, deployment log, or monitoring label. Treat a non-2xx response as an alert. Record only the sanitized counters returned by the worker: `processed`, `synced`, `pending`, `review_required`, and `failed`. Alert on consecutive invocation failures, growing oldest-ready age, sustained `review_required`/`failed`, lease expiry churn, authentication/configuration blocks, and FieldRoutes token use approaching the account budget. The manager page warns when observed reads or writes exceed 2,500 for the day, but production monitoring must not rely on a person keeping that page open.

## Read-only provider contract smoke

Use customer-approved credentials from an operator terminal. This probe performs only `serviceType/search`, never prints response bodies or provider error text, and emits only allowlisted service-type metadata.

```powershell
$env:FIELDROUTES_SMOKE_BASE_URL = 'https://customer.fieldroutes.com/api'
$env:FIELDROUTES_SMOKE_AUTH_KEY = '<key>'
$env:FIELDROUTES_SMOKE_AUTH_TOKEN = '<token>'
npm run smoke:fieldroutes:readonly
```

For the documented staging host, use `https://stagingdemo.pestroutes.com/api`. Phase 1 requires office-scoped credentials for exactly one office; it does not accept a saved office ID or a multi-office/global credential. The smoke must return readable `includeData` records for service types, not IDs alone.

## Credentialed staging gate

Complete every item with the customer's actual account behavior before production:

1. Save and test the staging connection. Confirm API credentials are write-only in the UI and absent from browser storage, browser responses, logs, errors, and activity payloads.
2. Load visible initial service types, select the intended type, verify its account-specific default duration, save the connection, then test it again. Confirm the credentials resolve to one office only and the readiness card says scheduling is enabled.
3. Precision: open one assigned property, review/replace all prefilled identity and contact values, submit, and observe device/server-pending status change to synced without refreshing the page.
4. Confirm exactly one customer and one unassigned appointment in FieldRoutes, with the expected service type, duration, lead source (if configured), office notes, and FirstKnock marker.
5. Canvas: log a house outcome and wait until the pin is server-synced. Reopen the pin; confirm Schedule Inspection was unavailable before sync and is now below the outcome controls.
6. Enter a resident-confirmed complete Canvas address, unit, name, and phone/email. Verify BatchData correlation, `DPV=Y`, normalized primary/state/ZIP/unit, and pin-distance checks pass before exactly one FieldRoutes customer and appointment appear.
7. Repeat Canvas checks for missing unit, unexpected unit, undeliverable address, ambiguous result, address mismatch, more-than-30-meter mismatch, missing/invalid BatchData credentials, BatchData timeout, and rate limit. None may create a FieldRoutes write.
8. Repeat the same FirstKnock idempotency key and business opportunity. Confirm no duplicate customer or appointment.
9. Test an exact existing-customer match and multiple-customer ambiguity. Ambiguity must stop for review.
10. Simulate customer-create and appointment-create response timeouts. Confirm reconciliation finds the provider record or stops at `review_required`; it must never blindly create another.
11. Confirm `retry_wait` can be retried plainly, while review/ambiguous retries require explicit confirmation and say **Retry reconciliation**. Invalid immutable payloads require a new corrected request; Phase 1 has no in-place payload editor or provider-record chooser.
12. Test invalid FieldRoutes credentials, invalid service type, provider validation, provider 429, provider 5xx, and worker interruption. Reps and managers must receive only sanitized action-oriented text.
13. Test airplane mode. The rep must see that the request exists only on that device; reconnect and observe durable server ownership, then worker completion. Confirm automatic retry ends and the record becomes logically expired at 24 hours, then is physically purged by the next queue check.
14. On a shared device, sign out and sign into another actor/manager scope. Confirm the prior scope's unsent contact data is gone. Repeat using Delete Account.
15. Verify disconnected integration, expired Canvas session, cross-territory pin, rep/manager cross-tenant access, and forged Precision/Canvas sources are rejected.

Production enablement is blocked until this entire gate passes. FieldRoutes does not expose an appointment idempotency key, so timeout reconciliation and duplicate checks are release-critical.

## Rep contact-data policy and device queue

The rep must confirm a first and last name plus at least one phone number or email address. FirstKnock submits only those reviewed contact fields, the reviewed property address/unit, optional notes, source ownership identifiers, and audit identity needed for the inspection. Do not treat Precision owner data as the resident's identity, and do not infer a Canvas address from its coordinates or pin label.

Before the server accepts a request, an immutable copy is stored in browser-managed IndexedDB through localForage so a connectivity loss cannot silently discard the rep's action. This storage is plaintext from the application's perspective; it is not application-encrypted and inherits the device/browser's security. Therefore:

- records are scoped to the exact actor and manager;
- opening another valid scope immediately deletes all other-scope records;
- the queue is capped at 200 records in the active scope;
- automatic retry and logical retention both end 24 hours after creation; while the app is open, cleanup checks run every minute even offline, and a closed browser purges the expired record on its next queue access;
- explicit logout and Delete Account clear the entire FieldRoutes device queue;
- reps must not leave unsent inspections on a shared or unmanaged device.

Once the server returns a durable request ID, the device copy is deleted and the encrypted server outbox is authoritative.

## Operating the queue

Actual server states are:

- `queued`: durable and ready for a worker.
- `processing`: held by a live request lease.
- `retry_wait`: a transient provider/configuration condition is scheduled for retry.
- `customer_reconcile`: checking whether an uncertain customer write already succeeded.
- `appointment_reconcile`: checking whether an uncertain appointment write already succeeded.
- `synced`: the FieldRoutes appointment ID was recorded; office scheduling remains pending.
- `superseded`: a pre-provider request was safely replaced by a corrected request; follow the newer row.
- `review_required`: automatic processing stopped to avoid an unsafe match or duplicate.
- `failed`: the durable request cannot continue automatically.

For ordinary transient rows, use **Retry** only when the backend allows it. For review or ambiguous rows, inspect the matching customer/appointment in FieldRoutes first, then use **Retry reconciliation** and acknowledge the confirmation. The current manager UI intentionally does not offer “choose existing,” “adopt appointment,” or edit-in-place controls. If the immutable customer/address payload is wrong, correct the FirstKnock source/contact and create a new intentional request only after resolving the old record.

Never troubleshoot by logging complete FieldRoutes or BatchData responses. A FieldRoutes authentication failure can echo submitted request parameters—including credentials—even with HTTP `200`.

## Phase boundary

Phase 1 status polling means polling FirstKnock's own durable outbox while work is pending. It is **not** provider appointment-lifecycle polling. Phase 2 provider polling (scheduled/completed/cancelled), and Phase 3 customer suppression/conversion sync, remain separate releases because they require rate-budget, lifecycle, privacy, retention, and account-specific decisions.

## Production go/no-go

Do not enable production until all of the following are true: migration completed; secrets present and isolated; Canvas signing and BatchData verification pass; worker schedule and alerts are live; read-only provider smoke passes; both Precision and Canvas end-to-end staging cases pass; server status replaces local status without refresh; offline scope/retention/logout deletion is verified; reconciliation creates no duplicates; tenant/source authorization tests pass; and the customer has approved the service type, duration, lead-source behavior, and office workflow.
