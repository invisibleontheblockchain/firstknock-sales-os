# FirstKnock Sales OS

**The Door-to-Door Sales Operating System** — a full-stack, mobile-first platform that turns raw property data into optimized knocking routes for field sales teams.

![FirstKnock](https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/695eb764b077190880be21de/4207f4197_ChatGPTImageFeb2202612_56_42AM.png)

---

## Overview

FirstKnock replaces spreadsheets, paper maps, and guesswork with a real-time, GPS-verified territory management system. Managers draw territories on a satellite map, pull verified property data, generate AI-optimized walking routes, and dispatch reps — all from one app.

### Key Capabilities

| Feature | Description |
|---|---|
| **Territory Drawing** | Draw custom areas (circle/square) on a satellite map — 40 sq mi (free) or 300 sq mi (Pro) |
| **Property Data Engine** | 2-phase pipeline: deed records + MLS listings via RentCast API with smart grid subdivision |
| **Tiered BatchData Verification** | Only fresh, high-confidence listings (DOM < 30 days, heuristic score ≥ 3) go to BatchData — cuts API spend ~70-80% |
| **Delta Sync (CDC)** | Re-pulls only fetch changes since last import — ~85% fewer API calls on recurring pulls |
| **AI Route Optimizer** | Generates street-sweep walking routes using K-Means clustering, Nearest Neighbor, 2-Opt, and fatigue-aware sequencing |
| **Bayesian Lead Scoring** | Beta-Binomial posteriors with ADWIN drift detection learn from rep interactions to prioritize high-conversion properties |
| **Live GPS Tracking** | Real-time rep location with proof-of-visit and accuracy radius |
| **Team Dispatch** | Uber-style auto-assignment based on availability, proximity, and performance |
| **Appointment Scheduling** | Book, track, and score appointments with eligibility scoring |
| **Real-Time Chat** | Team messaging with channels, DMs, and group chats |
| **Analytics Dashboard** | Command center with KPIs, leaderboards, conversion funnels, and territory penetration |

---

## Architecture

### Frontend
- **React 18** + **Vite** — SPA with code splitting via `React.lazy`
- **Tailwind CSS** — Dark glassmorphism design system (`#0A0A0F` base, purple/cyan accents)
- **React Leaflet** — Interactive satellite maps with custom layers
- **React Query** — Server state management with real-time subscriptions
- **Framer Motion** — Animations and transitions
- **Recharts** — Analytics visualizations

### Backend (Base44 Platform)
- **Entities** — 14 data models (MasterProperty, SavedRoute, InteractionLog, FetchJob, etc.)
- **Backend Functions** — Deno Deploy serverless functions for API integrations
- **Automations** — Entity-triggered and scheduled background jobs
- **Real-Time** — WebSocket subscriptions for live data updates

### External Integrations
| Service | Purpose |
|---|---|
| **RentCast API** | Property data — deed records (`/v1/properties`) and MLS listings (`/v1/listings/sale`) |
| **BatchData API** | Async sale verification for high-confidence MLS records (webhook-based, gated to DOM < 30 days) |
| **Stripe** | Subscription billing — Hustler ($49-59/mo), Growth ($99/mo), Enterprise ($299/mo) |
| **Neon PostgreSQL** | Auxiliary tables for pipeline analytics and delta validation |
| **H3 (Uber)** | Hexagonal spatial indexing for property clustering |

### Database Architecture

FirstKnock uses a **dual-database** strategy:

1. **Base44 Entities** — Primary CRUD store for all app data (properties, routes, logs, team, etc.)
2. **Neon PostgreSQL** — Auxiliary pipeline tables for data not suited to the entity model:

| Neon Table | Purpose |
|---|---|
| `properties` | PostGIS-enabled property warehouse with spatial indexing (`GEOMETRY(POINT, 4326)`) and smart scoring |
| `listing_seen_log` | Tracks every `listingId` ever processed — prevents reprocessing on delta pulls |
| `heuristic_score_log` | Logs heuristic scores and signals for shadow-mode calibration (compare predictions vs. BatchData actuals) |
| `pending_confirmation_queue` | Holds under-contract (pending) listings for 30-day re-check instead of premature rejection |
| `job_runs` | Cost tracking per pipeline run — API calls, inserts, skips, estimated $ spend |

---

## Data Pipeline

### How Property Data Gets Into the App

The data pipeline is a 2-phase, self-chaining system that fetches property data from RentCast, classifies it using heuristics, and optionally validates ambiguous records against BatchData.

### Phase 0: Job Creation (`fetchAreaProperties`)

```
User draws territory on map
    ↓
fetchAreaProperties (backend function)
    ↓
1. Compute minimum bounding circle for polygon
2. Enforce area limits (40 sq mi free / 300 sq mi paid)
3. Check for prior completed pulls → CDC delta watermark
4. Grid subdivide if radius > 5mi (RentCast drops data on large queries)
5. Create FetchJob entity (status: pending)
6. Self-chain → invoke processFetchChunk
```

**Grid Subdivision:** RentCast silently drops records for queries > 5mi radius. The system generates a hex-grid of overlapping ≤5mi sub-circles (20% overlap factor) to ensure full area coverage. A 10mi radius becomes ~7 sub-circles; a 20mi radius becomes ~37.

**Delta Pulls (CDC):** On re-import of a previously pulled area, the system finds the most recent completed job within ~7mi of the same center. If found and < 90 days old, it marks the new job as `is_delta_pull = true` and only fetches records updated since the watermark. This saves ~85% of API calls on recurring pulls. If reconciliation has flagged stale ZIPs (`user.stale_zips`), a full pull is forced instead.

### Phase 1: Deed Records (`processFetchChunk` — deed_records phase)

```
For each sub-circle:
    ↓
RentCast /v1/properties?saleDateRange={N}&limit=500
    ↓
Pagination: 10 pages per chunk, 2 parallel requests, 300ms pacing
    ↓
For each raw record:
    1. Point-in-polygon filter (if user drew a polygon, not a circle)
    2. Validate: has sale date, price > $10k (or non-disclosure state), not commercial/vacant
    3. Normalize address → generate address_hash (e.g. "123 MAIN ST|78701")
    4. Deduplicate by hash within chunk
    5. Check corporate ownership (LLC, TRUST, INC, etc.)
    6. Assign sale_confidence: 'high' (standard) or 'medium' (corporate/low-price)
    7. Classify: SOLD (within N months) or ELIGIBLE (older)
    ↓
Write to MasterProperty entity (bulk insert, update if newer sale date)
    ↓
Self-chain → next chunk (with mutex token to prevent duplicate processing)
```

**saleDateRange Floor:** Minimum 180 days, regardless of user's `sold_months` setting. This accounts for the 90-day county deed recording lag (e.g., a sale that closed in January may not appear in county records until April). The configurable `DEED_LAG_CUTOFF_DAYS` env var (default: 120) controls Phase 2's cutoff.

**Self-Chaining:** Each chunk runs for ~40-55 seconds, then updates the FetchJob entity with progress and invokes itself with `{ expected_chunk: N+1 }`. The mutex system prevents duplicate processing — if two instances race, the one whose `expected_chunk` doesn't match the job's `chunk_number` exits silently.

### Phase 2: MLS Listings (`processFetchChunk` — listings_records phase)

```
For each sub-circle:
    ↓
RentCast /v1/listings/sale?status=Inactive&daysOld={N}
    ↓
For each raw listing:
    ↓
FILTER 0: Delta Validation
    - On delta pulls, skip listings whose mls_id already exists in MasterProperty
    - Prevents reprocessing ~70-90% of listings on recurring pulls
    ↓
FILTER 1: County Lag Rule
    - If daysSinceRemoved > DEED_LAG_CUTOFF_DAYS (default 120): REJECT
    - Rationale: If a listing was removed 120+ days ago and no deed appeared in Phase 1,
      it was likely expired/withdrawn/cancelled, not sold
    - Configurable via DEED_LAG_CUTOFF_DAYS env var (set higher for slow-recording counties like Harris TX)
    ↓
FILTER 2: Contract Boundary Auto-Reject
    - If DOM or listing duration is within ±3 days of 90, 180, or 365: REJECT
    - These are almost always listing contract expirations, not sales
    ↓
FILTER 3: Heuristic Scoring (scale: -7 to +7)
    
    Negative signals:
    - DOM > 150 days: -3
    - DOM > 60 days: -2
    - Listing duration < 7 days: -1
    - lastSeen ≈ removedDate (same day): -3  (auto-expired by MLS)
    - 3+ status changes in history: -1
    
    Positive signals:
    - DOM < 30 days: +3
    - Listing duration 1-45 days: +2
    - Gap between lastSeen and removedDate ≥ 7 days: +1
    - Exactly 1 status change: +1
    
    Classification:
    ┌─────────────────┬──────────────┬──────────────────────────────────┐
    │ Score Range      │ Confidence   │ Action                           │
    ├─────────────────┼──────────────┼──────────────────────────────────┤
    │ ≤ -2            │ —            │ REJECTED (likely expired/withdrawn) │
    │ -1 to 0         │ low          │ Kept as HEURISTIC_SOLD, no BatchData │
    │ 1 to 2          │ low          │ Kept as HEURISTIC_SOLD, no BatchData │
    │ ≥ 3, DOM ≥ 30   │ low          │ Kept as HEURISTIC_SOLD, no BatchData │
    │ ≥ 3, DOM < 30   │ medium       │ Kept as HEURISTIC_SOLD, ELIGIBLE for BatchData │
    └─────────────────┴──────────────┴──────────────────────────────────┘
    ↓
Cross-Reference with Phase 1 Deeds (FREE verification)
    - Load all 'high' confidence MasterProperty records in matching zip codes
    - If a listing's address_hash matches a deed record → upgrade to 'verified' + 'DEED_CONFIRMED'
    - This is the highest quality classification — zero additional API cost
    ↓
Write to MasterProperty entity
    ↓
Job complete OR self-chain → next chunk
```

**Tiered BatchData Gating (Key Cost Control):**
The hybrid approach only sends listings to BatchData when BOTH conditions are true:
1. Heuristic score ≥ 3 (high confidence it's actually sold)
2. DOM < 30 days (fresh listing — most likely to be a genuine recent sale)

This eliminates ~70-80% of BatchData API calls compared to sending all ambiguous listings. DOM 30-90 day listings get `low` confidence and are handled by heuristics alone.

### Phase 3: BatchData Verification (Async)

```
processValidationQueue (backend function)
    ↓
1. Fetch up to 500 'pending' items from ValidationQueue entity
2. Map to BatchData address schema
3. Dispatch async bulk lookup to BatchData API
   - Webhook URL includes PIPELINE_SECRET for authentication
   - If credits exhausted (402/403): graceful fallback → downgrade all items to 'low' confidence
    ↓
BatchData processes asynchronously...
    ↓
batchDataWebhookCallback (webhook endpoint)
    ↓
1. Authenticate: verify PIPELINE_SECRET (query param or header)
2. For each property in response:
   - Extract listing status from BatchData (sold/pending/unknown)
   - Create PropertyValidationCache record
   - If SOLD: Update MasterProperty → sale_confidence: 'verified', status: 'CONFIRMED_SOLD'
   - If PENDING: Mark as 'pending_confirmation' — hold for 30-day re-check (don't reject yet)
   - If REJECTED: Cache with 7-day TTL
```

### Pipeline Cost Model

| Scenario | RentCast Calls | BatchData Calls | Est. Cost |
|---|---|---|---|
| **First pull (40 sq mi)** | ~20-40 | 0-50 (Pro only) | ~$8-12 |
| **First pull (300 sq mi)** | ~100-200 | 0-200 (Pro only) | ~$25-35 |
| **Delta re-pull (same area)** | ~3-8 | 0-10 | ~$0.50-2.00 |
| **Monthly recurring (300 sq mi)** | ~5-15 | 0-20 | ~$1-5 |

---

## Confidence Levels

Properties flow through a confidence hierarchy that determines how they're displayed and used:

| Confidence | Source | Meaning | Badge Color |
|---|---|---|---|
| `verified` | BatchData confirmed OR deed cross-reference | Sale confirmed by external validation | Green |
| `high` | Phase 1 deed record (standard residential sale) | County deed record with valid price | Blue |
| `medium` | Phase 1 deed (corporate owner or low price ratio) | Deed exists but ownership pattern is unusual | Yellow |
| `low` | Phase 2 heuristic-only (DOM ≥ 30 or score < 3) | MLS signals suggest sale but not verified | Gray |

During route generation, properties are weighted by confidence. `verified` and `high` are always included; `low` confidence properties are deprioritized or excluded depending on route settings.

---

## Entity Schema

| Entity | Purpose | Key Fields |
|---|---|---|
| `MasterProperty` | Central property record | `address_hash`, `lat/lng`, `original_status`, `sale_confidence`, `data_source`, `mls_id` |
| `InteractionLog` | Rep visit records | `address_hash`, `parsed_status`, `gps_proof_lat/lng`, `raw_input_text` |
| `DailyResult` | Daily visit summaries | `address_hash`, `parsed_status`, `callback_target`, `route_id` |
| `SavedRoute` | Persisted routes | `property_hashes[]`, `metrics`, `assigned_to`, `status`, `priority` |
| `FetchJob` | Background import tracker | `status`, `progress_pct`, `phase`, `sub_circles[]`, `is_delta_pull`, `total_batchdata_calls` |
| `TeamMember` | Rep/manager profiles | `name`, `email`, `role`, `manager_id`, `color`, `assigned_zip_codes` |
| `TerritoryPlan` | Campaign planning | `goal_houses`, `strategy_config`, `status` |
| `Appointment` | Scheduled appointments | `address_hash`, `scheduled_date`, `eligibility_score`, `industry` |
| `RouteTemplate` | Saved route configs | `config` (houses_per_route, filters, etc.) |
| `InviteCode` | Team onboarding | `code`, `role`, `max_uses`, `linked_user_id` |
| `LeadScoringWeights` | ML model state | `weights` (Bayesian posteriors + ADWIN drift state + channel weights) |
| `TeamMessage` | Chat messages | `channel`, `message`, `sender_email` |
| `ChatGroup` | Custom chat groups | `member_emails[]`, `manager_id` |
| `Referral` | Referral tracking | `referrer_email`, `referred_email`, `status`, `commission_amount` |

---

## Route Optimization Engine

The route optimizer (`components/logic/routeOptimizer.js`) implements a multi-stage pipeline:

1. **Scoring** — Each property gets a composite score from:
   - Status weight (ELIGIBLE > CALLBACK > others)
   - Equity/tenure signals
   - Neighborhood sales heat (nearby recent sales)
   - Bayesian learned weights (trained from rep interaction patterns via `trainLeadPredictor`)
   - Sub-score channel weights: ownership (35%), PQI (20%), heat (25%), distress (20%) — learned from data

2. **Clustering** — K-Means++ with propensity-weighted centroids groups properties into logical zones

3. **Sequencing** — Within each cluster:
   - Street-sweep pattern (odd side up, even side down)
   - Nearest Neighbor initial path
   - 2-Opt refinement (uncross overlapping segments)
   - Link Swap operators for further optimization

4. **Fatigue Awareness** — High-value stops are front-loaded early in the route

---

## Lead Scoring Model (Bayesian v3)

The `trainLeadPredictor` function implements a Beta-Binomial Bayesian model:

### Features Tracked
| Feature | Description | Channel |
|---|---|---|
| `age_gt_10` | Building older than 10 years | Ownership |
| `price_gt_300k` | Sale price > $300k | PQI |
| `single_family` | Single family property type | Distress |
| `recent_sale` | Sold within last 3 years | Ownership |
| `high_value` | Sale price > $750k | PQI |
| `large_lot` | Lot size > 0.25 acres | PQI |

### How It Works
1. **Graduated Outcomes** — Not binary. SOLD = 1.0, QUALIFIED = 0.8, CALLBACK = 0.4, NO_ANSWER = 0 (neutral), HARD_NO = -0.3 (negative evidence)
2. **Beta-Binomial Updates** — Each feature maintains an (α, β) posterior. Positive outcomes increment α; negative outcomes increment β. Prior: α₀=2, β₀=18 (10% base rate)
3. **ADWIN Drift Detection** — Splits the observation window and checks if recent conversion rates diverge from historical. If drift > 15%, trims to the more recent window
4. **Channel Weight Learning** — Maps feature posteriors to 4 sub-score channels (ownership, PQI, heat, distress) and normalizes weights that the frontend scoring engine uses

---

## Subscription & Billing

| Plan | Price | Territory | Data Period | BatchData | Seats |
|---|---|---|---|---|---|
| **Free** | $0 | 40 sq mi | 3 months | ❌ | 1 |
| **Hustler** | $49-59/mo | 300 sq mi | 1 month | ✅ | Configurable |
| **Growth** | $99/mo | 300 sq mi | 1 month | ✅ | Configurable |
| **Enterprise** | $299/mo | 300 sq mi | 1 month | ✅ | Configurable |

Payment is handled via **Stripe Checkout** with webhooks:
- `checkout.session.completed` → Activates subscription, creates invite code for team seats
- `customer.subscription.updated` → Syncs plan changes, seat count, period end
- `customer.subscription.deleted` → Marks subscription canceled, deactivates invite codes

---

## Backend Functions

### Core Pipeline

| Function | Trigger | Purpose |
|---|---|---|
| `fetchAreaProperties` | Manual (pull button) | Creates FetchJob, computes grid subdivision, detects delta watermark, starts pipeline |
| `processFetchChunk` | Self-chaining (mutex) | Processes RentCast pages in ~40-55s chunks across 2 phases (deeds → listings) |
| `processValidationQueue` | Manual/Scheduled | Dispatches pending BatchData async lookups with webhook callback |
| `batchDataWebhookCallback` | BatchData webhook (POST) | Receives async validation results, updates MasterProperty confidence levels |
| `fetchJobStatus` | Polling (1-2s) | Returns job progress for UI progress bar |
| `fetchZipProperties` | Route generation | On-demand zip code fetch for route building |
| `runMigrations` | Manual (one-time) | Creates/updates Neon PostgreSQL tables (listing_seen_log, heuristic_score_log, etc.) |
| `watchdogStaleJobs` | Scheduled | Detects and fails FetchJobs stuck in 'running' state |

### Billing & Accounts

| Function | Trigger | Purpose |
|---|---|---|
| `createCheckoutSession` | Billing page | Creates Stripe checkout URL with seat quantity |
| `createPortalSession` | Billing page | Opens Stripe customer portal for plan management |
| `stripeWebhook` | Stripe events | Updates subscription status, syncs invite codes |
| `updateSubscriptionSeats` | Team page | Adjusts Stripe subscription seat count |
| `processReferral` | Manual | Tracks referral signups and commissions |

### Intelligence

| Function | Trigger | Purpose |
|---|---|---|
| `trainLeadPredictor` | Scheduled/Manual | Trains Beta-Binomial Bayesian model with ADWIN drift detection |
| `analyzeRouteInsights` | Manual | Generates AI-powered route performance analysis |
| `generateCoachingTips` | Manual | AI-generated coaching tips from rep interaction data |
| `askAssistant` | AI help button | Context-aware AI assistant for in-app help |

### Maintenance

| Function | Trigger | Purpose |
|---|---|---|
| `reconcileZipCounts` | Scheduled | Detects data drift in stored properties vs. expected counts |
| `backupData` | Scheduled | Exports entity data for safety |
| `cleanupDatabase` | Manual | Removes orphaned or duplicate records |
| `autoAssignRoute` | Entity trigger | Auto-dispatches routes to available reps when created |

---

## User Roles

| Role | Access |
|---|---|
| **Manager** | Full map, territory drawing, route generation, team dispatch, analytics, billing |
| **Rep** | Assigned routes, knocking interface, GPS tracking, quick-mark buttons, chat |
| **Admin** | Everything + system diagnostics, data management, database tools |

Role is selected during onboarding (`RoleSelect` page) and stored on `user.app_role`.

---

## Key UI Pages

| Page | Route | Description |
|---|---|---|
| Home (Map) | `/Home` | Main map interface — territory drawing, route builder, command center |
| Rep Home | `/RepHome` | Rep knocking interface — route list, property cards, GPS tracking |
| Analytics | `/List` | Performance analytics — KPIs, charts, pipeline, rep breakdowns |
| Appointments | `/Appointments` | Appointment management with eligibility scoring |
| Team | `/AdminTeam` | Team management — members, invite codes, leaderboards, chat |
| Billing | `/Billing` | Subscription plans and Stripe checkout |
| Setup | `/Setup` | Data import, territory config, CSV upload |
| Tutorial | `/Tutorial` | Interactive onboarding guide |
| Referrals | `/Referrals` | Referral program — share codes, track commissions |
| Mobile App | `/MobileApp` | Instructions for installing as PWA / Capacitor app |

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `RENTCAST_API_KEY` | ✅ | RentCast property data API key |
| `BATCH_DATA_API_KEY` | ✅ | BatchData sale verification API key (production) |
| `BATCH_DATA_SANDBOX_KEY` | Optional | BatchData sandbox key for testing |
| `STRIPE_SECRET_KEY` | ✅ | Stripe API secret key (live mode) |
| `STRIPE_PUBLISHABLE_KEY` | ✅ | Stripe frontend publishable key |
| `STRIPE_WEBHOOK_SECRET` | ✅ | Stripe webhook signature verification secret |
| `DATABASE_URL` | ✅ | Neon PostgreSQL connection string (for auxiliary pipeline tables) |
| `PIPELINE_SECRET` | ✅ | Shared secret for authenticating BatchData webhook callbacks |
| `DEED_LAG_CUTOFF_DAYS` | Optional | Days before auto-classifying removed listings as expired (default: 120). Set higher for slow-recording counties like Harris TX |

---

## Mobile Support

FirstKnock is built mobile-first with:
- `100dvh` viewport handling for iOS Safari
- Safe area insets for notched devices
- Touch-optimized controls (large tap targets, swipe gestures)
- Capacitor wrappers for iOS/Android native builds
- Offline-first local storage with sync queue
- Zoom prevention on form inputs (`maximum-scale=1.0, user-scalable=no`)

---

## Development

This is a **Base44 platform** application. The codebase is a standard Vite + React project deployed on the Base44 infrastructure.

```bash
# Local development is handled by the Base44 platform
# Backend functions run on Deno Deploy
# Frontend is built with Vite and served via CDN
```

### Tech Stack Summary
- Frontend: React 18, Tailwind CSS, React Leaflet, React Query, Recharts, Framer Motion
- Backend: Base44 entities + Deno serverless functions
- Maps: Leaflet with ESRI satellite tiles + CARTO labels
- Payments: Stripe (live mode — Hustler/Growth/Enterprise plans)
- Data: RentCast (property records), BatchData (async sale verification)
- Database: Neon PostgreSQL with PostGIS for spatial queries
- Spatial: H3 hexagonal indexing
- ML: Beta-Binomial Bayesian model with ADWIN drift detection

---

## License

Proprietary — FirstKnock Sales OS. All rights reserved.

## Support

📧 firstknockhelp@gmail.com