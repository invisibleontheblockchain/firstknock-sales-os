# FirstKnock Sales OS 

**FirstKnock Sales OS** is a highly specialized door-to-door sales routing platform built on **React**, **Vite**, and **Base44** (Backend-as-a-Service). It empowers field representatives to target exclusively high-confidence, recently sold homes by leveraging an advanced 3-Step Property Validation Pipeline that mathematically eliminates stale leads and false positives.

---

## 🏗 Backend Architecture & Data Methodology

To optimize API unit economics and guarantee data reliability without over-saturating the database, FirstKnock utilizes a hybrid ingestion method. The data pipeline is orchestrated heavily inside Base44 Deno cloud functions (`base44/functions/`).

### The 3-Step Property Validation Pipeline

This pipeline sits at the core of the `processFetchChunk` and `fetchZipProperties` asynchronous background workers. It evaluates homes in three sequential stages before they enter the `MasterProperty` database.

#### 1. RentCast Aggregation (Streams A & B)
- **Stream A (County Deeds):** Directly pulls officially recorded deeds via the `RentCast` `/properties` endpoint. These are treated as the "Gold Standard" (`sale_confidence: 'high'`) and bypass heuristic filtering.
- **Stream B (MLS Inactive):** Pulls "Recent Off-Market" records (`status=Inactive`). These act as an early warning radar for sales that haven't cleared the county registrar yet, but inherently include withdrawn and expired listings which must be pruned.

#### 2. Advanced Heuristic Pruning (The Deno Engine)
Because Stream B contains withdrawn, canceled, and expired homes, an algorithmic scoring system computes the probability of a sale across all off-market properties.
- **Negative Indicators (Score -1 to -3):** Punishes properties lingering on the market for exact contract boundaries (90, 180, 365 days), ultra-short listings (< 7 days), or listings exhibiting multiple flip attempts.
- **Positive Indicators (Score +1 to +3):** Rewards properties matching standard escrow sweet-spots (e.g., 30-45 Days on Market) or single listings.
- **Outcomes:** 
  - `Score >= 3` ➔ **HEURISTIC_SOLD** (Bypasses verification; heavily assumed sold).
  - `Score <= -4` ➔ **REJECTED** (Likely expired; purged instantly from database insertion).
  - `Score 0 to 2` ➔ **AMBIGUOUS** (Transferred to the BatchData Sink).

#### 3. BatchData API Verification Sink (The "Truth" Check)
For ambiguous properties that fall in the gray area, the system executes a synchronous query to the **BatchData Property Search API** (`api.batchdata.com/api/v1/property/search`).
- **Cost Capping Mechanism:** The engine is hard-capped via `cacheMisses.slice(0, 100)` to process a maximum of 100 ambiguous queries per 300sqmi/40sqmi map sector to prevent runaway AWS/Base44 execution timeout and API bankruptcy.
- **Execution:** It parses `statusCategory` and `soldPrice`. Confirmed hits merge as `BATCHDATA_CONFIRMED`; misses merge as `REJECTED`.

---

## 🗺 Application Page Topography & Feature Map

### 1. `Home.jsx` (The Manager Territory Dashboard)
The primary desktop-first analytics dashboard designed for Team Managers to draw, allocate, and visualize markets.
- **Mapbox GL Integration:** Visualizes the entire `MasterProperty` SQL table. Plots colored nodes correlating to status (e.g., Green = Verified Deed, Yellow = Heuristic Sold).
- **Core Features:** 
  - **Drawing Tools:** Turf.js map-box draw utilities mapped to a 40 square mile hard constraint limit.
  - **Chunk Ingestion triggers:** Launching a draw triggers an initial REST API call to `fetchAreaProperties`, which in turn creates a `FetchJob` worker process polled by the UI. 
  - **Cost Calculators & Auto-Router:** Evaluates the density of verified leads within the drawn polygon to project the exact number of reps required to harvest the territory. 

### 2. `RepHome.jsx` (The "Knock" Tab)
The mobile-first field interface utilized heavily by Door-to-Door reps hitting the pavement.
- **Core Strategy:** Represents a single `SavedRoute`. Given strict routing limits, routing dictates a precise number of houses (e.g., Christian's 85-house methodology).
- **Offline-First Deterministic Sorting ("Clean Route"):** Instead of repeatedly hitting database tables for route filtering, the client mathematically generates address normalization hashes (`addressLine|zipCode`) locally. It cross-references `MasterProperty` against `SavedRoute` completely bypassing SQL limits to ensure the route contains EXACTLY the required verified houses with 0% data drift.
- **Features:** Quick-actions to open properties in native apps (Google Maps, Waze, Apple Maps).

### 3. `AdminTeam.jsx` (Roster Management)
- **Role Elevation:** Handles Base44 role-based access control (RBAC), allowing owners to promote users to `manager` or limit them to `rep` scopes.
- **Invites:** Issues magic user creation links correlated directly to the company's Base44 environment.

### 4. `MarketOnboarding.jsx` & `TerritoryPrompt.jsx`
- **Initial Configuration Gate:** Intercepts first-time Manager logins, forcing them to establish a baseline 40 sq mile perimeter with a defined timeline constraint (defaults heavily to `3 months` backwards historical depth).
- **Data Pulls & Billing Logic:** Enforces the "2 Free Pulls" logic via incrementing `area_pulls_count` across the user document. Hooked to the `stripeWebhook` function for paywalls.

### 5. `Appointments.jsx` & `AutoSchedulePanel.jsx`
- Post-Knock workflows. When field reps capture a lead, it drops into an appointment queue. The UI utilizes interactive calendars dynamically linked to Base44 relationships filtering by assigned `rep_id`.

### 6. `ZipCodeExplorer.jsx`
- Secondary macro-dashboard utilized when polygon drawing is unnecessary. Aggregates the standard `fetchZipProperties` synchronous pipeline for massive ZIP-wide lead extractions.

---

## 🛠 Cloud Functions Ecosystem (`base44/functions/`)

All heavy analytical computing natively relies on Base44 functions to offload client lag (especially on mobile endpoints like `RepHome.jsx`).

- **`processFetchChunk`**: The asynchronous, multi-phase backbone behind polygon fetching. It splits massive shapes into overlapping >5mi sub-circles, prevents RentCast 400-series radius errors, manages the RentCast/Heuristic/BatchData 3-Step Pipeline, and recursively re-invokes itself until `FetchJob` is marked complete.
- **`fetchZipProperties`**: The synchronous equivalent of the data aggregator running the identical 3-step pipeline but confined strictly to a 5-digit regex ZIP payload. 
- **`syncOfflineQueue`**: Guarantees that if a Door-to-Door representative forces a `Clean Route` rebuild in the field where cellular connection drops, hashes are reconciled immediately upon re-establishing `navigator.onLine`.
- **`geocodeProperties`**: Uber's `h3-js` library is deeply injected here to hex-index longitudes and latitudes for lightning-fast database polygon queries when managers shift the `Home.jsx` map viewport.

---

## 🚀 Setup & Local Development

1. **Clone the repository:**
   ```bash
   git clone [repository-url]
   ```
2. **Install dependencies:** 
   ```bash
   npm install
   ```
3. **Configure the Environment:**
   You must point the CLI to the unified Base44 workspace. Create a `.env.local`:
   ```env
   VITE_BASE44_APP_ID=695eb764b077190880be21de
   VITE_BASE44_APP_BASE_URL=https://my-to-do-list-81bfaad7.base44.app
   ```
4. **Boot the Client App:** 
   ```bash
   npm run dev
   ```

> **Important Node on Cloud Deployments:** Before deploying code to Base44 via the builder, ensure that `RENTCAST_API_KEY` and `BATCH_DATA_API_KEY` exist as secured environment variables inside the cloud workspace. The validation pipeline securely checks for these signatures prior to launching any financial sink.
