// Road-network topology for corpus territory selection.
//
// WHY A GRAPH AND NOT MORE MAP TAGS
// Street-name suffixes and metres of mapped water are proxies. The traits that
// actually decide whether a decomposition cut is cheap are properties of the road
// GRAPH: how many ways dead-end, which single intersections the interior of a
// subdivision hangs off, and how much of the street length sits behind one such
// intersection. Those are articulation points and bridges, and they are computable
// from the same public map data OSRM routes on.
//
// WHAT IT REPORTS
//   road_meters_per_sq_mi     drivable street length density
//   intersection_density      junctions (degree >= 3) per sq mi
//   dead_end_ratio            share of street ends that terminate
//   articulation_point_count  junctions whose removal disconnects the network
//   bridge_edge_count         edges whose removal disconnects the network
//   single_entry_pocket_share share of street metres reachable only through one
//                             articulation point — the "one way in, one way out"
//                             subdivision share, measured rather than guessed
//
// NOT PRODUCTION CODE — research tooling under scripts/. Never imported by the app,
// and these numbers never reach the solver.

import { haversineMiles } from './territoryGeography.js';

const OVERPASS_HOSTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
];
const USER_AGENT = 'FirstKnock-benchmark-corpus/1.0 (Precision routing research)';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Ways a door-knocking route can actually drive. Motorways are excluded: they carry
// no doors and are barriers rather than routes.
const DRIVABLE = '^(residential|living_street|unclassified|tertiary|tertiary_link|secondary|secondary_link|primary|primary_link|service)$';

/**
 * Fetch the drivable road network inside a bbox as ways with node ids.
 *
 * @returns {Promise<object>} `{ ok, ways: [{ nodes, geometry }], osmDataTimestamp }`
 */
export async function fetchRoadNetwork(bounds, { attempts = 3 } = {}) {
    const bbox = `${bounds.minLat},${bounds.minLng},${bounds.maxLat},${bounds.maxLng}`;
    const query = `[out:json][timeout:120];way["highway"~"${DRIVABLE}"](${bbox});out body geom;`;

    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const host = OVERPASS_HOSTS[attempt % OVERPASS_HOSTS.length];
        try {
            const response = await fetch(host, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
                body: `data=${encodeURIComponent(query)}`
            });
            if (!response.ok) throw new Error(`${host} -> ${response.status}`);
            const payload = await response.json();
            const ways = (payload.elements || [])
                .filter((element) => element.type === 'way' && Array.isArray(element.nodes) && element.nodes.length >= 2)
                .map((element) => ({ nodes: element.nodes, geometry: element.geometry || [] }));
            return { ok: true, ways, osmDataTimestamp: payload.osm3s?.timestamp_osm_base || null };
        } catch (error) {
            lastError = error;
            await sleep(2000 * (attempt + 1));
        }
    }
    return { ok: false, error: String(lastError) };
}

function segmentMeters(geometry, index) {
    if (!geometry[index] || !geometry[index + 1]) return 0;
    return haversineMiles(
        { lat: geometry[index].lat, lng: geometry[index].lon },
        { lat: geometry[index + 1].lat, lng: geometry[index + 1].lon }
    ) * 1609.344;
}

/**
 * Reduce the fetched ways to an undirected graph keyed by OSM node id.
 *
 * Interior nodes of a way that no other way touches carry no topology, but they do
 * carry length, so length is accumulated onto the edge between consecutive
 * JUNCTION nodes. That keeps the graph small while preserving street metres.
 */
function buildGraph(ways) {
    const nodeUse = new Map();
    for (const way of ways) {
        for (const node of way.nodes) nodeUse.set(node, (nodeUse.get(node) || 0) + 1);
    }

    const adjacency = new Map();
    const edges = [];
    const addEdge = (a, b, meters) => {
        if (a === b) return;
        const index = edges.length;
        edges.push({ a, b, meters });
        if (!adjacency.has(a)) adjacency.set(a, []);
        if (!adjacency.has(b)) adjacency.set(b, []);
        adjacency.get(a).push({ to: b, edge: index });
        adjacency.get(b).push({ to: a, edge: index });
    };

    for (const way of ways) {
        const last = way.nodes.length - 1;
        // A closed way (a loop road, roundabout or circle) whose interior nodes are
        // shared with nothing would otherwise reduce to a single start==end edge and
        // be dropped as a self-loop, deleting a real street and, worse, making the
        // junction it hangs off look like a dead end instead of a cut vertex. Forcing
        // its midpoint to be a junction keeps the ring a ring.
        const forced = new Set([way.nodes[0], way.nodes[last]]);
        if (way.nodes[0] === way.nodes[last] && last >= 2) forced.add(way.nodes[Math.floor(last / 2)]);

        let anchor = way.nodes[0];
        let meters = 0;
        for (let i = 0; i < last; i += 1) {
            meters += segmentMeters(way.geometry, i);
            const node = way.nodes[i + 1];
            const isJunction = (nodeUse.get(node) || 0) > 1 || forced.has(node) || i + 1 === last;
            if (isJunction) {
                addEdge(anchor, node, meters);
                anchor = node;
                meters = 0;
            }
        }
    }

    return { adjacency, edges };
}

/**
 * Tarjan articulation points and bridges, plus the biconnected block each edge
 * belongs to. Iterative because a city bbox can nest deeper than the call stack.
 */
function findArticulationStructure(adjacency, edges) {
    const discovery = new Map();
    const low = new Map();
    const parentEdge = new Map();
    const articulation = new Set();
    const bridges = new Set();
    const blockOfEdge = new Int32Array(edges.length).fill(-1);
    let timer = 0;
    let blockId = 0;

    for (const root of adjacency.keys()) {
        if (discovery.has(root)) continue;
        const stack = [{ node: root, iterator: 0, children: 0 }];
        const edgeStack = [];
        discovery.set(root, timer);
        low.set(root, timer);
        timer += 1;

        while (stack.length) {
            const frame = stack[stack.length - 1];
            const neighbours = adjacency.get(frame.node) || [];
            if (frame.iterator < neighbours.length) {
                const { to, edge } = neighbours[frame.iterator];
                frame.iterator += 1;
                if (parentEdge.get(frame.node) === edge) continue;
                if (!discovery.has(to)) {
                    edgeStack.push(edge);
                    parentEdge.set(to, edge);
                    discovery.set(to, timer);
                    low.set(to, timer);
                    timer += 1;
                    frame.children += 1;
                    stack.push({ node: to, iterator: 0, children: 0 });
                } else if (discovery.get(to) < discovery.get(frame.node)) {
                    edgeStack.push(edge);
                    low.set(frame.node, Math.min(low.get(frame.node), discovery.get(to)));
                }
                continue;
            }

            stack.pop();
            const parent = stack[stack.length - 1];
            if (!parent) break;
            low.set(parent.node, Math.min(low.get(parent.node), low.get(frame.node)));

            if (low.get(frame.node) >= discovery.get(parent.node)) {
                // Closing a biconnected block: everything above this edge on the
                // stack is one block, and its entry point is `parent.node`.
                const id = blockId;
                blockId += 1;
                const own = parentEdge.get(frame.node);
                while (edgeStack.length) {
                    const edge = edgeStack.pop();
                    blockOfEdge[edge] = id;
                    if (edge === own) break;
                }
                const isRoot = parent.node === root;
                if (!isRoot || parent.children > 1) articulation.add(parent.node);
            }
            if (low.get(frame.node) > discovery.get(parent.node)) bridges.add(parentEdge.get(frame.node));
        }
    }

    return { articulation, bridges, blockOfEdge, blockCount: blockId };
}

/**
 * Describe the road-network topology of a territory.
 *
 * @param {object} network `{ ways }` from fetchRoadNetwork
 * @param {object} geography output of describeDoorGeography (for area normalization)
 */
export function describeRoadTopology(network, geography) {
    const { adjacency, edges } = buildGraph(network.ways);
    if (!edges.length) return { ok: false, error: 'NO_ROAD_EDGES' };

    const totalMeters = edges.reduce((sum, edge) => sum + edge.meters, 0);
    const degrees = [...adjacency.entries()].map(([node, links]) => ({ node, degree: links.length }));
    const deadEnds = degrees.filter((entry) => entry.degree === 1);
    const junctions = degrees.filter((entry) => entry.degree >= 3);

    const { articulation, bridges, blockOfEdge, blockCount } = findArticulationStructure(adjacency, edges);

    // A single-entry pocket is a biconnected block whose only connection to the rest
    // of the network is one articulation point. Its street metres can only be
    // reached, and must be left, through that one point — the structural fact behind
    // "one way in, one way out".
    const blockMeters = new Float64Array(blockCount);
    const blockArticulations = Array.from({ length: blockCount }, () => new Set());
    for (let index = 0; index < edges.length; index += 1) {
        const block = blockOfEdge[index];
        if (block < 0) continue;
        blockMeters[block] += edges[index].meters;
        for (const node of [edges[index].a, edges[index].b]) {
            if (articulation.has(node)) blockArticulations[block].add(node);
        }
    }
    let pocketMeters = 0;
    let pocketCount = 0;
    for (let block = 0; block < blockCount; block += 1) {
        if (blockArticulations[block].size === 1) {
            pocketMeters += blockMeters[block];
            pocketCount += 1;
        }
    }

    const area = Math.max(geography.area_sq_mi, 0.0001);
    return {
        ok: true,
        road_meters: Math.round(totalMeters),
        road_meters_per_sq_mi: Math.round(totalMeters / area),
        graph_nodes: adjacency.size,
        graph_edges: edges.length,
        intersection_density_per_sq_mi: Math.round(junctions.length / area),
        dead_end_count: deadEnds.length,
        dead_end_ratio: pctOf(deadEnds.length, deadEnds.length + junctions.length),
        articulation_point_count: articulation.size,
        bridge_edge_count: bridges.size,
        single_entry_pocket_count: pocketCount,
        single_entry_pocket_share: pctOf(pocketMeters, totalMeters),
        osm_data_timestamp: network.osmDataTimestamp || null
    };
}

function pctOf(part, whole) {
    return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}