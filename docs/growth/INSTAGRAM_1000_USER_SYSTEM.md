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

### Before publishing

1. Create the content ID in the workbook's `Content Tracker`.
2. In `/GrowthDashboard`, generate the matching tracked `/instagram` link.
3. Choose one manager audience, one pain, one hook, one proof, and one CTA.
4. Put that exact link in the Story sticker, bio slot, or originating DM reply.
5. Record the publish date and hypothesis before seeing results.

### At a fixed snapshot age

Use the same age for comparisons, normally seven days. In Instagram Insights, record:

- reach
- views
- shares
- saves
- link clicks
- qualified DM intents

In `/GrowthDashboard`, use **Add Instagram snapshot** with the same campaign and content
ID. Re-entering the same content ID updates the cumulative snapshot rather than creating
a second row.

Instagram Insights uses a rolling reporting window, so enter snapshots weekly instead of
treating Instagram as the permanent historical database. See [Instagram Insights](https://www.facebook.com/help/instagram/788388387972460).

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

## Monday growth review

Every Monday:

1. Enter the previous week's fixed-age Instagram snapshots.
2. Open `/GrowthDashboard` and set the same reporting window used last week.
3. Read the funnel left to right and identify the largest absolute leak.
4. Export the content conversion CSV and update the operating workbook.
5. Review the `Weekly Scorecard` and `Lead Funnel`.
6. Make one decision for each repeated concept:

   - **Repeat:** it produced an activated workspace or reps with a first outcome.
   - **Iterate:** it had strong upstream signal but leaked at one clear stage.
   - **Hold/stop:** it produced neither a conversion nor a useful learning after enough
     repetitions.

Compare medians after at least three comparable executions. Do not call a winner from one
outlier post.

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
a time.
