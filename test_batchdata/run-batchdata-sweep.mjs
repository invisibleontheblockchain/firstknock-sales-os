#!/usr/bin/env node
/**
 * run-batchdata-sweep.mjs
 * Node.js ESM version of the BatchData 499-Route validation harness.
 * Reads route_addresses.txt, calls BatchData live API, writes batchdata-results.json
 *
 * Run: node test_batchdata/run-batchdata-sweep.mjs [path/to/addresses.txt]
 */

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────────────────────────
const API_KEY = process.env.BATCH_DATA_API_KEY;
const SANDBOX_KEY = process.env.BATCH_DATA_SANDBOX_KEY;
const USE_SANDBOX = !API_KEY && !!SANDBOX_KEY;
const KEY = USE_SANDBOX ? SANDBOX_KEY : API_KEY;

if (!KEY) {
  console.error("❌  Set BATCH_DATA_API_KEY (or BATCH_DATA_SANDBOX_KEY) in env.");
  process.exit(1);
}

const BASE_URL = "https://api.batchdata.com/api/v1";
const DELAY_MS = 300; // ms between calls — conservative for live key

// ── Known "Soup" Assertions (ground truth from the field) ───────────────────
const ASSERTIONS = [
  { match: "Blair St",      expectedSold: true,  note: "505/507 Blair St — had For Sale signs, should now be SOLD." },
  { match: "117 Phillips",  expectedSold: true,  note: "117 Phillips St — sold Jul 2023, often mislabeled Active." },
  { match: "115 Simmons",   expectedSold: false, note: "115 Simmons St — boarded up/padlocked. NOT sold, should be OFF_MARKET." },
];

// ── Helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadAddresses(filePath) {
  const text = readFileSync(filePath, "utf8");

  // Try JSON array first
  try {
    const json = JSON.parse(text);
    if (Array.isArray(json)) return json.filter(Boolean);
  } catch (_) { /* not JSON */ }

  // Line-by-line: strip numeric prefix like "1 - "
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^\d+\s*[-–]\s*(.+)$/);
      return m ? m[1].trim() : line;
    })
    .filter((l) => !l.startsWith("(Data truncates") && l.length > 5);
}

async function lookupProperty(address) {
  const body = { searchCriteria: { query: address } };

  const res = await fetch(`${BASE_URL}/property/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (res.status === 429) throw new Error("RATE_LIMITED_429");

  if (!res.ok) {
    const errText = await res.text().catch(() => "no body");
    throw new Error(`BatchData ${res.status}: ${errText.slice(0, 300)}`);
  }

  const json = await res.json();

  // Log raw JSON for first 4 addresses so we can calibrate field paths
  return json;
}

function parseResult(address, json) {
  const property =
    json?.results?.[0] ||
    json?.data?.[0] ||
    json?.properties?.[0] ||
    json?.property ||
    json?.[0] ||
    null;

  if (!property) {
    return { address, status: null, listingStatus: null, isSold: false, lastSaleDate: null, lastSalePrice: null, rawJson: json };
  }

  const rawStatus =
    property?.listingInfo?.status ||
    property?.mlsInfo?.listing_status ||
    property?.propertyInfo?.listingStatus ||
    property?.propertyInfo?.status ||
    property?.status ||
    null;

  const normalized = (rawStatus || "").toUpperCase();
  const isSold = ["SOLD", "CLOSED", "SETTLED"].includes(normalized);

  return {
    address,
    status: normalized || null,
    listingStatus: rawStatus,
    isSold,
    lastSaleDate:
      property?.lastSale?.saleDate ||
      property?.saleInfo?.lastSaleDate ||
      property?.saleDate ||
      null,
    lastSalePrice:
      property?.lastSale?.salePrice ||
      property?.saleInfo?.lastSaleAmount ||
      property?.salePrice ||
      null,
    rawFields: {
      // Surface all top-level keys of the property object so we can spot the right field paths
      keys: Object.keys(property),
    },
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────
const filePath = process.argv[2] || path.join(__dirname, "route_addresses.txt");

console.log(`\n🔍  BatchData Live Validation Sweep`);
console.log(`    Source: ${filePath}`);
console.log(`    Mode:   ${USE_SANDBOX ? "SANDBOX" : "LIVE"}\n`);

const addresses = loadAddresses(filePath);
console.log(`    Loaded ${addresses.length} addresses.\n`);

const results = [];
let passed = 0, failed = 0, nullCount = 0;

for (let i = 0; i < addresses.length; i++) {
  const addr = addresses[i];
  let result;

  try {
    const raw = await lookupProperty(addr);
    result = parseResult(addr, raw);

    // Print raw JSON for first 4 to calibrate field paths
    if (i < 4) {
      console.log(`\n--- FULL RAW RESPONSE #${i + 1}: ${addr} ---`);
      console.log(JSON.stringify(raw, null, 2).slice(0, 1500));
      console.log("---\n");
    }
  } catch (err) {
    if (err.message === "RATE_LIMITED_429") {
      console.warn(`   ⏳  Rate limited on #${i + 1}. Waiting 10s...`);
      await sleep(10000);
      try {
        const raw = await lookupProperty(addr);
        result = parseResult(addr, raw);
      } catch (e2) {
        result = { address: addr, status: null, isSold: false, error: e2.message };
      }
    } else {
      result = { address: addr, status: null, isSold: false, error: err.message };
    }
  }

  if (!result.status) nullCount++;

  // Check assertions
  const assertion = ASSERTIONS.find((a) => addr.includes(a.match));
  let verdict = "NOT_ASSERTED";
  let assertNote = "";

  if (assertion) {
    if (result.isSold !== assertion.expectedSold) {
      verdict = `❌ FAIL — Expected isSold=${assertion.expectedSold}, got isSold=${result.isSold} (status: ${result.status})`;
      failed++;
    } else {
      verdict = `✅ PASS`;
      passed++;
    }
    assertNote = assertion.note;
    console.log(`[#${i + 1}] ${addr}`);
    console.log(`       Status: ${result.status ?? "null"} | isSold: ${result.isSold}`);
    console.log(`       ${verdict}`);
    console.log(`       Note: ${assertNote}\n`);
  } else {
    process.stdout.write(`[#${i + 1}] ${addr} → ${result.status ?? "NULL"}\n`);
  }

  results.push({
    index: i + 1,
    address: addr,
    status: result.status,
    isSold: result.isSold,
    lastSaleDate: result.lastSaleDate,
    lastSalePrice: result.lastSalePrice,
    verdict,
    assertNote,
    error: result.error || null,
    rawFields: result.rawFields || null,
  });

  if (i < addresses.length - 1) await sleep(DELAY_MS);
}

// ── Summary ──────────────────────────────────────────────────────────────────
const totalSold = results.filter((r) => r.isSold).length;
const tpr = addresses.length > 0 ? ((totalSold / addresses.length) * 100).toFixed(1) : "0";

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("  BATCHDATA VALIDATION RESULTS");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(`  Total addresses tested:   ${addresses.length}`);
console.log(`  Identified as SOLD:       ${totalSold} (${tpr}%)`);
console.log(`  Null/missing records:     ${nullCount}`);
console.log(`  Assertion checks passed:  ${passed}`);
console.log(`  Assertion checks FAILED:  ${failed}`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

const outPath = path.join(__dirname, "batchdata-results.json");
writeFileSync(outPath, JSON.stringify(results, null, 2), "utf8");
console.log(`📄  Full results → test_batchdata/batchdata-results.json\n`);
