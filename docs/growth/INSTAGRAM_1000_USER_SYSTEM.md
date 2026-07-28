# FirstKnock Instagram to 1,000 Users System

## Goal and north star

Reach **1,000 retained active users in a rolling 30-day window**.

The acquisition unit is a manager workspace. Instagram acquires a manager, then that
manager's team invitations multiply one acquired workspace into several active users.

A retained active user is:

- a manager with verified product activity in the last 30 days, such as creating or
  updating a route or deploying/completing a Canvas campaign; or
- a rep with a real door outcome in the last 30 days.

This is stricter than registrations. The goal card must not increase because somebody
created an account and never used the product.

## The measurable path

```text
Instagram reach
  -> landing session
  -> signup CTA session
  -> manager signup
  -> activated workspace
  -> active rep roster
  -> joined reps
  -> reps with a first outcome
  -> retained active users (30 days)
  -> first paid conversion
```

Definitions:

- **Reach:** unique Instagram accounts that saw an asset.
- **Landing session:** a deduplicated pseudonymous session that loaded `/instagram`.
- **Signup CTA session:** a deduplicated session that clicked the primary signup CTA.
- **Manager signup:** an attributed account that successfully created a manager workspace.
- **Activated workspace:** a manager with a verified owned nonempty route or a deployed or
  completed Canvas campaign.
- **Active rep roster:** unique active rep seats under the manager, deduplicated by
  manager and normalized email. This is a roster proxy, not proof an invitation was sent.
- **Joined rep:** an active roster seat linked to exactly one matching rep account by user
  ID, manager, and email.
- **Activated rep:** a joined rep who logs a real first outcome.
- **Retained active user:** a verified active manager or rep in the rolling 30-day window.
- **First paid conversion:** the first verified positive Stripe payment for a workspace.

Use reach, not views, as the upstream rate denominator. Views can include repeat plays;
reach represents unique accounts. See [Instagram Insights](https://www.facebook.com/help/instagram/788388387972460).

## Base-case planning model

These are planning hypotheses, not platform benchmarks. Replace them with observed
FirstKnock medians after 30 to 50 assets.

| Step | Assumption | Planning result |
|---|---:|---:|
| Instagram reach | - | 476,667 |
| Owned intent / reach | 0.6% | 2,860 |
| Manager signup / intent | 25% | 715 |
| Workspace activation / signup | 35% | 250 |
| Activated users / workspace | 5 | 1,250 gross |
| 30-day quality buffer | 20% | 1,000 retained |

Over 50 operating weeks, the initial targets are:

- 9,533 accounts reached per week
- 5 activated workspaces per week
- 20 retained active users added per week
- 5 feed assets per week

Treat this as a forecast to update, not a promise. The workbook recalculates the required
reach and content volume from actual conversion rates.

The in-product **Path to 1,000** control mirrors this as a rolling 50-week planning
scenario. Its goal progress uses the all-channel rolling-30-day retained-active stock.
Its observed Instagram rows use only canonical, mature `1000-users` assets backed by the
published content plan; unplanned assets, other campaigns, and `ig-release-smoke` are
excluded.

After a complete observation window, the weekly observed values are the plan-backed
last-28-day totals divided by four:

- mature Instagram reach whose authoritative fixed-age checkpoint became due in the
  window;
- canonical content assets whose fixed-age checkpoint became due in the window;
- activated manager workspaces whose accounts were created in the window; and
- Instagram-attributed users created in the window who currently satisfy the rolling
  retained-active rule.

That last value is a **gross signup-cohort contribution**, not net growth in the
rolling-active stock. Older users can leave the stock while new users enter it, so the
dashboard does not turn this proxy into an arrival date. A trustworthy ETA requires a
persisted weekly history of the all-channel retained-active stock.

The planning assumptions stay authoritative while the observed sample matures. The card
shows raw partial totals first, then unlocks weekly comparisons only after 28 days of
canonical checkpoint history. It also shows progress toward 30 canonical plan-backed
assets before it calls the observed funnel sample mature. A corrected old snapshot keeps
its original plan-derived checkpoint date and cannot re-enter the current pace window.
Even after the sample matures, observed throughput remains descriptive; the baseline is
not silently replaced by a fragile early conversion rate.

## Attribution contract

Every Instagram asset gets one lowercase content ID:

```text
ig-YYYYMMDD-NN
```

Example canonical link:

```text
https://firstknock.online/instagram?utm_source=instagram&utm_medium=organic_social&utm_campaign=1000-users&utm_content=ig-20260803-01
```

Rules:

1. Keep `utm_source=instagram` and `utm_medium=organic_social` exact and lowercase.
2. Use one stable campaign name for the initiative.
3. Give every creative a unique `utm_content`.
4. Use `ig-bio` for the persistent bio link.
5. Use the originating asset's content ID in Story links and DM replies.
6. Do not reuse an old content ID for a new hook.

Google recommends consistent campaign parameters and `utm_content` for distinguishing
creatives. UTM values are case-sensitive. See [Google campaign URL guidance](https://support.google.com/analytics/answer/10917952).

FirstKnock preserves:

- immutable first touch, which credits the creative that acquired the account;
- mutable last touch, which shows the latest tracked visit before conversion; and
- manager-level attribution for trusted active roster members in that manager's workspace.

Do not claim organic view-through attribution. If someone watches a Reel and later types
the domain directly, recover influence only through self-report.

## Per-asset operating procedure

### Load the sprint once

1. Open `/GrowthDashboard` as an owner or admin.
2. In the growth action queue, select **Load 30-day sprint**.
3. Confirm all 20 planned content IDs appear before publishing the first asset.

Loading the sprint creates the operating queue; it does not publish an asset or create
reach. Re-running it is safe: the same campaign and content ID are updated rather than
duplicated, while publish and review history is preserved. Once an asset is published,
its brief, comparison group, and checkpoint age are frozen as historical experiment
evidence. Use **Sync 30-day sprint** to repair a partial load without rewriting published
work.

### Before publishing

1. Open **Next Publish** in the `/GrowthDashboard` growth action queue.
2. Review the planned audience, hook, brief, hypothesis, CTA, and comparison group.
3. Copy the queue's matching tracked `/instagram` link.
4. Put that exact link in the Story sticker, bio slot, or originating DM reply.
5. Publish the asset, then select **Mark published** so every checkpoint is calculated
   from the real publish time.

### At fixed snapshot ages

Capture the canonical cumulative Instagram Insights snapshot seven days after the
recorded publish time. The queue identifies the next scheduled, due, or overdue
seven-day checkpoint. Optional 1-day and 3-day reads provide an early signal, and an
optional 30-day follow-up supports the retention review. At each captured age, record:

- reach
- views
- shares
- saves
- link clicks
- qualified DM intents

Use **Add Instagram snapshot** from the queue so the campaign, content ID, and snapshot
age are locked to the planned asset. A 1-day or 3-day read is an early signal only: it
never clears the canonical 7-day checkpoint. The manual snapshot form can also record a
30-day follow-up. Each fixed age remains a separate checkpoint; re-entering the same
campaign, content ID, and age updates only that checkpoint.

The headline reach and content-conversion table use only a mature canonical checkpoint.
An early read stays visible in the queue but cannot inflate official reach, measured-asset
counts, or a decision. After an early checkpoint is saved, the queue advances to the next
missing eligible read rather than repeatedly overwriting it.

Instagram Insights uses a rolling reporting window, so capture each due checkpoint on
schedule instead of treating Instagram as the permanent historical database. See
[Instagram Insights](https://www.facebook.com/help/instagram/788388387972460).

### Make an evidence-bound decision

When the queue moves an asset to **Decision Due**, read the fixed-age snapshot beside its
joined product-conversion evidence. Enter a specific learning note, then choose:

- **Repeat:** preserve the concept because it produced meaningful product outcomes or
  clearly won its comparable group.
- **Iterate:** keep the concept but change one named major variable at the next execution.
- **Hold:** stop allocating a slot for now.

The decision is bound to the Instagram checkpoint used for the review. If that checkpoint
changes, the queue marks the decision stale and requires a new note and decision. Product
conversion counters remain live, so revisit them during the weekly and optional 30-day
reviews. **Hold** remains
locked until at least three completed assets in the same comparison group have comparable
fixed-age snapshots from the same campaign and checkpoint age. Early reads and a single
outlier are never sufficient evidence to hold a concept.

### Product outcomes

The dashboard joins that snapshot to:

- anonymous landing and CTA sessions;
- manager signups;
- all acquired users, including active linked reps rolled up to the acquiring manager;
- activated workspaces and activated users;
- current active roster, joined-rep, and first-outcome counts;
- retained active users; and
- first paid conversions.

Export the content conversion CSV after the Monday snapshot update. The join key is the
campaign plus content ID, so spelling consistency is part of the measurement system.

## Daily operating cadence

Each publishing day:

1. Open the growth action queue.
2. Publish the exact **Next Publish** asset and mark its real publish time.
3. Capture any **Snapshot checkpoint** that is due or overdue.
4. Resolve **Decision Due** items with a note and one Repeat/Iterate/Hold decision.
5. Copy the tracked link from the queue for every Story sticker or manual DM reply.

Do not wait for Monday to capture a checkpoint that is due today.

## Weekly growth review

Every Monday:

1. Clear every due or overdue seven-day Instagram checkpoint.
2. Open `/GrowthDashboard` and read **Path to 1,000**.
3. Compare observed reach, mature assets, activated workspaces, and gross retained-cohort
   contribution per week with the required 50-week planning pace.
4. Read the funnel left to right and identify the earliest material constraint.
5. Export the content conversion CSV and update the operating workbook.
6. Review the `Weekly Scorecard` and `Lead Funnel`.
7. Resolve every **Decision Due** item with its evidence-bound note.
8. Compare fixed-age medians within format and comparison group after at least three
   comparable executions.
9. Assign the next sprint slots to Repeat concepts and one-variable Iterations; leave
   Hold concepts out until new evidence justifies revisiting them.

Use the optional 30-day snapshot to revisit the seven-day decision against retained-user
evidence. The operating decision stays bound to its seven-day evidence; if that canonical
checkpoint is corrected, the queue marks the decision stale and requires a fresh note.

## Diagnose the leak

| Pattern | Likely constraint | Next experiment |
|---|---|---|
| Low reach or watch quality | Hook/distribution | Change the first two seconds, collaboration, or proof format |
| Good reach, low landing rate | CTA/channel handoff | Make the next step concrete and use the tracked link everywhere |
| Good landing, low CTA rate | Landing promise/proof | Tighten the manager pain, outcome, and product proof |
| Good CTA, low manager signup | Auth/onboarding friction | Observe the exact sign-in and role-selection failure |
| Good signup, low activation | Time to first value | Help the manager create the first real route immediately |
| Good workspace activation, few users | Invitation loop | Make inviting and activating reps the next product action |
| Good active-user growth, low paid | Packaging/trust | Inspect pricing continuity, trial rules, and checkout evidence |

Scale concepts that create activated workspaces and retained users, not merely likes.

## Metric trust and privacy boundaries

- Reach, views, shares, saves, clicks, and DM intent are owner-entered Instagram snapshots.
- Landing and CTA counts are pseudonymous diagnostic telemetry. They can guide conversion
  work but are not billing, authorization, or security evidence.
- Role assignment, invite redemption, activation, and payment milestones are written only
  by trusted backend paths or derived from trusted product records.
- Anonymous and session identifiers are hashed before storage. Reports expose no names,
  emails, invite codes, IP addresses, or raw query strings.
- First touch and first paid conversion are immutable. Later visits or renewals must not
  rewrite historical acquisition credit.
- The 7- and 28-day team multiplier is a cohort view: it shows current roster, join, and
  activation state for managers whose accounts were created in that window. It does not
  claim those team actions occurred during the window.
- Accounts acquired before tracking launched cannot be retroactively click-attributed
  unless the user supplies a self-reported source.

## Launch and smoke-test checklist

Release through the existing Base44-connected GitHub flow from the latest `main` branch.
Do not publish an old checkout wholesale.

1. Open a PR that contains only the acquisition changes and preserves newer production
   routing behavior.
2. Run `npm test`, `npm run typecheck`, `npm run build`,
   `npm run validate:backend`, and `npm run validate:artifact`.
3. Merge only after checks pass and confirm Base44 received the new `main` commit.
4. In the existing Base44 app, verify the new entities and functions, then publish once.
5. Signed out, open:

   ```text
   /instagram?utm_source=instagram&utm_medium=organic_social&utm_campaign=1000-users&utm_content=ig-release-smoke
   ```

6. Confirm the public landing page renders, CTA returns through authentication, a manager
   workspace can be created, and `ig-release-smoke` appears in the owner dashboard.
7. Add a small Instagram snapshot for the smoke-test content ID, verify the funnel row,
   then exclude that ID from operating decisions.

## First content sprint

Start with:

1. Cost of overlapping canvassers
2. Territory to assigned route in 30 seconds
3. Five signs routing is costing the team sales
4. Manager map versus rep map
5. Route Rescue #1

The executable 20-asset queue is in
[`INSTAGRAM_FIRST_30_DAYS_CONTENT.md`](./INSTAGRAM_FIRST_30_DAYS_CONTENT.md). It tests
proof-first openings, keyword CTA versus Story link, route-rescue proof, Reel length,
role-specific product proof, and the manager-to-team loop. Change one major variable at
a time. Load it with **Load 30-day sprint** in `/GrowthDashboard`; use the document as
the creative brief and the in-product queue as the operating record.
