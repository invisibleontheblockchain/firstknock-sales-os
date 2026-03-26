/**
 * batch-test-harness.ts
 * Runs the 499-Route ground truth addresses through BatchData live API.
 *
 * Run:
 *   deno run --allow-env --allow-net --allow-read --allow-write test_batchdata/batch-test-harness.ts [path/to/addresses.txt]
 *
 * Required env vars (set in .env or shell):
 *   BATCH_DATA_SANDBOX_KEY  → for sandbox testing
 *   BATCH_DATA_API_KEY      → for live testing
 */

import { BatchDataClient } from "./batchdata-client.ts";

// ── Known "Soup" Assertions (ground truth from the field) ──
const ASSERTIONS = [
  {
    match: "Blair St",
    expectedSold: true,
    note: "505/507 Blair St — had For Sale signs. Should now be SOLD.",
  },
  {
    match: "117 Phillips",
    expectedSold: true,
    note: "117 Phillips St — sold July 2023, often mislabeled Active.",
  },
  {
    match: "115 Simmons",
    expectedSold: false,
    note: "115 Simmons St — boarded up, padlocked. Should be OFF_MARKET, not Sold.",
  },
];

// ── Load addresses from file ──
async function loadAddresses(filePath: string): Promise<string[]> {
  const text = await Deno.readTextFile(filePath);

  // Try JSON array first
  try {
    const json = JSON.parse(text);
    if (Array.isArray(json)) return json.filter(Boolean);
  } catch (_) { /* not JSON */ }

  // Fall back to line-by-line text (e.g. "1 - 505 Blair St, Anderson, SC 29626")
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^\d+\s*[-–]\s*(.+)$/);
      return match ? match[1].trim() : line;
    })
    .filter((l) => !l.startsWith("(Data truncates") && l.length > 5);
}

// ── Delay helper ──
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Main ──
const USE_SANDBOX = Deno.env.get("BATCH_DATA_SANDBOX_KEY") && !Deno.env.get("BATCH_DATA_API_KEY");
const client = new BatchDataClient(!!USE_SANDBOX);

const filePath =
  Deno.args[0] ||
  "../.gemini/antigravity/brain/0bbe67c5-d4cf-482a-9ffe-a5948bcfea94/propapis_ground_truth_route.txt";

console.log(`\n🔍  BatchData 499-Route Validation Test`);
console.log(`    Source file: ${filePath}`);
console.log(`    Mode: ${USE_SANDBOX ? "SANDBOX" : "LIVE"}\n`);

const addresses = await loadAddresses(filePath);
console.log(`    Loaded ${addresses.length} addresses.\n`);

const results: any[] = [];
let passed = 0, failed = 0, nullRecord = 0;

for (let i = 0; i < addresses.length; i++) {
  const addr = addresses[i];

  let result: any;
  try {
    result = await client.lookupProperty(addr);
  } catch (err: any) {
    if (err.message === "RATE_LIMITED_429") {
      console.warn(`   ⏳ Rate limited on #${i + 1}. Waiting 5s...`);
      await sleep(5000);
      try {
        result = await client.lookupProperty(addr);
      } catch {
        result = { address: addr, status: null, isSold: false, error: "RATE_LIMITED" };
      }
    } else {
      result = { address: addr, status: null, isSold: false, error: err.message };
    }
  }

  if (!result.status) nullRecord++;

  // Check assertions
  const assertion = ASSERTIONS.find((a) => addr.includes(a.match));
  let verdict = "PASS";
  let assertNote = "";

  if (assertion) {
    if (result.isSold !== assertion.expectedSold) {
      verdict = `❌ FAIL — Expected isSold=${assertion.expectedSold}, got isSold=${result.isSold} (status: ${result.status})`;
      failed++;
    } else {
      verdict = `✅ PASS — ${assertion.note}`;
      passed++;
    }
    assertNote = assertion.note;
    console.log(`   [#${i + 1}] ${addr}`);
    console.log(`          → ${verdict}\n`);
  }

  results.push({
    index: i + 1,
    address: addr,
    status: result.status,
    isSold: result.isSold,
    lastSaleDate: result.lastSaleDate,
    lastSalePrice: result.lastSalePrice,
    verdict: assertion ? verdict : "NOT_ASSERTED",
    assertNote,
    error: result.error || null,
  });

  // Throttle 200ms between calls to respect rate limits
  if (i < addresses.length - 1) await sleep(200);
}

// ── Summary ──
const totalSold = results.filter((r) => r.isSold).length;
const tpr = addresses.length > 0 ? ((totalSold / addresses.length) * 100).toFixed(1) : "0";

console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("  BATCHDATA VALIDATION TEST RESULTS");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(`  Total addresses tested:   ${addresses.length}`);
console.log(`  Identified as SOLD:       ${totalSold} (${tpr}%)`);
console.log(`  Null/missing records:     ${nullRecord}`);
console.log(`  Assertion checks passed:  ${passed}`);
console.log(`  Assertion checks FAILED:  ${failed}`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

// Write full results to disk
await Deno.writeTextFile(
  "./test_batchdata/batchdata-results.json",
  JSON.stringify(results, null, 2)
);
console.log("📄  Full results saved to: test_batchdata/batchdata-results.json\n");
