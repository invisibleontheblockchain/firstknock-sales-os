import { assertPilotMembership } from './coreDrivingPilot.js';
import { routePropertyOrderFingerprint } from './routeFingerprint.js';

const id = p => String(p.address_hash || p.id);
const inputFingerprint = stops => routePropertyOrderFingerprint(stops.map(p => JSON.stringify([
    id(p), p.lat, p.lng, p.street_name, p.routing_access?.point, p.routing_access?.roadName, p.routing_access?.resolution_status])));
const total = legs => legs.reduce((sum, leg) => ({ driveSeconds: sum.driveSeconds + leg.driveSeconds,
    distanceMiles: sum.distanceMiles + leg.distanceMiles }), { driveSeconds: 0, distanceMiles: 0 });
const fatal = error => { if (error?.name === 'AbortError' || /membership|graph identity|cancelled/i.test(error?.message || '')) throw error; };
const outage = error => /failed \(5|timed out|fetch failed|failed to fetch/i.test(error?.message || '');

/** Run the production street/access splitter within valid runs, never across
 * uncertain pins. Two fixed stops at either end preserve approach/departure
 * context. Those four stops remain in the one customer route, not extra visits.
 */
export function planGuardedDrivingWindows(legacyOrder, { unresolvedIds = [], maxWindowStops = 500, partitionRun }) {
    assertPilotMembership(legacyOrder, legacyOrder);
    if (!Number.isInteger(maxWindowStops) || maxWindowStops < 6 || maxWindowStops > 500 || typeof partitionRun !== 'function') {
        throw new Error('Driving windows need the production boundary splitter and a 6–500 stop limit.');
    }
    const uncertain = new Set(unresolvedIds), windows = [];
    const uncertainIndexes = legacyOrder.flatMap((p, i) => uncertain.has(id(p)) ? [i] : []);
    let start = 0;
    for (const boundary of [...uncertainIndexes, legacyOrder.length]) {
        const run = legacyOrder.slice(start, boundary);
        if (run.length) {
            const groups = partitionRun(run, maxWindowStops);
            assertPilotMembership(run, groups.flat());
            if (groups.flat().map(id).join('|') !== run.map(id).join('|')) throw new Error('Window partition changed legacy order.');
            let offset = start;
            for (const group of groups) {
                if (!group.length || group.length > maxWindowStops) throw new Error('Window exceeded its provider limit.');
                if (group.length >= 6) windows.push({ id: `window-${windows.length + 1}`, start: offset, end: offset + group.length,
                    mutableStart: offset + 2, mutableEnd: offset + group.length - 2,
                    sourceOrder: group.map(id) });
                offset += group.length;
            }
        }
        start = boundary + 1;
    }
    return { version: 1, routeFingerprint: routePropertyOrderFingerprint(legacyOrder), inputFingerprint: inputFingerprint(legacyOrder), maxWindowStops,
        uncertainIndexes, uncertainIds: uncertainIndexes.map(i => id(legacyOrder[i])), windows };
}

function validateLegs(legs, sequence) {
    if (!Array.isArray(legs) || legs.length !== sequence.length - 1 || legs.some((leg, i) =>
        leg.from !== id(sequence[i]) || leg.to !== id(sequence[i + 1]) || !Number.isFinite(leg.driveSeconds)
        || !Number.isFinite(leg.distanceMiles) || leg.driveSeconds < 0 || leg.distanceMiles < 0 || !leg.pathKey)) {
        throw new Error('Incomplete validated directed consecutive legs.');
    }
}
const compactLeg = leg => ({ ...leg, pathKey: routePropertyOrderFingerprint([leg.pathKey]) });
const snapshot = route => ({ driveSeconds: route.driveSeconds, distanceMiles: route.distanceMiles,
    directedLegs: route.directedLegs.map(compactLeg), dataVersion: route.dataVersion || null });
const sameContextLeg = (a, b) => a.from === b.from && a.to === b.to && a.driveSeconds === b.driveSeconds
    && a.distanceMiles === b.distanceMiles && a.pathKey === b.pathKey;

export async function evaluateDrivingWindow(legacyOrder, window, { createContext, propose, signal }) {
    if (signal?.aborted) throw signal.reason || new DOMException('Cancelled', 'AbortError');
    const source = legacyOrder.slice(window.start, window.end);
    const retained = (reason, error = null) => ({ id: window.id, start: window.start, end: window.end,
        mutableStart: window.mutableStart, mutableEnd: window.mutableEnd, selection: 'legacy_fallback',
        eligible: false, reason, error, selectedIds: source.map(id), baseline: null, candidate: null, selected: null });
    let context, baseline;
    try {
        context = await createContext(source);
        baseline = await context.routeSequence(source);
        validateLegs(baseline.directedLegs, source);
    } catch (error) { fatal(error); return retained(outage(error) ? 'ROAD_PROVIDER_UNAVAILABLE' : 'ROAD_EVIDENCE_UNAVAILABLE', error.message); }
    let proposal = null, candidate = null, candidateError = null;
    try {
        proposal = [source[0], source[1], ...await propose(source.slice(2, -2), context,
            { startLocation: source[1], endLocation: source.at(-2) }), source.at(-2), source.at(-1)];
    } catch (error) { fatal(error); candidateError = error.message; }
    if (proposal) assertPilotMembership(source, proposal);
    if (proposal) try {
        candidate = proposal.map(id).join('|') === source.map(id).join('|') ? baseline : await context.routeSequence(proposal);
        validateLegs(candidate.directedLegs, proposal);
    } catch (error) { fatal(error); candidate = null; candidateError = error.message; }
    const ownedBaseline = total(baseline.directedLegs.slice(1, -1));
    const ownedCandidate = candidate ? total(candidate.directedLegs.slice(1, -1)) : null;
    const contextUnchanged = candidate && [0, baseline.directedLegs.length - 1].every(i =>
        sameContextLeg(compactLeg(baseline.directedLegs[i]), compactLeg(candidate.directedLegs[i])));
    // Score both real connectors; protect the surrounding unchanged legs too.
    const accept = contextUnchanged && ownedCandidate.driveSeconds < ownedBaseline.driveSeconds
        && ownedCandidate.distanceMiles <= ownedBaseline.distanceMiles
        && candidate.driveSeconds < baseline.driveSeconds && candidate.distanceMiles <= baseline.distanceMiles;
    return { id: window.id, start: window.start, end: window.end,
        mutableStart: window.mutableStart, mutableEnd: window.mutableEnd,
        eligible: true, selection: accept ? 'road_aware' : 'legacy_guard',
        reason: accept ? null : !candidate ? 'PROPOSAL_UNAVAILABLE' : !contextUnchanged ? 'BOUNDARY_CONTEXT_CHANGED' : 'PROPOSAL_NOT_BETTER',
        error: candidateError, selectedIds: (accept ? proposal : source).map(id),
        baseline: snapshot(baseline), candidate: candidate ? snapshot(candidate) : null,
        selected: snapshot(accept ? candidate : baseline), ownedBaseline, ownedCandidate,
        contextUnchanged: Boolean(contextUnchanged) };
}

export async function optimizeGuardedDrivingWindows(legacyOrder, plan, options = {}) {
    if (plan.routeFingerprint !== routePropertyOrderFingerprint(legacyOrder) || plan.inputFingerprint !== inputFingerprint(legacyOrder)) {
        throw new Error('Resume route membership/order or access coordinates changed.');
    }
    const byId = new Map(legacyOrder.map(p => [id(p), p]));
    const stitched = [...legacyOrder], results = [];
    let providerUnavailable = false;
    if (options.resume && (!options.providerEpoch || options.resume.providerEpoch !== options.providerEpoch
        || JSON.stringify(options.resume.plan) !== JSON.stringify(plan))) throw new Error('Resume graph identity or window plan changed.');
    for (const window of plan.windows) {
        if (options.signal?.aborted) throw options.signal.reason || new DOMException('Cancelled', 'AbortError');
        const resume = options.resume?.results.find(row => row.id === window.id && row.eligible);
        let row;
        if (resume && options.providerEpoch) {
            if (resume.start !== window.start || resume.end !== window.end) throw new Error('Resume window boundaries changed.');
            row = resume;
        } else if (providerUnavailable) row = { ...window, eligible: false, selection: 'legacy_fallback',
            reason: 'ROAD_PROVIDER_UNAVAILABLE', selectedIds: window.sourceOrder, baseline: null, candidate: null, selected: null };
        else row = await evaluateDrivingWindow(legacyOrder, window, options);
        if (row.reason === 'ROAD_PROVIDER_UNAVAILABLE') providerUnavailable = true;
        const selected = row.selectedIds.map(key => byId.get(key));
        if (selected.some(p => !p)) throw new Error('Resume changed route membership.');
        assertPilotMembership(legacyOrder.slice(window.start, window.end), selected);
        if (selected.slice(0, 2).map(id).join('|') !== legacyOrder.slice(window.start, window.start + 2).map(id).join('|')
            || selected.slice(-2).map(id).join('|') !== legacyOrder.slice(window.end - 2, window.end).map(id).join('|')) {
            throw new Error('Window moved a fixed incoming/outgoing anchor.');
        }
        if (row.eligible) {
            validateLegs(row.baseline.directedLegs, legacyOrder.slice(window.start, window.end));
            validateLegs(row.selected.directedLegs, selected);
            const a = total(row.baseline.directedLegs), b = total(row.selected.directedLegs);
            if (b.driveSeconds > a.driveSeconds || b.distanceMiles > a.distanceMiles) throw new Error('Resume accepted a regression.');
            if (options.expectedDataVersion && (row.baseline.dataVersion !== options.expectedDataVersion
                || row.selected.dataVersion !== options.expectedDataVersion)) throw new Error('Resume graph identity changed.');
            if (selected.map(id).join('|') !== legacyOrder.slice(window.start, window.end).map(id).join('|')) {
                const ownedA = total(row.baseline.directedLegs.slice(1, -1)), ownedB = total(row.selected.directedLegs.slice(1, -1));
                if (ownedB.driveSeconds >= ownedA.driveSeconds || ownedB.distanceMiles > ownedA.distanceMiles
                    || b.driveSeconds >= a.driveSeconds
                    || ![0, row.baseline.directedLegs.length - 1].every(i => sameContextLeg(row.baseline.directedLegs[i], row.selected.directedLegs[i]))) {
                    throw new Error('Resume accepted a connector regression.');
                }
            }
        } else if (selected.map(id).join('|') !== legacyOrder.slice(window.start, window.end).map(id).join('|')) {
            throw new Error('Fallback window changed legacy order.');
        }
        stitched.splice(window.start, window.end - window.start, ...selected);
        results.push(row);
        await options.onCheckpoint?.({ plan, results, providerEpoch: options.providerEpoch || null });
    }
    assertPilotMembership(legacyOrder, stitched);
    for (const i of plan.uncertainIndexes) if (id(stitched[i]) !== id(legacyOrder[i])) throw new Error('Unresolved anchor moved.');
    const mutable = new Set(results.filter(r => r.eligible).flatMap(r => Array.from({ length: r.mutableEnd - r.mutableStart }, (_, j) => r.mutableStart + j)));
    return { properties: stitched, plan, results, summary: {
        visibleRoutes: 1, stops: legacyOrder.length, roadAwareStops: mutable.size,
        unresolvedStops: plan.uncertainIndexes.length, preservedStops: legacyOrder.length - mutable.size,
        windows: results.length, improvedWindows: results.filter(r => r.selection === 'road_aware').length,
        guardRetainedWindows: results.filter(r => r.selection === 'legacy_guard').length,
        fallbackWindows: results.filter(r => !r.eligible).length,
        acceptedRegressions: 0, membershipIntegrity: 'PASS', unresolvedOrderIntegrity: 'PASS',
        selectedFingerprint: routePropertyOrderFingerprint(stitched), legacyFingerprint: plan.routeFingerprint,
    } };
}

/** One slot per real consecutive leg. Window interior + connectors occupy
 * their original global slots; seams/fallback regions are measured separately.
 * Missing legs stay missing in BOTH totals rather than being assigned zero.
 */
export function summarizeStitchedDrivingLegs(legacyOrder, output, unchangedLegs = []) {
    const baseline = new Array(Math.max(0, legacyOrder.length - 1)).fill(null);
    const selected = [...baseline];
    for (const record of unchangedLegs) {
        const i = record.index;
        if (!Number.isInteger(i) || i < 0 || i >= baseline.length || baseline[i]) throw new Error('Consecutive leg was counted twice.');
        if (record.leg) { validateLegs([record.leg], legacyOrder.slice(i, i + 2)); baseline[i] = selected[i] = record.leg; }
    }
    for (const row of output.results) if (row.eligible) {
        for (let local = 0; local < row.baseline.directedLegs.length; local++) {
            const i = row.start + local;
            if (baseline[i]) throw new Error('Window connector was counted twice.');
            baseline[i] = row.baseline.directedLegs[local]; selected[i] = row.selected.directedLegs[local];
        }
    }
    baseline.forEach((leg, i) => { if (leg) validateLegs([selected[i]], output.properties.slice(i, i + 2)); });
    const missing = baseline.flatMap((leg, i) => leg ? [] : [i]);
    if (missing.some(i => id(legacyOrder[i]) !== id(output.properties[i]) || id(legacyOrder[i + 1]) !== id(output.properties[i + 1]))) {
        throw new Error('An unmeasurable connector changed.');
    }
    const a = total(baseline.filter(Boolean)), b = total(selected.filter(Boolean));
    return { legacyMeasurableMiles: a.distanceMiles, selectedMeasurableMiles: b.distanceMiles,
        legacyMeasurableSeconds: a.driveSeconds, selectedMeasurableSeconds: b.driveSeconds,
        milesSaved: a.distanceMiles - b.distanceMiles, secondsSaved: a.driveSeconds - b.driveSeconds,
        measuredLegs: baseline.length - missing.length, unmeasurableLegs: missing.length, unmeasurableLegIndexes: missing,
        expectedLegs: baseline.length, everyConnectorCountedOnce: true, unmeasurableEdgesUnchanged: true,
        fullRoadTotalAvailable: missing.length === 0, baselineLegs: baseline, selectedLegs: selected };
}

export async function measureUnchangedDrivingLegs(legacyOrder, output, { measureSequence, unresolvedIds = [], signal }) {
    const owned = new Set(output.results.filter(row => row.eligible).flatMap(row =>
        Array.from({ length: row.end - row.start - 1 }, (_, j) => row.start + j)));
    const uncertain = new Set(unresolvedIds), records = [];
    async function measure(start, end) {
        if (signal?.aborted) throw signal.reason || new DOMException('Cancelled', 'AbortError');
        const sequence = legacyOrder.slice(start, end + 1);
        try {
            const result = await measureSequence(sequence);
            validateLegs(result.directedLegs, sequence);
            result.directedLegs.forEach((leg, i) => records.push({ index: start + i, leg: compactLeg(leg) }));
        } catch (error) {
            fatal(error);
            if (outage(error)) throw error;
            if (end - start === 1) records.push({ index: start, leg: null, error: error.message });
            else { const middle = Math.floor((start + end) / 2); await measure(start, middle); await measure(middle, end); }
        }
    }
    let i = 0;
    while (i < legacyOrder.length - 1) {
        if (owned.has(i)) { i++; continue; }
        if (uncertain.has(id(legacyOrder[i])) || uncertain.has(id(legacyOrder[i + 1]))) {
            records.push({ index: i++, leg: null, error: 'Unresolved endpoint; legacy edge remains unchanged.' }); continue;
        }
        const start = i;
        i++;
        while (i < legacyOrder.length - 1 && i - start < 499 && !owned.has(i)
            && !uncertain.has(id(legacyOrder[i])) && !uncertain.has(id(legacyOrder[i + 1]))) i++;
        await measure(start, i);
    }
    return records.sort((a, b) => a.index - b.index);
}
