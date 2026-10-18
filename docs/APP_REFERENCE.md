# FirstKnock app reference

The screen-by-screen guide, the core entity fields and the component map. This is moved here from the README, which now covers architecture and operations.

> This guide was written before the October 2026 routing and map work. Line counts and some screen details may lag the code. Where they differ, the code is right. The current optimizer, map-load and storage behaviour is in the [README](../README.md).

## Screens

### `RoleSelect.jsx` — Landing Page & Authentication Gate

**Route:** `/` (mainPage)\
**Purpose:** First touchpoint. Determines whether the user is a Manager or Rep.

**Displayed Elements:**
- Full-screen background image with glassmorphism overlay cards
- **"Create a Workspace"** button → Sets `app_role: 'manager'`, redirects to `Home`
- **"Join a Team"** card → Text input for 4-digit invite code. On submit:
  1. Validates code against `InviteCode` entity (`is_active: true`)
  2. Creates a `TeamMember` record linking the rep to the manager
  3. Increments `used_count` on the invite code
  4. Redirects to `RepHome`
- **"Resume My Route"** button → Appears only if a `TeamMember` record already exists for this email
- Auto-applies referral codes from `?ref=` URL parameter via `processReferral` function

---

### `Home.jsx` — Manager Territory Dashboard (2,314 lines)

**Route:** `/Home`\
**Role Required:** `manager`\
**Purpose:** The primary command center for territory visualization, data pulling, route generation, and team dispatch.

**Map Engine:** React-Leaflet with CircleMarker rendering (not Mapbox GL — uses Leaflet with multiple tile layer options).

**Display Modes:**
| Mode | Description |
|------|-------------|
| `generate` | Opens the Route Builder. Draw a polygon/circle to trigger data pulls. |
| `analyze` | Default mode when data exists. Shows all properties as colored pins on the map. |

**Map Layers & Visualization:**
- **Pin Colors** — Color-coded by `effective_status`:
  - `ELIGIBLE` → Dark Gray (#404040) — not yet knocked
  - `SOLD` / `QUALIFIED` → Neon Green (#00F5A0) — converted
  - `HARD_NO` → Soft Red (#FF6B6B)
  - `CALLBACK` → Gold (#FFD93D)
  - `RECENT_OFF_MARKET` → Gold (#FFD700) — MLS early warning
  - `UNVERIFIED` → Purple (#A855F6) — legacy CSV imports
- **4 Color Schemes:** Default, Neon, Pastel, Heatmap, Monochrome (selectable via `MapSettingsPanel`)
- **Pin Customization:** Size (1-15px), shape (circle), opacity, glow effect, border width/color
- **Route Lines:** Polyline connections between route stops. Styles: solid, dashed, dotted, dashdot. Configurable width and opacity.
- **Heatmap View:** Toggleable `pins` vs `heatmap` mode using `generateHeatmapGrid()` and `generateStateClusters()`
- **GPS Tracker:** Real-time location tracking overlay with `GpsTracker`, `GpsMapLayer`, and `GpsHud` components
- **ZIP Code Overlay:** Toggle-able boundary visualization via `ZipCodeOverlay`

**Data Fetching:**
- Queries `MasterProperty` for all ZIP codes in `user.territory_zip_codes` + `user.generated_zip_codes`
- Chunks ZIP queries into batches of 5 to prevent browser memory overflow
- Hard cap: 50,000 properties maximum loaded into the client
- Deduplicates by `house_number | street_name | zip_code` (keeps newest `sold_date`)
- Merges with `localProperties` (IndexedDB offline cache) and `darkRoomProperties`

**Drawing Tools (`MapDrawTool.jsx` + `TerritoryPrompt.jsx`):**
- Shapes: Circle, Square, Triangle
- **Hard constraint: 40 square miles maximum area**
- **Default lookback: 3 months of sold data**
- On draw completion → Triggers `fetchAreaProperties` cloud function → Creates a `FetchJob`
- `FetchJob` is polled by the UI until status = `complete`
- Drawn polygons persist in `localStorage` under key `fk_drawnPolygon`

**Route Generation Engine (`routeOptimizer.js`):**
- Configurable per-route house count (25, 50, 75, 100)
- Walking patterns: `street_sweep` (default), with `2-opt` optimization and turn minimization
- Filters: exclude commercial, condos, land, previously knocked, terminal statuses
- Price range filter (min/max), year built filter, property type filter
- **Competitiveness scoring** per route based on property density and sale recency
- **Start location** support — geocodes an address to seed the route origin

**Route Assignment & Dispatch (Uber-Style):**
- `getRepRecommendations()` scores each team member on 3 axes:
  - **Availability (30%)** — How many active routes they already have
  - **Distance (30%)** — Haversine distance from their last GPS log to route center
  - **Performance (40%)** — Historical conversion rate (sales / total knocks × 5, capped at 100)
- **Auto-Assign All** button dispatches all generated routes to the highest-scoring available reps
- Manual assignment via dropdown per route

**Route Templates:**
- Save current route config (houses per route, filters, start location) as a reusable `RouteTemplate`
- Load templates to instantly reconfigure the route builder

**Additional Panels:**
- `CommandCenterDashboard` — Summary analytics overlay
- `MapSettingsPanel` — Pin size, color scheme, line style, label toggles
- `RouteBuilderSettings` — Walking pattern, property type exclusions, price/year filters
- `RouteChecklist` — Per-property checklist within active route
- `RouteCommandPanel` — Bulk route operations
- `KnockTimeBanner` — Displays optimal knocking window based on time of day
- `PolygonHistory` — Saves/restores previously drawn territory polygons
- `ManagerPropertyDetailSheet` — Click any pin to see full property details + interaction history

**Real-Time Updates:**
- WebSocket subscription to `InteractionLog` entity. When a rep logs an interaction, the manager map updates live with toast notification.

---

### `RepHome.jsx` — Mobile-First Knocking Interface (730 lines)

**Route:** `/RepHome`\
**Role Required:** `rep` (or manager in rep mode)\
**Purpose:** The field interface reps use while door-knocking. Designed for one-handed mobile use.

**Header (`RepHeader.jsx`):**
- Rep name, route name, progress bar (% complete)
- Door count: `Done X / Total Y`
- Knock window indicator (optimal knocking time)
- Route switcher button (if assigned to multiple routes)

**Route Discovery Logic:**
- Fetches ALL `SavedRoute` records, then filters locally for routes where:
  1. `assigned_to` matches any of the rep's known IDs (auth ID or `TeamMember` ID)
  2. `assigned_to_name` fuzzy-matches the rep's `full_name` (handles first-name variations like "Charles" vs "Charlie")
  3. `manager_id` matches (for managers viewing in rep mode)
- Prioritizes `IN_PROGRESS` routes, then `ACTIVE`, then most recent
- **Offline caching:** Routes are cached in `localforage` under key `cached_routes`. Properties cached under `cached_props_{routeId}`.

**Property List:**
- Scrollable card list rendered via `PropertyCard.jsx`
- Each card shows: house number, street name, sold date, sale price, property type, beds/baths/sqft
- Color-coded status badge (Eligible, Callback, No Answer, Sold, Hard No)
- **Sort order:** `optimizeRouteForTime()` reorders properties based on current time of day

**Filter Controls:**
- **Segmented tabs:** Todo (not yet knocked) / Done / All
- **Sold Date Filter dropdown:** All Time, 1 Week, 2 Weeks, 1 Month, 3 Months, 6 Months, 9 Months, 1 Year
- **Address search** (appears when route has > 8 properties)

**Property Detail Sheet (`PropertyDetailSheet.jsx`):**
- Full-screen bottom sheet overlay
- Displays: full address, price, beds/baths/sqft, lot size, year built, sold date
- **Quick-action buttons:** "No Answer", "Not Interested", "Callback", "Interested/Sold"
- **Photo upload:** Camera button captures image → uploads via `base44.integrations.Core.UploadFile` → attaches to `InteractionLog`
- **GPS proof-of-visit:** On every interaction log, captures `navigator.geolocation.getCurrentPosition()` with high accuracy. Stores `gps_proof_lat`, `gps_proof_lng`, and `gps_accuracy` in the log record.
- **"View on Map" button** → Opens `RepMapView.jsx` centered on the property
- **Property history timeline** shows all previous interaction logs for this address

**Map View (`RepMapView.jsx`):**
- Full-screen Leaflet map showing all properties on the active route
- Pins colored by status. Tap a pin → opens property detail sheet.
- **Focus mode:** When triggered from property card, map auto-pans to that property

**Floating Action Buttons:**
- **Complete Route** (appears at 100%) → Marks route as `COMPLETED`
- **Analytics** → Opens `RepAnalytics.jsx` (personal performance: knocks, sales, conversion rate)
- **Team Chat** → Opens `TeamChat.jsx` (real-time messaging with team)

**Real-Time Team Sync:**
- WebSocket subscription to `InteractionLog`. If another rep knocks a door on the same route, the property list updates immediately to prevent double-knocking.

**Upgrade Gate (`UpgradeGate.jsx`):**
- Triggered after 50 logged interactions on the free plan
- Displays upgrade prompt with link to `Billing` page

---

### `AdminTeam.jsx` — Command Center & Roster Management (918 lines)

**Route:** `/AdminTeam`\
**Purpose:** Team management hub with analytics, roster, route assignment, access codes, and time tracking.

**Stats Bar (top):**
- Total Knocks (across team) | Total Sales | Active Seats (used/total) | Total Routes

**Team tabs:**

#### Analytics Tab
- `TeamAnalyticsSummary` — KPI cards: total knocks, talk rate, conversion rate, avg knocks per rep
- `TeamActivityTrend` — Line chart showing daily knock volume over time
- `TeamOutcomeBreakdown` — Pie chart of interaction outcomes (Sold, Callback, No Answer, Hard No)
- `TeamLeaderboard` — Ranked list of reps by doors knocked, sales, and conversion rate

#### Roster Tab
- Grid of `TeamMemberCard` components, one per team member + manager
- Each card displays: name, email, role badge, assigned color dot, routes count, doors knocked, sales count
- **Actions per member:**
  - Click card → Opens `RepPerformanceDetail` (deep-dive: conversion rate vs team avg, daily activity, outcome distribution)
  - Assign ZIP codes via popover editor (comma-separated 5-digit codes)
  - Unassign all routes
  - Delete team member (cascades: unassigns all routes, deletes `TeamMember` record)
- **Add Rep** dialog: Name, Email, Role (Rep/Manager) → Creates `TeamMember` record
- **Seat gating:** Free plan = 1 seat. Paid plan = `user.total_seats`. Blocks adding reps when full.

#### Routes Tab (Logistics)
- **Unassigned Routes** alert card at top (red border) with quick-assign dropdowns
- **Route Registry** — Searchable table of all routes showing: name, house count, distance, zip code, status, assigned rep
- Each row has an assign dropdown to dispatch the route to any team member

#### Access Codes Tab
- Displays all `InviteCode` records created by this manager
- Each code shows: code value, role, max uses, used count, active status
- **"Create Demo" button** → Generates a random 4-digit code with 5 uses
- Invite codes link new users to this manager's workspace via `linked_user_id`

**Backup Handler:**
- Invokes `backupData` cloud function → Downloads all team data as JSON file

#### Time Clock Tab
- Canvassers clock in and out from **Teams → Time Clock** and view their own shift history.
- Managers and reps record their own shifts. Managers see the entire live clocked-in roster above Timesheets, independently of reporting dates and people filters.
- Shifts use server timestamps and remain open when the app closes. An internet connection is required to clock in or out.
- Timesheets default to This week (Monday through today), with Today, Yesterday, Last week, and Custom dates. Each team uses its manager's saved reporting timezone (America/Phoenix by default). Date boundaries, today's completed hours, input times, and exports agree across daylight-saving transitions and overnight shifts.
- Completed hours exclude open shifts. Expand a person to inspect shifts, pending corrections, and the adjustment history. Export previews follow the selected dates and people, with CSV choices for totals by person or completed shift details; timestamps and range bounds are explicit UTC and include the reporting timezone.
- Managers can close forgotten shifts at their actual finish, edit times, or add a missing shift with a reason. Audit entries retain original and corrected timestamps, editor, and time. Reps request corrections; managers resolve them by editing recorded times. Revisions prevent stale changes; retries are idempotent and overlapping/future/invalid recorded times are rejected. Open shifts over 12 hours are marked Needs review without changing their finish.
- `timeClock` validates saved roles and team membership. All attendance actions serialize by account using transaction advisory locks in the existing `DATABASE_URL` connection, across devices, teams and role changes. Attendance stays in protected Base44 `TimeShift` records; existing TeamMember claims still recover interrupted legacy clock-ins. No User bulk updates are used. Saving fails closed when locking is unavailable; reports remain readable.
- Deployment includes `base44/entities/TimeShift.jsonc`, the protected User reporting-timezone field, `base44/shared/timeClock.js`, and `base44/functions/timeClock/entry.ts`, plus the frontend. Entity filenames must match their schema names exactly. The authenticated manager-only `check_saving` diagnostic tests connection/locking without creating attendance records.

---

### `Appointments.jsx` — Appointment Management

**Route:** `/Appointments`\
**Purpose:** Post-knock workflow. Tracks scheduled follow-up appointments.

**Header Stats:** Upcoming | Today | Done | No-Show\
**Time Tabs:** Upcoming, Today, This Week, Past, All\
**Status Chips:** All, Scheduled, Confirmed, Completed, Cancelled, No Show

**Features:**
- **Appointment Cards** (`AppointmentCard.jsx`) — Show address, homeowner name, date/time, status badge, industry
- **Appointment Detail** modal — Full details, status update buttons, notes
- **New Appointment Form** — Address, homeowner name, phone, date/time, notes
- **Auto-Schedule Panel** (`AutoSchedulePanel.jsx`) — Automatically generates appointments from eligible callbacks in the interaction log. Uses `EligibilityScorer` to filter by industry.
- Date grouping with smart labels ("Today", "Tomorrow", "Mon, Apr 7")

---

### `AdvancedAnalytics.jsx` — Data Intelligence Dashboard

**Route:** `/AdvancedAnalytics`\
**Purpose:** Deep analytical views across appointments, routes, and team performance.

**Filters:** Date range (7/14/30/60/90 days / All), Industry filter\
**6 Analytics Panels:**
1. `KpiSummaryCards` — High-level KPI tiles
2. `AppointmentTimeline` — Day-by-day appointment volume chart
3. `AppointmentForecast` — Predictive model for upcoming appointment volume
4. `ConversionByIndustry` — Bar chart: what industries convert best
5. `RepSuccessRate` — Per-rep success rates
6. `RouteEfficiency` — Route-level performance (knocks per mile, conversion per route)

---

### `ZipCodeExplorer.jsx` — ZIP-Level Route Generator

**Route:** `/ZipCodeExplorer`\
**Purpose:** Alternative to polygon drawing. Enter a ZIP code → query all properties → generate routes.

**Features:**
- ZIP code input → Queries Neon PostgreSQL directly via `getConnection()` (legacy path)
- Also triggers `fetchZipProperties` (Base44 path with 3-Step Pipeline)
- Leaflet map with CircleMarker rendering of all results
- **Route Generation** with configurable filters:
  - Houses per route (25/50/75/100/150 — 50+ requires paid plan)
  - Max routes (1–20)
  - Min/Max price ($100K–$2M)
  - Sold within (1–10 years)
- Route sidebar with expandable property table per route
- **Combine All** — Merges all generated routes into a single mega-route
- **Save All Routes** — Bulk saves to `SavedRoute` entity, redirects to `AdminTeam`

---

### `Billing.jsx` — Stripe Subscription Management

**Route:** `/Billing`\
**Plan:** FirstKnock Pro — $49/mo\
**Features:**
- 7-day free trial option or direct subscribe
- Stripe Checkout integration via `createCheckoutSession` cloud function
- Post-checkout success handler (auto-detects `?success=true` URL param)
- "Manage Subscription" button → Opens Stripe Customer Portal via `createPortalSession`
- Active subscription badge (Trial / Active)
- `BetaUsageMeter` component — Shows current data pull usage

---

### `Setup.jsx` — Data Center & Configuration

**Route:** `/Setup`\
**Purpose:** Territory management, data import, and competitive positioning.

**4 Tabs:**
1. **Territory** — `TerritoryFilter` (manage territory ZIP codes) + `BetaUsageMeter` (pull count tracking)
2. **Import Data** — `ImportGuide` (column mapping tutorial) + `CsvUploader` (drag-and-drop CSV/JSON file import with auto-detect column mapping)
3. **Switch Tool** — `CompetitorSwitchBanner` + feature comparison table (FirstKnock vs competitors)
4. **Help & FAQ** — Embedded FAQ page + link to Tutorial

**Quick Stats:** Record count, CSV export button, setup time, savings vs competitors

---

### `CostProjections.jsx` — Unit Economics Calculator

**Route:** `/CostProjections`\
**Purpose:** Internal financial modeling tool. Calculates operational costs at scale.

**Models:** RentCast API cost curves (7 plan tiers with overage), Base44 platform costs, Stripe fee calculation (2.9% + $0.30), App Store commission (30% cut).\
**Charts:** Recharts-powered AreaChart, BarChart, LineChart visualizations of cost per user, gross margin, and break-even projections.

---

### Additional Pages

| Page | Purpose |
|------|---------|
| `SignIn.jsx` | Minimal authentication redirect |
| `Tutorial.jsx` | Step-by-step user guide with embedded screenshots |
| `FAQ.jsx` | Accordion-style frequently asked questions |
| `Referrals.jsx` | Referral code generation and tracking |
| `MobileApp.jsx` | PWA install prompt for mobile users |
| `Roadmap.jsx` | Product roadmap display |
| `Terms.jsx` | Terms of service |
| `DeleteAccount.jsx` | Account deletion flow |
| `Sync.jsx` | Offline queue sync status |
| `List.jsx` | Flat property list view (table format, sortable) |
| `DatabaseDiagnostic.jsx` | Debug tool: inspect raw DB records, data health metrics |
| `FetchTest.jsx` | Developer tool: test RentCast API calls with custom parameters |

---

## Data Entities & Schema

### `MasterProperty` — The Central Property Record
```
address_hash      STRING (PK)  — Normalized: "ADDRESS_LINE_1|ZIP_CODE"
house_number      INTEGER
street_name       STRING
full_address      STRING
city, state       STRING
zip_code          STRING (5-digit)
lat, lng          FLOAT
h3_index          STRING       — Uber H3 hex at resolution 9
beds, baths       INTEGER
sqft, lot_size    INTEGER
year_built        INTEGER
price             INTEGER
sold_date         DATE
sale_type         ENUM         — "Deed" | "MLS"
sale_confidence   ENUM         — "high" | "medium" | "low" | "verified" | "REJECTED"
original_status   STRING       — "SOLD" | "ELIGIBLE" | "HEURISTIC_SOLD" | "BATCHDATA_CONFIRMED" | "RECENT_OFF_MARKET" | "REJECTED"
property_type     STRING       — "Single Family" | "Townhouse" | "Condo" | etc.
data_source       STRING       — "rentcast" | "batchdata_verified" | "csv_import"
mls_id            STRING
```

### `SavedRoute`
```
name              STRING
property_hashes   STRING[]     — Array of address_hash values
metrics           JSON         — { distance, house_count, score }
status            ENUM         — "PENDING" | "ACTIVE" | "IN_PROGRESS" | "COMPLETED" | "ARCHIVED"
assigned_to       STRING       — TeamMember ID or User ID
assigned_to_name  STRING
manager_id        STRING
start_location    JSON         — { lat, lng, address }
```

### `InteractionLog`
```
address_hash      STRING       — Links to MasterProperty
parsed_status     ENUM         — "NO_ANSWER" | "HARD_NO" | "CALLBACK" | "SOLD" | "QUALIFIED"
raw_input_text    STRING
gps_proof_lat     FLOAT
gps_proof_lng     FLOAT
gps_accuracy      FLOAT        — Meters
image_url         STRING       — Photo proof URL
route_id          STRING       — Links to SavedRoute
created_by        STRING       — Rep email
```

### `TeamMember`
```
name              STRING
email             STRING
role              ENUM         — "rep" | "manager"
status            ENUM         — "active" | "inactive"
color             STRING       — Hex color for map pins
manager_id        STRING       — Links to manager User ID
invite_code       STRING       — Code used to join
assigned_zip_codes STRING[]    — Territory assignment
```

### `InviteCode`
```
code              STRING       — 4-digit alphanumeric
role              ENUM         — Role granted on use
linked_user_id    STRING       — Manager who created the code
max_uses          INTEGER
used_count        INTEGER
is_active         BOOLEAN
```

### Other Entities
- `Appointment` — Scheduled follow-ups with homeowner details
- `RouteTemplate` — Saved route generation configs
- `FetchJob` — Tracks async data pull progress
- `LeadScoringWeights` — ML model weights for property scoring
- `PropertyValidationCache` — Cached BatchData verification results

---

## Component Library Map

```
src/components/
├── analytics/          — Charts: DateRangeFilter, KpiSummaryCards, ConversionByIndustry, etc.
│   └── team/           — TeamAnalyticsSummary, TeamActivityTrend, TeamOutcomeBreakdown
├── appointments/       — AppointmentCard, AppointmentDetail, AutoSchedulePanel, EligibilityScorer
├── beta/               — BetaUsageMeter (data pull tracking)
├── chat/               — Team chat components
├── dashboard/          — CommandCenterDashboard, CsvUploader
├── help/               — Help/support components
├── insights/           — Route insights visualizations
├── list/               — Table-format property list components
├── logic/              — Pure business logic modules:
│   ├── routeOptimizer.js      — 2-opt TSP solver with street sweep pattern
│   ├── territoryLogic.js      — determineEffectiveStatus(), isPointInPolygon()
│   ├── heatmapLogic.js        — Grid-based heatmap generation
│   ├── knockTimeOptimizer.js  — Time-of-day knocking window logic
│   └── navigation.js          — openInMaps() (Apple/Google/Waze deep links)
├── manager/            — TerritorySetupWizard
├── map/                — MapDrawTool, MapHelpers, MapSettingsPanel, MapToolbar,
│                         ManagerMapLayers, ManagerPropertyDetailSheet,
│                         GpsTracker, ZipCodeOverlay, PolygonHistory, TerritoryPrompt
├── onboarding/         — MarketOnboarding (first-time setup flow)
├── referral/           — Referral system components
├── rep/                — RepMapView, RepHeader, PropertyCard, PropertyDetailSheet,
│                         RepAnalytics, QuickMarkButtons, PropertyHistory
├── routes/             — RouteChecklist, RouteCommandPanel
├── setup/              — TerritoryFilter, ImportGuide, CompetitorSwitchBanner
├── team/               — TeamMemberCard, RepPerformanceDetail, TeamLeaderboard
├── theme/              — ThemeProvider (accent color system)
├── timing/             — KnockTimeBanner
├── ui/                 — shadcn/ui primitives (Button, Card, Dialog, Input, etc.)
└── upgrade/            — UpgradeGate (paywall component)
```
