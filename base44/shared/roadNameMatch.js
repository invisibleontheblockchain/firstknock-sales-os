// OSRM names a /route waypoint that snaps onto a junction after every road
// meeting there, joined by " / " ("Broad Birch Drive / Copper Pne Lane"), while
// /nearest at the same point reports one of them ("Broad Birch Drive"). A road
// check that compares the whole label therefore rejects a waypoint that sits
// exactly on the expected road. Callers still check the snapped position; this
// only stops a junction label from reading as a different road.
export function waypointOnRoad(waypointName, expectedRoad, key) {
    const expected = key(expectedRoad || '');
    if (!expected) return false;
    return String(waypointName || '').split(/\s+\/\s+/).some(name => key(name) === expected);
}
