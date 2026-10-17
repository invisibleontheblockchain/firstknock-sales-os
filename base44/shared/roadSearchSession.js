import { createRoadSearchContinuationCodec, sha256RoadSearch } from './roadSearchContinuation.js';
import { createRoadSearchProof, validateRoadSearchProofSnapshot } from './roadSearchProof.js';
import { createVehicleRoutingContext } from './vehicleRouting.js';
import { neighborhoodStreetKey } from './neighborhoodExcursions.js';
import { trustedAccess } from './streetSideRouting.js';
import { isValidRoutePoint } from './routeBounds.js';

const identity = stop => String(stop?.address_hash || stop?.legacy_hash || stop?.id || `${stop?.lat},${stop?.lng}`);
const propertyFields = ['house_number', 'street_name', 'city', 'subdivision_name', 'lat', 'lng', 'routing_access'];
const settingsFields = ['mailCarrierMode', 'localSearchWidth', 'maxLocalCandidates', 'maxAreaCandidates',
    'maxAreaMoveUnits', 'preferContiguousOnTie', 'tieSeconds', 'inferStreetSides', 'areaDrivingReview',
    'maxLocalStops', 'localRadiusMiles', 'minAreaWindowStops', 'maxAreaWindowStops', 'areaRadiusMiles',
    'maxServiceWindowStops', 'maxShortWindows', 'shortRadiusMiles', 'minShortGainMiles',
    'requireNoDrivingIncrease', 'shortDrivingCleanup', 'servicePolicy', 'returnToStart'];
const fingerprintPattern = /^[a-f0-9]{64}$/;
const fatal = error => { if (error?.name === 'AbortError' || /graph identity|cancelled/i.test(error?.message || '')) throw error; };
const project = stop => ({ address_hash: identity(stop), ...Object.fromEntries(propertyFields.map(key => [key, stop?.[key] ?? null])),
    state: stop?.state || stop?.state_code || null, zip_code: stop?.zip_code || stop?.zip || null,
    order_locked: stop?.order_locked === true || stop?.locked === true });
const boundary = stop => stop ? Object.fromEntries(['lat', 'lng', 'id', 'address_hash', 'vehicle_heading_degrees']
    .map(key => [key, stop[key] ?? null])) : null;

// This is a five-minute, same-action observation snapshot, not an immutable
// graph certificate. The endpoint must still freshly verify the final order.
export async function createRoadSearchSession({ secret, appId, userId, optimizerVersion, providerIdentity,
    body = {}, properties = [], displayProperties = [], startLocation = null, endLocation = null,
    neighborhoodOptions = {}, startedAt, now = Date.now, createDrivingContext, eligible = true, unresolvedStopIds = [] } = {}) {
    const diagnostic = { version: 1, status: 'disabled', reason: 'unsupported', restored_windows: 0, issued: false };
    const disabled = reason => { diagnostic.reason = reason; return { proof: null, diagnostic, finish: async () => null }; };
    if (!eligible) return disabled('ineligible');
    if (body.search_continuation_version !== 1 || body.profile === 'walking' || neighborhoodOptions.vehicleProfile === 'walking') return disabled('unsupported');
    let proof;
    try { proof = createRoadSearchProof(null, { providerIdentity, policyVersion: optimizerVersion }); }
    catch { return disabled('invalid_scope'); }
    let initializing = true;
    const initialTime = startedAt ?? now();
    if (!Number.isSafeInteger(initialTime) || initialTime < 0 || initialTime > now()) return disabled('invalid_start');
    const codec = createRoadSearchContinuationCodec({ secret, appId, userId, provider: providerIdentity, optimizerVersion,
        now: () => initializing ? initialTime : now() });
    let lifetime = codec.begin();
    initializing = false;
    // Capable clients must never fall back to unsigned history certifying
    // completion when receipt signing is temporarily unavailable.
    if (!lifetime) return { ...disabled('unconfigured'), proof };
    const ids = properties.map(identity), idsSet = new Set(ids);
    const comparisonIds = Array.isArray(body.comparison_order) ? body.comparison_order : ids;
    if (properties.length < 2 || properties.length > 2500 || idsSet.size !== properties.length
        || displayProperties.length !== properties.length || new Set(displayProperties.map(identity)).size !== properties.length
        || displayProperties.some(stop => !idsSet.has(identity(stop))) || comparisonIds.length !== properties.length
        || new Set(comparisonIds).size !== properties.length || comparisonIds.some(id => typeof id !== 'string' || !idsSet.has(id))) return disabled('invalid_membership');
    const byId = new Map(properties.map(stop => [identity(stop), stop]));
    const originalOrder = comparisonIds.map(id => byId.get(id));
    // Stops without road access cannot be routed. They never move, and every
    // proof key already names them, so the witness drives around them; the
    // skipped set is part of the witness, so a change discards the proof.
    const unresolved = [...new Set(unresolvedStopIds.map(String))].filter(id => idsSet.has(id)).sort();
    const unresolvedSet = new Set(unresolved);
    const witnessOrder = originalOrder.filter(stop => !unresolvedSet.has(identity(stop)));
    const settings = Object.fromEntries(settingsFields.map(key => [key, neighborhoodOptions[key] ?? null]));
    settings.lockedStopIds = [...(neighborhoodOptions.lockedStopIds || [])].map(String).sort();
    const inputFingerprint = rawOrder => sha256RoadSearch({ properties: rawOrder.map(project), comparisonIds,
        start: boundary(startLocation), end: boundary(endLocation), profile: neighborhoodOptions.vehicleProfile || 'driving', settings });
    const recoveredFingerprint = order => sha256RoadSearch(order.map(project));
    let inputHash, recoveredHash;
    try { inputHash = await inputFingerprint(displayProperties); recoveredHash = await recoveredFingerprint(properties); }
    catch { return disabled('invalid_input'); }
    const measureWitness = async currentProof => {
        const access = { accessFor: stop => trustedAccess(stop.routing_access) ? stop.routing_access
            : currentProof.inferredAccess.get(identity(stop)) || stop.routing_access || null,
        streetSegmentKey: neighborhoodStreetKey };
        const factory = createDrivingContext || neighborhoodOptions.createDrivingContext || createVehicleRoutingContext;
        const context = await factory(witnessOrder, access, { ...neighborhoodOptions, startLocation, endLocation,
            routeOnly: true, sparseCosts: true, requireDirectedLegs: true, maxGeometryPoints: 100000,
            servicePolicy: { enabled: false, parkingSecondsPerStop: 0 } });
        const measured = await context.routeSequence(witnessOrder, { startLocation, endLocation });
        const ordered = [startLocation, ...witnessOrder, endLocation].filter(isValidRoutePoint);
        if (!Array.isArray(measured?.directedLegs) || measured.directedLegs.length !== ordered.length - 1
            || !Number.isFinite(measured.driveSeconds) || measured.driveSeconds < 0
            || !Number.isFinite(measured.distanceMiles) || measured.distanceMiles < 0
            || (measured.dataVersion != null && (typeof measured.dataVersion !== 'string' || measured.dataVersion.length > 4096))) {
            throw new Error('Road search witness is incomplete.');
        }
        let points = 0;
        const legs = measured.directedLegs.map((leg, index) => {
            if (leg.from !== identity(ordered[index]) || leg.to !== identity(ordered[index + 1])
                || !Number.isFinite(leg.driveSeconds) || leg.driveSeconds < 0 || !Number.isFinite(leg.distanceMiles) || leg.distanceMiles < 0
                || !Array.isArray(leg.geometry) || !leg.geometry.length || !leg.geometry.every(isValidRoutePoint)
                || (points += leg.geometry.length) > 100000
                || leg.pathKey !== JSON.stringify(leg.geometry.map(point => [point.lng, point.lat]))) {
                throw new Error('Road search witness has invalid consecutive legs.');
            }
            return { from: leg.from, to: leg.to, pathKey: leg.pathKey, seconds: leg.driveSeconds, miles: leg.distanceMiles };
        });
        if (Math.abs(legs.reduce((sum, leg) => sum + leg.seconds, 0) - measured.driveSeconds) > 0.11 * legs.length
            || Math.abs(legs.reduce((sum, leg) => sum + leg.miles, 0) - measured.distanceMiles) > 0.11 * legs.length / 1609.344) {
            throw new Error('Road search witness totals disagree.');
        }
        return sha256RoadSearch({ dataVersion: measured.dataVersion || null, legs,
            seconds: measured.driveSeconds, miles: measured.distanceMiles, ...(unresolved.length ? { unresolved } : {}) });
    };
    diagnostic.status = 'new'; diagnostic.reason = 'fresh_action';
    if (body.search_continuation) {
        const opened = await codec.open(body.search_continuation, inputHash);
        if (opened) lifetime = opened;
        const state = opened?.state;
        let restored = null;
        try {
            if (state?.version === 1 && Object.keys(state).sort().join(',') === 'proof,recoveredFingerprint,version,witnessFingerprint'
                && state.recoveredFingerprint === recoveredHash && fingerprintPattern.test(state.witnessFingerprint)
                && validateRoadSearchProofSnapshot(state.proof)
                && state.proof.inferredAccess.every(([id]) => idsSet.has(id)) && state.proof.discovered.every(id => idsSet.has(id))) {
                restored = createRoadSearchProof(state.proof, { providerIdentity, policyVersion: optimizerVersion });
            }
            if (restored && await measureWitness(restored) === state.witnessFingerprint) {
                proof = restored; diagnostic.status = 'restored'; diagnostic.reason = 'fresh_witness_matched';
                diagnostic.restored_windows = state.proof.receipts.length;
            } else { diagnostic.status = 'discarded'; diagnostic.reason = restored ? 'witness_changed' : 'receipt_mismatch'; }
        } catch (error) {
            fatal(error); diagnostic.status = 'discarded'; diagnostic.reason = 'witness_unavailable';
        }
    }
    return { proof, diagnostic, async finish({ winningOrder, accessOverrides = {}, eligible = false } = {}) {
        if (!eligible) return null;
        try {
            if (!Array.isArray(winningOrder) || winningOrder.length !== properties.length
                || new Set(winningOrder.map(identity)).size !== properties.length || winningOrder.some(stop => !idsSet.has(identity(stop)))) return null;
            const displayById = new Map(displayProperties.map(stop => [identity(stop), stop]));
            const nextRawOrder = winningOrder.map(stop => {
                const raw = displayById.get(identity(stop)), access = Object.hasOwn(accessOverrides, identity(stop)) ? accessOverrides[identity(stop)] : null;
                return access ? { ...raw, routing_access: access } : raw;
            });
            const snapshot = proof.exportSnapshot();
            const witnessFingerprint = await measureWitness(proof);
            const token = await codec.seal({ version: 1, proof: snapshot,
                recoveredFingerprint: await recoveredFingerprint(winningOrder), witnessFingerprint },
            await inputFingerprint(nextRawOrder), lifetime);
            diagnostic.issued = Boolean(token);
            return token;
        } catch (error) { fatal(error); return null; }
    } };
}
