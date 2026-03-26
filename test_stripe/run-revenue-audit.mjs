#!/usr/bin/env node
/**
 * run-revenue-audit.mjs
 * Node.js ESM version of Stripe Revenue Audit
 * Sweeps all Stripe customers created >=7 days ago and categorizes their
 * subscription state to identify revenue left on the table.
 *
 * Run: node test_stripe/run-revenue-audit.mjs
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY  (live key)
 *   -- OR --
 *   STRIPE_TEST_SECRET_KEY  (test key, set USE_TEST_MODE=true)
 */
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const USE_TEST_MODE = process.env.USE_TEST_MODE === "true";
const STRIPE_KEY = USE_TEST_MODE
  ? process.env.STRIPE_TEST_SECRET_KEY
  : process.env.STRIPE_SECRET_KEY;

if (!STRIPE_KEY) {
  console.error("❌  No Stripe key found.");
  console.error("    Please set STRIPE_SECRET_KEY or (STRIPE_TEST_SECRET_KEY and USE_TEST_MODE=true).");
  process.exit(1);
}

const STRIPE_BASE = "https://api.stripe.com/v1";
const HEADERS = {
  Authorization: `Bearer ${STRIPE_KEY}`,
  "Content-Type": "application/x-www-form-urlencoded",
};

// --- Stripe helpers ---
async function stripeGet(pathStr, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${STRIPE_BASE}${pathStr}${qs ? "?" + qs : ""}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Stripe GET ${pathStr} failed: ${err.slice(0, 300)}`);
  }
  return res.json();
}

async function getAllCustomers() {
  const all = [];
  let startingAfter;

  while (true) {
    const params = { limit: "100" };
    if (startingAfter) params.starting_after = startingAfter;
    const page = await stripeGet("/customers", params);
    all.push(...page.data);
    if (!page.has_more) break;
    startingAfter = page.data[page.data.length - 1].id;
  }

  return all;
}

async function getSubscriptionsForCustomer(customerId) {
  const data = await stripeGet("/subscriptions", {
    customer: customerId,
    limit: "10",
    status: "all",
  });
  return data.data || [];
}

// --- Main Audit ---
async function main() {
  const NOW_SECS = Math.floor(Date.now() / 1000);
  const EIGHT_DAYS_AGO = NOW_SECS - 8 * 24 * 60 * 60; // >7 days to catch the 9-day cards

  console.log(`\n🔍  Starting Stripe Revenue Audit (${USE_TEST_MODE ? "TEST MODE" : "LIVE MODE"})\n`);

  const allCustomers = await getAllCustomers();
  console.log(`   Found ${allCustomers.length} total customers.`);

  // Filter to customers created >=7 days ago 
  const oldCustomers = allCustomers.filter((c) => c.created <= EIGHT_DAYS_AGO);
  console.log(`   ${oldCustomers.length} customers created 7+ days ago — auditing...\n`);

  const report = {
    active: [],
    trialing: [],
    past_due: [],
    canceled: [],
    no_subscription: [], // Card on file but ZERO subscription
    summary: {},
  };

  for (const customer of oldCustomers) {
    const subs = await getSubscriptionsForCustomer(customer.id);

    if (subs.length === 0) {
      // Card may be on file via SetupIntent but no subscription was ever created
      const hasSavedCard =
        (customer.invoice_settings?.default_payment_method ||
          customer.default_source) != null;

      report.no_subscription.push({
        id: customer.id,
        email: customer.email,
        name: customer.name,
        created: customer.created ? new Date(customer.created * 1000).toISOString() : null,
        has_saved_card: hasSavedCard,
      });
    } else {
      for (const sub of subs) {
        const entry = {
          customer_id: customer.id,
          email: customer.email,
          subscription_id: sub.id,
          status: sub.status,
          trial_end: sub.trial_end
            ? new Date(sub.trial_end * 1000).toISOString()
            : null,
          current_period_end: sub.current_period_end 
            ? new Date(sub.current_period_end * 1000).toISOString()
            : null,
          plan_amount: sub.items?.data?.[0]?.price?.unit_amount,
          plan_interval: sub.items?.data?.[0]?.price?.recurring?.interval,
        };

        if (sub.status === "active") report.active.push(entry);
        else if (sub.status === "trialing") report.trialing.push(entry);
        else if (sub.status === "past_due") report.past_due.push(entry);
        else if (sub.status === "canceled") report.canceled.push(entry);
        else report.no_subscription.push({ ...entry, note: `Unexpected status: ${sub.status}` });
      }
    }
  }

  report.summary = {
    active: report.active.length,
    trialing: report.trialing.length,
    past_due: report.past_due.length,
    canceled: report.canceled.length,
    no_subscription_card_on_file: report.no_subscription.filter((c) => c.has_saved_card).length,
    no_subscription_no_card: report.no_subscription.filter((c) => !c.has_saved_card).length,
  };

  // --- Print Summary ---
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  STRIPE REVENUE AUDIT RESULTS");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  ✅  Active (paying now):            ${report.summary.active}`);
  console.log(`  ⏳  Trialing (not yet charged):     ${report.summary.trialing}`);
  console.log(`  ⚠️  Past Due (card declined):       ${report.summary.past_due}`);
  console.log(`  ❌  Canceled:                        ${report.summary.canceled}`);
  console.log(`  💳  Card on file, NO subscription:  ${report.summary.no_subscription_card_on_file}`);
  console.log(`  👻  No card, no subscription:        ${report.summary.no_subscription_no_card}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  if (report.past_due.length > 0) {
    console.log("⚠️  PAST DUE ACCOUNTS (Card Declined — Stripe is retrying automatically):");
    report.past_due.forEach((s) => console.log(`   - ${s.email} | Sub: ${s.subscription_id}`));
    console.log("");
  }

  if (report.no_subscription.filter(c => c.has_saved_card).length > 0) {
    console.log("💳  CARD ON FILE WITH NO SUBSCRIPTION (Revenue left on table!):");
    report.no_subscription.filter(c => c.has_saved_card).forEach((c) =>
      console.log(`   - ${c.email} | Customer: ${c.id} | Created: ${c.created}`)
    );
    console.log("");
  }

  // Write full report to disk
  const outPath = path.join(__dirname, "audit_report.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`📄  Full report saved to: test_stripe/audit_report.json\n`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
