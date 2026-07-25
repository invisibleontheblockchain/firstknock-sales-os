import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const readSource = (relativePath) => fs.readFileSync(path.resolve(relativePath), 'utf8');

test('a knock outcome tap acknowledges immediately instead of reading as a dead click', () => {
  const sheet = readSource('src/components/rep/PropertyDetailSheet.jsx');

  // The tapped decision, not the whole grid, carries the pending state.
  assert.match(sheet, /const \[savingStatus, setSavingStatus\] = useState\(null\)/);
  assert.match(sheet, /const isSavingOutcome = savingStatus !== null/);
  assert.match(sheet, /setSavingStatus\(status\)/);
  assert.match(sheet, /setSavingStatus\(null\)/);

  // Pending feedback is visible (spinner) and announced (aria-busy).
  assert.match(sheet, /const isPending = savingStatus === opt\.id/);
  assert.match(sheet, /aria-busy=\{isPending\}/);
  assert.match(sheet, /isPending\s*\n?\s*\?\s*<Loader2/);
});

test('a device fix is warmed ahead of the tap and never blocks the outcome write', () => {
  const repHome = readSource('src/pages/RepHome.jsx');

  // Warmed while the rep reads the house card, so the tap reuses a cached fix.
  assert.match(repHome, /const warmGpsFix = React\.useCallback/);
  assert.match(repHome, /if \(!selectedPropertyHash\) return;\s*\n\s*warmGpsFix\(\);/);

  // A cached fix short-circuits, and a cold radio falls back fast.
  assert.match(repHome, /Date\.now\(\) - cached\.capturedAt < GPS_FIX_MAX_AGE_MS/);
  assert.match(repHome, /setTimeout\(\(\) => finish\(fallback\), GPS_FIX_WAIT_MS\)/);
  assert.match(repHome, /const gpsProof = await resolveGpsProof\(prop\);/);

  // The old blocking five-second high-accuracy wait is gone.
  assert.doesNotMatch(repHome, /timeout: 5000, maximumAge: 0/);
});

test('an outcome tap marks the door and closes the sheet without waiting on the write', () => {
  const repHome = readSource('src/pages/RepHome.jsx');

  // The row lands and the sheet closes before the write is enqueued.
  assert.match(repHome, /applyOptimisticLog\(\{/);
  assert.match(repHome, /applyOptimisticLog\(\{[\s\S]*?\}\);\s*\n\s*setSelectedProperty\(null\);/);
  assert.match(repHome, /return true;/);
  // The old blocking round-trip is gone from the tap path.
  assert.doesNotMatch(repHome, /await createLogMutation\.mutateAsync\(\{\s*\n\s*\.\.\.enrichedLogData,\s*\n\s*\.\.\.gpsProof,\s*\n\s*route_id:/);

  // Writes are serialized: the server takes a per-user lease per outcome.
  assert.match(repHome, /outcomeQueueRef\.current = outcomeQueueRef\.current/);

  // A failed write removes only its own row, not later ones.
  assert.match(repHome, /dropOptimisticLog\(newLog\?\.optimistic_id, newLog\?\.address_hash\)/);
  assert.match(repHome, /old\.filter\(\(log\) => log\?\.id !== optimisticId\)/);
});

test('an unsettled outcome survives a refetch triggered by an earlier write', () => {
  const repHome = readSource('src/pages/RepHome.jsx');

  assert.match(repHome, /pendingOutcomesRef\.current\.set\(entry\.id, entry\)/);
  // Both log queries re-apply anything still in flight.
  assert.match(repHome, /return withPendingOutcomes\(merged\.filter/);
  assert.match(repHome, /withPendingOutcomes\(\s*\n?\s*Array\.isArray\(res\) \? res : res\?\.items \|\| \[\],\s*\n?\s*selectedProperty\.address_hash/);
});

// A door that reverted to Todo a moment after being marked done was this:
// the optimistic row was retired when the write finished, so the refetch that
// followed — not yet showing the new row — won the race.
for (const [label, file] of [['knock tab', 'src/pages/RepHome.jsx'], ['checklist', 'src/pages/Home.jsx']]) {
  test(`${label}: an optimistic row is retired only once its real row is visible`, () => {
    const source = readSource(file);

    // Retirement is driven by observing the server row, not by write completion.
    assert.match(source, /collectUnretiredOutcomes\(pendingOutcomesRef\.current, rows, addressHash\)/);
    assert.match(source, /from '@\/components\/logic\/optimisticOutcomes'/);

    // The success handler swaps in the authoritative row from the response, so
    // the stop does not depend on the list query returning it.
    assert.match(source, /confirmOutcomeRow\(\s*\n?\s*pendingOutcomesRef\.current,\s*\n?\s*logData\?\.optimistic_id,\s*\n?\s*result\?\.interaction\s*\n?\s*\)/);
    assert.match(source, /if \(confirmed\) replaceOptimisticLog\(logData\?\.optimistic_id, confirmed\)/);

    // Nothing outside the retirement helper may drop a pending row on success.
    assert.doesNotMatch(source, /else pendingOutcomesRef\.current\.delete/);
    assert.doesNotMatch(source, /onSettled: \([^)]*\) => \{\s*\n\s*\/\/[^\n]*\n\s*pendingOutcomesRef\.current\.delete/);

    // A failed write must leave a breadcrumb, since the visible symptom is
    // identical to the race this file pins.
    assert.match(source, /console\.error\('\[(RepHome|Home)\] Outcome write failed/);
  });
}

test('the checklist logs outcomes optimistically on the same terms as the knock tab', () => {
  const home = readSource('src/pages/Home.jsx');

  // Marked and returned on the tap, not after the round-trip.
  assert.match(home, /applyOptimisticLog\(\{[\s\S]*?\}\);\s*\n\s*\n?\s*\/\/[\s\S]*?outcomeQueueRef\.current = outcomeQueueRef\.current/);
  assert.doesNotMatch(home, /await createLogMutation\.mutateAsync\(\{\s*\n\s*\.\.\.logData,/);
  // The blocking single-flight guard is gone; the queue replaces it.
  assert.doesNotMatch(home, /managerOutcomeInFlightRef/);

  // Same rollback and refetch-survival contract as the knock tab.
  assert.match(home, /dropOptimisticLog\(logData\?\.optimistic_id, logData\?\.address_hash\)/);
  assert.match(home, /pendingOutcomesRef\.current\.set\(entry\.id, entry\)/);
  assert.match(home, /return withPendingOutcomes\(Array\.isArray\(res\) \? res : \(res\?\.items \|\| \[\]\)\)/);
});

test('an optimistic checklist row carries created_by so the org filter keeps it', () => {
  const home = readSource('src/pages/Home.jsx');

  // logs drops any row whose created_by is outside the org, which would
  // silently discard the optimistic row and leave the stop looking untouched.
  assert.match(home, /validEmails\.has\(l\.created_by\.toLowerCase\(\)\)/);
  assert.match(home, /created_by: user\?\.email \|\| null/);
});

test('property history collapses behind a dropdown so the outcome grid stays reachable', () => {
  const sheet = readSource('src/components/rep/PropertyDetailSheet.jsx');

  assert.match(sheet, /const \[showHistory, setShowHistory\] = useState\(false\)/);
  assert.match(sheet, /aria-expanded=\{showHistory\}/);
  assert.match(sheet, /aria-controls="property-history-panel"/);
  assert.match(sheet, /id="property-history-panel"/);
  // Expanded history is capped and scrolls inside itself.
  assert.match(sheet, /max-h-\[45vh\] overflow-y-auto/);
});
