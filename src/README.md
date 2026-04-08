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
| **Property Data Engine** | Pulls deed records + MLS listings via RentCast API with smart grid subdivision |
| **Delta Sync (CDC)** | Re-pulls only fetch changes since last import — ~85% fewer API calls |
| **AI Route Optimizer** | Generates street-sweep walking routes using K-Means clustering, Nearest Neighbor, 2-Opt, and fatigue-aware sequencing |
| **Bayesian Lead Scoring** | Learns from rep interactions to prioritize high-conversion properties |
| **Live GPS Tracking** | Real-time rep location with proof-of-visit and accuracy radius |
| **Team Dispatch** | Uber-style auto-assignment based on availability, proximity, and performance |
| **Appointment Scheduling** | Book, track, and score appointments with eligibility scoring |
| **Real-Time Chat** | Team messaging with channels, DMs, and group chats |
| **Analytics Dashboard** | Command center with KPIs, leaderboards, conversion funnels, and territory penetration |

---

## Architecture

### Frontend
- **React 18** + **Vite** — SPA with code splitting via `React.lazy`
- **Tailwind CSS** — Dark glassmorphism design system (`#0A0A0F` base, gold accents)
- **React Leaflet** — Interactive satellite maps with custom layers
- **React Query** — Server state management with real-time subscriptions
- **Framer Motion** — Animations and transitions
- **Recharts** — Analytics visualizations

### Backend (Base44 Platform)
- **Entities** — 13 data models (MasterProperty, SavedRoute, InteractionLog, FetchJob, etc.)
- **Backend Functions** — Deno Deploy serverless functions for API integrations
- **Automations** — Entity-triggered and scheduled background jobs
- **Real-Time** — WebSocket subscriptions for live data updates

### External Integrations
| Service | Purpose |
|---|---|
| **RentCast API** | Property data — deed records (`/v1/properties`) and MLS listings (`/v1/listings/sale`) |
| **BatchData API** | Sale verification for ambiguous MLS records (Pro tier only, 300mi pulls) |
| **Stripe** | Subscription billing — $59/mo Pro plan with 7-day free trial |
| **H3 (Uber)** | Hexagonal spatial indexing for property clustering |

---

## Data Pipeline

### Property Ingestion Flow

```
User draws territory → fetchAreaProperties (creates FetchJob)
                           ↓
                    processFetchChunk (self-chaining)
                           ↓
              ┌────────────┴────────────┐
              │                         │
        Phase 1: Deeds            Phase 2: MLS Listings
     /v1/properties              /v1/listings/sale?status=Inactive
     (county records)            (early warning radar)
              │                         │
              │                    Heuristic Filter
              │                    (score -4 to +5)
              │                         │
              │                 ┌───────┼───────┐
              │            Auto-Reject  Ambiguous  Likely Sold
              │            (score≤-4)   (-3 to +2) (score≥3)
              │                              │
              │                    Cross-ref Phase 1 deeds
              │                              │
              │                    BatchData verify (Pro only)
              │                              │
              └──────────┬──────────────────┘
                         ↓
                   MasterProperty entity
                   (deduplicated by normalized address hash)
```

### Cost Controls
- **Free tier (40mi / 3 months):** No BatchData validation. Low-confidence MLS records are automatically filtered out during route generation.
- **Pro tier (300mi / 1 month):** Full BatchData cross-check for ambiguous MLS records. Verified properties get `sale_confidence: 'verified'`.
- **Delta pulls:** On re-import, only fetches records updated since last pull (~85% API cost reduction).

---

## Entity Schema

| Entity | Purpose | Key Fields |
|---|---|---|
| `MasterProperty` | Central property record | `address_hash`, `lat/lng`, `original_status`, `sale_confidence`, `data_source` |
| `InteractionLog` | Rep visit records | `address_hash`, `parsed_status`, `gps_proof_lat/lng`, `raw_input_text` |
| `DailyResult` | Daily visit summaries | `address_hash`, `parsed_status`, `callback_target`, `route_id` |
| `SavedRoute` | Persisted routes | `property_hashes[]`, `metrics`, `assigned_to`, `status` |
| `FetchJob` | Background import tracker | `status`, `progress_pct`, `phase`, `sub_circles[]`, `is_delta_pull` |
| `TeamMember` | Rep/manager profiles | `name`, `email`, `role`, `manager_id`, `color` |
| `TerritoryPlan` | Campaign planning | `goal_houses`, `strategy_config`, `status` |
| `Appointment` | Scheduled appointments | `address_hash`, `scheduled_date`, `eligibility_score`, `industry` |
| `RouteTemplate` | Saved route configs | `config` (houses_per_route, filters, etc.) |
| `InviteCode` | Team onboarding | `code`, `role`, `max_uses`, `linked_user_id` |
| `LeadScoringWeights` | ML model state | `weights` (Bayesian posteriors + ADWIN drift) |
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
   - Bayesian learned weights (trained from rep interaction patterns)

2. **Clustering** — K-Means++ with propensity-weighted centroids groups properties into logical zones

3. **Sequencing** — Within each cluster:
   - Street-sweep pattern (odd side up, even side down)
   - Nearest Neighbor initial path
   - 2-Opt refinement (uncross overlapping segments)
   - Link Swap operators for further optimization

4. **Fatigue Awareness** — High-value stops are front-loaded early in the route

---

## Subscription & Billing

| Feature | Free | Pro ($59/mo) |
|---|---|---|
| Territory size | 40 sq mi | 300 sq mi |
| Data period | 3 months | 1 month (fresher leads) |
| BatchData verification | ❌ | ✅ |
| Route generation | Unlimited | Unlimited |
| Route rebuilds (frozen data) | ✅ | ✅ |
| GPS tracking | ✅ | ✅ |
| Team management | ✅ | ✅ |
| Advanced filters | ✅ | ✅ |
| Priority support | ❌ | ✅ |

Payment is handled via **Stripe Checkout** with a webhook (`functions/stripeWebhook.js`) that updates the user's `subscription_status`.

---

## Backend Functions

| Function | Trigger | Purpose |
|---|---|---|
| `fetchAreaProperties` | Manual (pull button) | Creates FetchJob, starts grid subdivision |
| `processFetchChunk` | Self-chaining | Processes RentCast pages in 60s chunks |
| `fetchJobStatus` | Polling (1-2s) | Returns job progress for UI |
| `fetchZipProperties` | Route generation | On-demand zip code fetch |
| `createCheckoutSession` | Billing page | Creates Stripe checkout URL |
| `createPortalSession` | Billing page | Opens Stripe customer portal |
| `stripeWebhook` | Stripe events | Updates subscription status |
| `trainLeadPredictor` | Scheduled | Trains Bayesian lead scoring model |
| `autoAssignRoute` | Entity trigger | Auto-dispatches routes to available reps |
| `generateCoachingTips` | Manual | AI-generated coaching from rep data |
| `askAssistant` | AI help button | Context-aware AI assistant |
| `processReferral` | Manual | Tracks referral signups |
| `reconcileZipCounts` | Scheduled | Detects data drift in stored properties |
| `backupData` | Scheduled | Exports entity data for safety |

---

## User Roles

| Role | Access |
|---|---|
| **Manager** | Full map, territory drawing, route generation, team dispatch, analytics, billing |
| **Rep** | Assigned routes, knocking interface, GPS tracking, quick-mark buttons, chat |
| **Admin** | Everything + system diagnostics, data management |

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

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `RENTCAST_API_KEY` | ✅ | RentCast property data API |
| `BATCH_DATA_API_KEY` | ✅ | BatchData sale verification (Pro tier) |
| `STRIPE_SECRET_KEY` | ✅ | Stripe API (live mode) |
| `STRIPE_PUBLISHABLE_KEY` | ✅ | Stripe frontend key |
| `STRIPE_WEBHOOK_SECRET` | ✅ | Stripe webhook signature verification |
| `DATABASE_URL` | Optional | Neon PostgreSQL (legacy, currently stubbed) |

---

## Mobile Support

FirstKnock is built mobile-first with:
- `100dvh` viewport handling for iOS Safari
- Safe area insets for notched devices
- Touch-optimized controls (large tap targets, swipe gestures)
- Capacitor wrappers for iOS/Android native builds
- Offline-first local storage with sync queue

---

## Development

This is a **Base44 platform** application. The codebase is a standard Vite + React project deployed on the Base44 infrastructure.

```bash
# Local development is handled by the Base44 platform
# Backend functions run on Deno Deploy
# Frontend is built with Vite and served via CDN
```

### Tech Stack Summary
- Frontend: React 18, Tailwind CSS, React Leaflet, React Query, Recharts
- Backend: Base44 entities + Deno serverless functions
- Maps: Leaflet with ESRI satellite tiles + CARTO labels
- Payments: Stripe (live mode)
- Data: RentCast (property records), BatchData (sale verification)
- Spatial: H3 hexagonal indexing

---

## License

Proprietary — FirstKnock Sales OS. All rights reserved.

## Support

📧 firstknockhelp@gmail.com