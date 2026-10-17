// Road-name identity for matching an address to the road it is served from.
//
// Two spellings name the same road far more often than an exact string match
// admits, and every rejection there leaves a stop "unresolved" and the whole
// route unverifiable:
//   - spacing: Census "SADDLETREE RD", the deed "Saddle Tree Rd", OSM
//     "Saddletree Road" — one road, three spellings;
//   - numbered highways: "Nc Highway 90 W", Census "STATE HWY 90", OSM ref
//     "NC 90" — the same state highway; a directional suffix on a highway
//     number is part of the mailing address, not a different road;
//   - junctions: OSRM names a /route waypoint on a junction after every road
//     meeting there ("A / B") while /nearest names one.
// Callers still check house number, ZIP, distance and the snapped position;
// this only stops spelling from reading as a different road.

// Highway systems that are interchangeable in addresses. "SR"/"State Road" is
// a secondary road number in several states, so it is kept separate from a
// state highway.
const HIGHWAY = /^(?:(state rd|state road|nc|state|st|us|i|interstate|sr)\s+)?(?:(hwy|highway|route|rte)\s+)?(\d{1,4}[a-z]?)((?:\s+(?:n|s|e|w|north|south|east|west|bus|business|byp|bypass|alt|truck|conn))*)$/;
const SYSTEM = { nc: 'state', state: 'state', st: 'state', us: 'us', i: 'interstate', interstate: 'interstate',
    sr: 'sr', 'state rd': 'sr', 'state road': 'sr' };

/** A comparable identity for an already-normalized street key. */
export function streetIdentity(key) {
    const text = String(key || '').toLowerCase().replace(/[-.]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    const highway = HIGHWAY.exec(text);
    // A bare number ("90") is not a highway; it needs a system or "hwy".
    if (highway && (highway[1] || highway[2])) {
        const system = highway[1] ? SYSTEM[highway[1]] : 'any';
        return { highway: true, system, number: highway[3] };
    }
    return { highway: false, text: text.replace(/\s+/g, '') };
}

/** Whether two street names (normalized by `key`) name the same road. */
export function sameStreet(left, right, key) {
    const a = streetIdentity(key(left || '')), b = streetIdentity(key(right || ''));
    if (!a || !b || a.highway !== b.highway) return false;
    if (!a.highway) return a.text === b.text;
    return a.number === b.number && (a.system === b.system || a.system === 'any' || b.system === 'any');
}

/** A /route waypoint label ("A / B" at a junction) names the expected road. */
export function waypointOnRoad(waypointName, expectedRoad, key) {
    if (!streetIdentity(key(expectedRoad || ''))) return false;
    return String(waypointName || '').split(/\s+\/\s+/).some(name => sameStreet(name, expectedRoad, key));
}
