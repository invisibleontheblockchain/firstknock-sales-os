# FirstKnock Production Runbook

## 1. Stuck Fetch Job
Symptoms: pull progress stops, user reports data never completes.

Steps:
1. Run `healthCheck` as admin.
2. Run `adminDiagnostics` and inspect recent failed/running jobs.
3. If a job is running but stale, run existing `watchdogStaleJobs`.
4. If failed from RentCast rate limits, wait 5-10 minutes and retry the territory pull.
5. If repeatedly failing on the same area, reduce the drawn territory size.

## 2. Neon Connectivity or Slow Queries
Symptoms: map loads slowly, route candidates timeout, health check shows Neon failure.

Steps:
1. Run `healthCheck` and confirm `services.neon`.
2. Run `loadTestRouteCandidates` with `iterations: 5`, `limit: 1000`.
3. If p95 latency is high, run `adminDiagnostics` and review property counts/storage.
4. Add or adjust compound indexes if slow query patterns are confirmed.
5. If Neon is down, pause data pulls and communicate degraded route loading.

## 3. Stripe Webhook Failure
Symptoms: user paid but subscription is not active.

Steps:
1. Confirm `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in `healthCheck`.
2. Check Stripe webhook delivery logs for the event.
3. If webhook signature failed, verify the signing secret matches the deployed endpoint.
4. Re-send the Stripe webhook event.
5. Confirm user subscription fields and invite code were updated.

## 4. RentCast Failure
Symptoms: property pull fails, no new properties imported.

Steps:
1. Run `healthCheck` and confirm `RENTCAST_API_KEY` exists.
2. Inspect FetchJob `error_log` through `adminDiagnostics`.
3. If 429/rate limited, wait and retry.
4. If 401, rotate the RentCast API key.
5. If one area repeatedly fails, reduce radius or split territory.

## 5. BatchData Failure
Symptoms: MLS verification drops records or logs BatchData unavailable.

Steps:
1. Run `healthCheck` and confirm `BATCH_DATA_API_KEY` exists.
2. Inspect FetchJob errors for BatchData status codes.
3. If credits/auth fail, replenish/fix BatchData account.
4. The app should reject unverified MLS instead of routing bad leads.

## 6. Pre-launch Checks
- Run `healthCheck`.
- Run `adminDiagnostics`.
- Run `measureNeonStorage`.
- Run `loadTestRouteCandidates` with realistic limits.
- Pull a test territory and generate a route.
- Verify Stripe checkout and webhook delivery.