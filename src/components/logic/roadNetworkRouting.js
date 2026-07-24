const EARTH_RADIUS_METERS = 6371008.8;
const METERS_PER_MILE = 1609.344;
const POSITION_EPSILON = 1e-9;
const DEFAULT_SPATIAL_CELL_DEGREES = 0.005;
const MAX_INDEX_CELLS_PER_SEGMENT = 4096;
const MAX_QUERY_CELLS = 20000;

export const DEFAULT_ROUTABLE_HIGHWAYS = Object.freeze([
    'motorway',
    'motorway_link',
    'trunk',
    'trunk_link',
    'primary',
    'primary_link',
    'secondary',
    'secondary_link',
    'tertiary',
    'tertiary_link',
    'unclassified',
    'residential',
    'living_street',
    'service',
    'road',
]);

const BLOCKED_ACCESS_VALUES = new Set(['no', 'private']);
const STREET_TOKEN_ALIASES = Object.freeze({
    alley: 'aly',
    avenue: 'ave',
    boulevard: 'blvd',
    circle: 'cir',
    court: 'ct',
    drive: 'dr',
    highway: 'hwy',
    lane: 'ln',
    parkway: 'pkwy',
    place: 'pl',
    road: 'rd',
    street: 'st',
    terrace: 'ter',
    trail: 'trl',
    north: 'n',
    south: 's',
    east: 'e',
    west: 'w',
    northeast: 'ne',
    northwest: 'nw',
    southeast: 'se',
    southwest: 'sw',
});

function compareIds(left, right) {
    return String(left).localeCompare(String(right), 'en', {
        numeric: true,
        sensitivity: 'base',
    });
}

function canonicalId(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const normalized = String(value).trim();
    return normalized || null;
}

function stableHash(value) {
    let first = 2166136261;
    let second = 2246822507;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        first = Math.imul(first ^ code, 16777619);
        second = Math.imul(second ^ code, 3266489909);
    }
    return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function edgeIdFor(left, right) {
    const [first, second] = [String(left), String(right)].sort(compareIds);
    return `edge:${encodeURIComponent(first)}:${encodeURIComponent(second)}`;
}

function numericCoordinate(value) {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function pointFrom(value) {
    const coordinates = Array.isArray(value?.coordinates)
        ? value.coordinates
        : Array.isArray(value?.geometry?.coordinates)
            ? value.geometry.coordinates
            : null;
    const lat = numericCoordinate(
        value?.lat
        ?? value?.latitude
        ?? value?.location?.lat
        ?? value?.location?.latitude
        ?? coordinates?.[1],
    );
    const lng = numericCoordinate(
        value?.lng
        ?? value?.lon
        ?? value?.longitude
        ?? value?.location?.lng
        ?? value?.location?.lon
        ?? value?.location?.longitude
        ?? coordinates?.[0],
    );
    if (lat === null || lng === null || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return null;
    }
    return { lat, lng };
}

function toRadians(degrees) {
    return degrees * Math.PI / 180;
}

function haversineMeters(left, right) {
    const latitudeDelta = toRadians(right.lat - left.lat);
    const longitudeDelta = toRadians(right.lng - left.lng);
    const leftLatitude = toRadians(left.lat);
    const rightLatitude = toRadians(right.lat);
    const haversine = Math.sin(latitudeDelta / 2) ** 2
        + Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2;
    const clamped = Math.max(0, Math.min(1, haversine));
    return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(clamped), Math.sqrt(1 - clamped));
}

function projectMeters(point, referenceLatitude) {
    const radians = Math.PI / 180;
    return {
        x: EARTH_RADIUS_METERS * point.lng * radians * Math.cos(referenceLatitude * radians),
        y: EARTH_RADIUS_METERS * point.lat * radians,
    };
}

function projectPointToSegment(point, start, end) {
    const referenceLatitude = (point.lat + start.lat + end.lat) / 3;
    const projectedPoint = projectMeters(point, referenceLatitude);
    const projectedStart = projectMeters(start, referenceLatitude);
    const projectedEnd = projectMeters(end, referenceLatitude);
    const deltaX = projectedEnd.x - projectedStart.x;
    const deltaY = projectedEnd.y - projectedStart.y;
    const lengthSquared = deltaX * deltaX + deltaY * deltaY;
    const position = lengthSquared <= Number.EPSILON
        ? 0
        : Math.max(0, Math.min(
            1,
            ((projectedPoint.x - projectedStart.x) * deltaX
                + (projectedPoint.y - projectedStart.y) * deltaY) / lengthSquared,
        ));
    const snappedPoint = {
        lat: start.lat + (end.lat - start.lat) * position,
        lng: start.lng + (end.lng - start.lng) * position,
    };
    return {
        position,
        point: snappedPoint,
        distanceMeters: haversineMeters(point, snappedPoint),
    };
}

function normalizeStreetName(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[.'’]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((token) => STREET_TOKEN_ALIASES[token] || token)
        .join(' ');
}

function streetNameFrom(value) {
    const explicit = value?.street_name
        ?? value?.streetName
        ?? value?.street
        ?? value?.address?.street
        ?? value?.address?.street_name;
    if (explicit) return String(explicit);

    const fullAddress = value?.full_address
        ?? value?.fullAddress
        ?? value?.formatted_address
        ?? value?.address_line1;
    if (!fullAddress) return '';
    return String(fullAddress)
        .split(',')[0]
        .replace(/^\s*\d+[a-z-]*\s+/i, '')
        .trim();
}

function locationCacheKey(value) {
    const point = pointFrom(value);
    if (!point) return null;
    return [
        point.lat.toFixed(8),
        point.lng.toFixed(8),
        normalizeStreetName(streetNameFrom(value)),
    ].join('|');
}

function roadNamesFrom(tags = {}) {
    const rawNames = [
        tags.name,
        tags.official_name,
        tags.short_name,
        tags.loc_name,
        tags.alt_name,
    ].flatMap((value) => String(value || '').split(';'));
    const seen = new Set();
    return rawNames
        .map((name) => ({
            display: name.trim(),
            normalized: normalizeStreetName(name),
        }))
        .filter(({ normalized }) => {
            if (!normalized || seen.has(normalized)) return false;
            seen.add(normalized);
            return true;
        })
        .sort((left, right) => compareIds(left.normalized, right.normalized));
}

function normalizedLayer(tags = {}) {
    const raw = String(tags.layer ?? '0').trim();
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? String(numeric) : raw || '0';
}

function gradeFor(tags = {}) {
    const bridge = String(tags.bridge || '').toLowerCase();
    const tunnel = String(tags.tunnel || '').toLowerCase();
    const structure = bridge && bridge !== 'no'
        ? 'bridge'
        : tunnel && tunnel !== 'no'
            ? 'tunnel'
            : 'surface';
    return {
        key: `${structure}:${normalizedLayer(tags)}`,
        structure,
        layer: normalizedLayer(tags),
    };
}

function isWayRoutable(way, allowedHighways) {
    const tags = way?.tags || {};
    const highway = String(tags.highway || '').toLowerCase();
    if (!allowedHighways.has(highway) || String(tags.area || '').toLowerCase() === 'yes') return false;
    return ![tags.access, tags.vehicle, tags.motor_vehicle]
        .map((value) => String(value || '').toLowerCase())
        .some((value) => BLOCKED_ACCESS_VALUES.has(value));
}

function directionFor(tags = {}) {
    const oneway = String(tags.oneway || '').toLowerCase();
    if (oneway === '-1' || oneway === 'reverse') {
        return { forward: false, backward: true };
    }
    if (['yes', 'true', '1'].includes(oneway)
        || (['roundabout', 'circular'].includes(String(tags.junction || '').toLowerCase())
            && oneway !== 'no')) {
        return { forward: true, backward: false };
    }
    return { forward: true, backward: true };
}

function normalizedElements(input = {}) {
    const supplied = Array.isArray(input)
        ? input
        : Array.isArray(input.elements)
            ? input.elements
            : Array.isArray(input.roadNetwork)
                ? input.roadNetwork
                : Array.isArray(input.roadNetwork?.elements)
                    ? input.roadNetwork.elements
                    : [];
    return [...supplied].sort((left, right) => {
        const type = compareIds(left?.type || '', right?.type || '');
        if (type) return type;
        const id = compareIds(left?.id ?? '', right?.id ?? '');
        if (id) return id;
        return JSON.stringify(left).localeCompare(JSON.stringify(right));
    });
}

function addArc(adjacency, arc) {
    adjacency.set(arc.from, [...(adjacency.get(arc.from) || []), arc]);
}

function transitionAllowed(left, right) {
    if (left.grade.key === right.grade.key) return true;
    if (left.grade.structure !== 'surface') return left.endpoint;
    if (right.grade.structure !== 'surface') return right.endpoint;
    return left.endpoint && right.endpoint;
}

function gridCellIndex(coordinate, offset, cellDegrees) {
    return Math.floor((coordinate + offset) / cellDegrees);
}

function gridCellKey(latitudeIndex, longitudeIndex) {
    return `${latitudeIndex}:${longitudeIndex}`;
}

function longitudeRadiusDegrees(latitude, angularRadius) {
    const latitudeRadians = toRadians(latitude);
    if (Math.abs(latitudeRadians) + angularRadius >= Math.PI / 2) return 180;
    const ratio = Math.sin(angularRadius) / Math.max(Number.EPSILON, Math.cos(latitudeRadians));
    return Math.asin(Math.min(1, Math.max(-1, ratio))) * 180 / Math.PI;
}

function buildSegmentSpatialIndex(segments, cellDegrees = DEFAULT_SPATIAL_CELL_DEGREES) {
    const cells = new Map();
    const overflowSegments = [];
    const segmentOrdinal = new Map(segments.map((segment, index) => [segment.id, index]));

    segments.forEach((segment) => {
        const minimumLatitude = Math.min(segment.start.lat, segment.end.lat);
        const maximumLatitude = Math.max(segment.start.lat, segment.end.lat);
        const minimumLongitude = Math.min(segment.start.lng, segment.end.lng);
        const maximumLongitude = Math.max(segment.start.lng, segment.end.lng);
        const crossesDateLine = maximumLongitude - minimumLongitude > 180;
        if (crossesDateLine) {
            overflowSegments.push(segment);
            return;
        }

        const minimumLatitudeIndex = gridCellIndex(minimumLatitude, 90, cellDegrees);
        const maximumLatitudeIndex = gridCellIndex(maximumLatitude, 90, cellDegrees);
        const minimumLongitudeIndex = gridCellIndex(minimumLongitude, 180, cellDegrees);
        const maximumLongitudeIndex = gridCellIndex(maximumLongitude, 180, cellDegrees);
        const latitudeCellCount = maximumLatitudeIndex - minimumLatitudeIndex + 1;
        const longitudeCellCount = maximumLongitudeIndex - minimumLongitudeIndex + 1;
        if (latitudeCellCount * longitudeCellCount > MAX_INDEX_CELLS_PER_SEGMENT) {
            overflowSegments.push(segment);
            return;
        }

        for (
            let latitudeIndex = minimumLatitudeIndex;
            latitudeIndex <= maximumLatitudeIndex;
            latitudeIndex += 1
        ) {
            for (
                let longitudeIndex = minimumLongitudeIndex;
                longitudeIndex <= maximumLongitudeIndex;
                longitudeIndex += 1
            ) {
                const key = gridCellKey(latitudeIndex, longitudeIndex);
                const cellSegments = cells.get(key);
                if (cellSegments) cellSegments.push(segment);
                else cells.set(key, [segment]);
            }
        }
    });
    return Object.freeze({
        cellDegrees,
        cellCount: cells.size,
        overflowSegmentCount: overflowSegments.length,
        query(point, radiusMeters) {
            const angularRadius = radiusMeters / EARTH_RADIUS_METERS;
            const latitudeRadius = angularRadius * 180 / Math.PI;
            const longitudeRadius = longitudeRadiusDegrees(point.lat, angularRadius);
            if (
                longitudeRadius >= 180
                || point.lng - longitudeRadius < -180
                || point.lng + longitudeRadius > 180
            ) {
                return segments;
            }

            const minimumLatitudeIndex = gridCellIndex(
                Math.max(-90, point.lat - latitudeRadius),
                90,
                cellDegrees,
            );
            const maximumLatitudeIndex = gridCellIndex(
                Math.min(90, point.lat + latitudeRadius),
                90,
                cellDegrees,
            );
            const minimumLongitudeIndex = gridCellIndex(
                point.lng - longitudeRadius,
                180,
                cellDegrees,
            );
            const maximumLongitudeIndex = gridCellIndex(
                point.lng + longitudeRadius,
                180,
                cellDegrees,
            );
            const queryCellCount = (maximumLatitudeIndex - minimumLatitudeIndex + 1)
                * (maximumLongitudeIndex - minimumLongitudeIndex + 1);
            if (queryCellCount > MAX_QUERY_CELLS) return segments;

            const candidates = [...overflowSegments];
            const seenIds = new Set(overflowSegments.map((segment) => segment.id));
            for (
                let latitudeIndex = minimumLatitudeIndex;
                latitudeIndex <= maximumLatitudeIndex;
                latitudeIndex += 1
            ) {
                for (
                    let longitudeIndex = minimumLongitudeIndex;
                    longitudeIndex <= maximumLongitudeIndex;
                    longitudeIndex += 1
                ) {
                    (cells.get(gridCellKey(latitudeIndex, longitudeIndex)) || [])
                        .forEach((segment) => {
                            if (seenIds.has(segment.id)) return;
                            seenIds.add(segment.id);
                            candidates.push(segment);
                        });
                }
            }
            return candidates.sort((left, right) => (
                segmentOrdinal.get(left.id) - segmentOrdinal.get(right.id)
            ));
        },
    });
}

function prepareWayNodes(way, nodeMap) {
    const geometry = Array.isArray(way.geometry) ? way.geometry : [];
    let nodeIds = Array.isArray(way.nodes)
        ? way.nodes.map(canonicalId)
        : [];
    if (!nodeIds.length && geometry.length) {
        nodeIds = geometry.map((_, index) => `geometry:${way.canonicalId}:${index}`);
    }
    if (nodeIds.length < 2 || nodeIds.some((id) => !id)) return null;

    nodeIds.forEach((nodeId, index) => {
        if (nodeMap.has(nodeId)) return;
        const geometryPoint = pointFrom(geometry[index]);
        if (geometryPoint) nodeMap.set(nodeId, { id: nodeId, ...geometryPoint });
    });
    return nodeIds.every((nodeId) => nodeMap.has(nodeId)) ? nodeIds : null;
}

function buildRoadGraph(input, options) {
    const elements = normalizedElements(input);
    const nodeMap = new Map();
    const wayMap = new Map();

    elements.forEach((element) => {
        const id = canonicalId(element?.id);
        if (!id) return;
        if (element.type === 'node') {
            const point = pointFrom(element);
            if (!point) return;
            const existing = nodeMap.get(id);
            if (!existing || `${point.lat},${point.lng}` < `${existing.lat},${existing.lng}`) {
                nodeMap.set(id, { id, ...point });
            }
        } else if (element.type === 'way') {
            const candidate = { ...element, canonicalId: id };
            const existing = wayMap.get(id);
            const candidateLength = Array.isArray(candidate.nodes) ? candidate.nodes.length : 0;
            const existingLength = Array.isArray(existing?.nodes) ? existing.nodes.length : 0;
            if (!existing
                || candidateLength > existingLength
                || (candidateLength === existingLength
                    && JSON.stringify(candidate) > JSON.stringify(existing))) {
                wayMap.set(id, candidate);
            }
        }
    });

    const adjacency = new Map();
    const vertices = new Map();
    const segments = [];
    const nodeMemberships = new Map();
    const malformedWayIds = [];
    let skippedWayCount = 0;

    [...wayMap.values()].sort((left, right) => compareIds(left.canonicalId, right.canonicalId)).forEach((way) => {
        if (!isWayRoutable(way, options.allowedHighways)) {
            skippedWayCount += 1;
            return;
        }
        const nodeIds = prepareWayNodes(way, nodeMap);
        if (!nodeIds) {
            malformedWayIds.push(way.canonicalId);
            return;
        }

        const grade = gradeFor(way.tags);
        const direction = directionFor(way.tags);
        const names = roadNamesFrom(way.tags);
        nodeIds.forEach((nodeId, index) => {
            const vertexId = `${nodeId}@${grade.key}`;
            const point = nodeMap.get(nodeId);
            if (!vertices.has(vertexId)) vertices.set(vertexId, { id: vertexId, nodeId, ...point });
            nodeMemberships.set(nodeId, [
                ...(nodeMemberships.get(nodeId) || []),
                {
                    vertexId,
                    wayId: way.canonicalId,
                    grade,
                    endpoint: index === 0 || index === nodeIds.length - 1,
                },
            ]);
        });

        for (let index = 0; index < nodeIds.length - 1; index += 1) {
            const rawStartId = nodeIds[index];
            const rawEndId = nodeIds[index + 1];
            if (rawStartId === rawEndId) continue;
            const startVertexId = `${rawStartId}@${grade.key}`;
            const endVertexId = `${rawEndId}@${grade.key}`;
            const start = vertices.get(startVertexId);
            const end = vertices.get(endVertexId);
            const lengthMeters = haversineMeters(start, end);
            if (!Number.isFinite(lengthMeters) || lengthMeters <= 0) continue;
            const edgeId = edgeIdFor(rawStartId, rawEndId);
            const segmentId = `segment:${encodeURIComponent(way.canonicalId)}:${String(index).padStart(6, '0')}:${edgeId}`;
            const segment = {
                id: segmentId,
                edgeId,
                wayId: way.canonicalId,
                index,
                rawStartId,
                rawEndId,
                startVertexId,
                endVertexId,
                start,
                end,
                lengthMeters,
                forward: direction.forward,
                backward: direction.backward,
                highway: String(way.tags?.highway || '').toLowerCase(),
                names,
                normalizedNames: names.map(({ normalized }) => normalized),
                grade,
            };
            segments.push(segment);
            if (direction.forward) {
                addArc(adjacency, {
                    id: `arc:${segmentId}:forward`,
                    from: startVertexId,
                    to: endVertexId,
                    lengthMeters,
                    segmentId,
                });
            }
            if (direction.backward) {
                addArc(adjacency, {
                    id: `arc:${segmentId}:backward`,
                    from: endVertexId,
                    to: startVertexId,
                    lengthMeters,
                    segmentId,
                });
            }
        }
    });

    const connectorPairs = [];
    [...nodeMemberships.entries()].sort(([left], [right]) => compareIds(left, right)).forEach(([nodeId, memberships]) => {
        const byVertex = new Map();
        memberships.forEach((membership) => {
            const current = byVertex.get(membership.vertexId);
            byVertex.set(membership.vertexId, current
                ? { ...current, endpoint: current.endpoint || membership.endpoint }
                : membership);
        });
        const grades = [...byVertex.values()].sort((left, right) => compareIds(left.vertexId, right.vertexId));
        for (let leftIndex = 0; leftIndex < grades.length - 1; leftIndex += 1) {
            for (let rightIndex = leftIndex + 1; rightIndex < grades.length; rightIndex += 1) {
                const left = grades[leftIndex];
                const right = grades[rightIndex];
                if (!transitionAllowed(left, right)) continue;
                const pairId = `${nodeId}:${left.vertexId}:${right.vertexId}`;
                addArc(adjacency, {
                    id: `connector:${pairId}:forward`,
                    from: left.vertexId,
                    to: right.vertexId,
                    lengthMeters: 0,
                    segmentId: null,
                });
                addArc(adjacency, {
                    id: `connector:${pairId}:backward`,
                    from: right.vertexId,
                    to: left.vertexId,
                    lengthMeters: 0,
                    segmentId: null,
                });
                connectorPairs.push([left.vertexId, right.vertexId]);
            }
        }
    });

    adjacency.forEach((arcs, vertexId) => {
        adjacency.set(vertexId, arcs.sort((left, right) => (
            compareIds(left.to, right.to) || compareIds(left.id, right.id)
        )));
    });
    segments.sort((left, right) => compareIds(left.id, right.id));

    const graph = {
        vertices,
        segments,
        segmentById: new Map(segments.map((segment) => [segment.id, segment])),
        adjacency,
        connectorPairs,
        malformedWayIds: [...new Set(malformedWayIds)].sort(compareIds),
        skippedWayCount,
        sourceNodeCount: nodeMap.size,
        sourceWayCount: wayMap.size,
    };
    assignRoadComponents(graph);
    assignLogicalStreetKeys(graph);
    graph.spatialIndex = buildSegmentSpatialIndex(
        graph.segments,
        options.spatialCellDegrees,
    );
    return graph;
}

class DisjointSet {
    constructor(values) {
        this.parent = new Map(values.map((value) => [value, value]));
    }

    find(value) {
        let root = value;
        while (this.parent.get(root) !== root) root = this.parent.get(root);
        while (this.parent.get(value) !== value) {
            const next = this.parent.get(value);
            this.parent.set(value, root);
            value = next;
        }
        return root;
    }

    union(left, right) {
        const leftRoot = this.find(left);
        const rightRoot = this.find(right);
        if (leftRoot === rightRoot) return;
        const [first, second] = [leftRoot, rightRoot].sort(compareIds);
        this.parent.set(second, first);
    }
}

function assignRoadComponents(graph) {
    const vertexIds = [...graph.vertices.keys()].sort(compareIds);
    const connected = new DisjointSet(vertexIds);
    graph.segments.forEach((segment) => connected.union(segment.startVertexId, segment.endVertexId));
    graph.connectorPairs.forEach(([left, right]) => connected.union(left, right));

    const componentVertices = new Map();
    vertexIds.forEach((vertexId) => {
        const root = connected.find(vertexId);
        componentVertices.set(root, [...(componentVertices.get(root) || []), vertexId]);
    });
    const componentSegments = new Map();
    graph.segments.forEach((segment) => {
        const root = connected.find(segment.startVertexId);
        componentSegments.set(root, [...(componentSegments.get(root) || []), segment.id]);
    });

    graph.vertexToComponent = new Map();
    graph.components = [...componentVertices.entries()]
        .map(([root, vertices]) => {
            const segmentIds = [...(componentSegments.get(root) || [])].sort(compareIds);
            const identity = segmentIds.length ? segmentIds.join('|') : vertices.sort(compareIds).join('|');
            const key = `road-component:${stableHash(identity)}`;
            vertices.forEach((vertexId) => graph.vertexToComponent.set(vertexId, key));
            return {
                key,
                vertexIds: [...vertices].sort(compareIds),
                segmentIds,
            };
        })
        .sort((left, right) => compareIds(left.key, right.key));
    graph.segments.forEach((segment) => {
        segment.componentKey = graph.vertexToComponent.get(segment.startVertexId) || null;
    });
}

function namesIntersect(left, right) {
    const rightNames = new Set(right.normalizedNames);
    return left.normalizedNames.some((name) => rightNames.has(name));
}

function assignLogicalStreetKeys(graph) {
    const segmentIds = graph.segments.map(({ id }) => id);
    const streets = new DisjointSet(segmentIds);
    const incidentSegments = new Map();
    graph.segments.forEach((segment) => {
        incidentSegments.set(segment.startVertexId, [
            ...(incidentSegments.get(segment.startVertexId) || []),
            segment.id,
        ]);
        incidentSegments.set(segment.endVertexId, [
            ...(incidentSegments.get(segment.endVertexId) || []),
            segment.id,
        ]);
    });

    const unionMatchingSegments = (leftIds, rightIds = leftIds) => {
        leftIds.forEach((leftId) => {
            rightIds.forEach((rightId) => {
                if (leftId === rightId) return;
                const left = graph.segmentById.get(leftId);
                const right = graph.segmentById.get(rightId);
                if (left?.componentKey === right?.componentKey && namesIntersect(left, right)) {
                    streets.union(leftId, rightId);
                }
            });
        });
    };
    incidentSegments.forEach((ids) => unionMatchingSegments(ids));
    graph.connectorPairs.forEach(([left, right]) => {
        unionMatchingSegments(incidentSegments.get(left) || [], incidentSegments.get(right) || []);
    });

    const groups = new Map();
    graph.segments.forEach((segment) => {
        const root = streets.find(segment.id);
        groups.set(root, [...(groups.get(root) || []), segment]);
    });
    groups.forEach((segments) => {
        const sortedIds = segments.map(({ id }) => id).sort(compareIds);
        const names = segments.flatMap(({ normalizedNames }) => normalizedNames).sort(compareIds);
        const primaryName = names[0] || 'unnamed';
        const key = `road-street:${encodeURIComponent(primaryName)}:${stableHash(sortedIds.join('|'))}`;
        segments.forEach((segment) => {
            segment.streetSegmentKey = key;
        });
    });
}

function publicSnap(snap) {
    if (!snap) return null;
    return {
        edgeId: snap.edgeId,
        segmentId: snap.segmentId,
        streetSegmentKey: snap.streetSegmentKey,
        wayId: snap.wayId,
        componentKey: snap.componentKey,
        highway: snap.highway,
        roadNames: [...snap.roadNames],
        position: snap.position,
        point: { ...snap.point },
        distanceMeters: snap.distanceMeters,
        basis: snap.basis,
    };
}

class MinHeap {
    constructor() {
        this.values = [];
    }

    push(value) {
        this.values.push(value);
        let index = this.values.length - 1;
        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);
            if (MinHeap.compare(this.values[parent], value) <= 0) break;
            this.values[index] = this.values[parent];
            index = parent;
        }
        this.values[index] = value;
    }

    pop() {
        if (!this.values.length) return null;
        const first = this.values[0];
        const last = this.values.pop();
        if (this.values.length && last) {
            let index = 0;
            while (true) {
                let child = index * 2 + 1;
                if (child >= this.values.length) break;
                if (child + 1 < this.values.length
                    && MinHeap.compare(this.values[child + 1], this.values[child]) < 0) {
                    child += 1;
                }
                if (MinHeap.compare(last, this.values[child]) <= 0) break;
                this.values[index] = this.values[child];
                index = child;
            }
            this.values[index] = last;
        }
        return first;
    }

    static compare(left, right) {
        return left.distance - right.distance || compareIds(left.vertexId, right.vertexId);
    }
}

function endpointOptions(segment, snap, role) {
    const atStart = snap.position <= POSITION_EPSILON;
    const atEnd = snap.position >= 1 - POSITION_EPSILON;
    const options = [];
    const add = (vertexId, distanceMeters, key) => {
        const existing = options.find((option) => option.vertexId === vertexId);
        if (!existing || distanceMeters < existing.distanceMeters) {
            if (existing) options.splice(options.indexOf(existing), 1);
            options.push({ vertexId, distanceMeters, key });
        }
    };

    if (role === 'source') {
        if (segment.forward || atEnd) {
            add(segment.endVertexId, (1 - snap.position) * segment.lengthMeters, 'forward');
        }
        if (segment.backward || atStart) {
            add(segment.startVertexId, snap.position * segment.lengthMeters, 'backward');
        }
    } else {
        if (segment.forward || atStart) {
            add(segment.startVertexId, snap.position * segment.lengthMeters, 'forward');
        }
        if (segment.backward || atEnd) {
            add(segment.endVertexId, (1 - snap.position) * segment.lengthMeters, 'backward');
        }
    }
    return options.sort((left, right) => (
        left.distanceMeters - right.distanceMeters
        || compareIds(left.vertexId, right.vertexId)
        || compareIds(left.key, right.key)
    ));
}

function appendPathPoint(path, point) {
    if (!point) return;
    const previous = path[path.length - 1];
    if (previous
        && Math.abs(previous.lat - point.lat) <= POSITION_EPSILON
        && Math.abs(previous.lng - point.lng) <= POSITION_EPSILON) return;
    path.push({ lat: Number(point.lat), lng: Number(point.lng) });
}

function buildShortestPathTree(graph, sourceSnap) {
    const sourceSegment = graph.segmentById.get(sourceSnap.segmentId);
    if (!sourceSegment) return null;
    const sources = endpointOptions(sourceSegment, sourceSnap, 'source');
    if (!sources.length) return null;
    const distances = new Map();
    const predecessors = new Map();
    const sourceAt = new Map();
    const heap = new MinHeap();
    sources.forEach((source) => {
        const current = distances.get(source.vertexId);
        if (current === undefined || source.distanceMeters < current) {
            distances.set(source.vertexId, source.distanceMeters);
            sourceAt.set(source.vertexId, source);
            predecessors.delete(source.vertexId);
            heap.push({ vertexId: source.vertexId, distance: source.distanceMeters });
        }
    });

    while (heap.values.length) {
        const current = heap.pop();
        if (!current || current.distance !== distances.get(current.vertexId)) continue;
        (graph.adjacency.get(current.vertexId) || []).forEach((arc) => {
            const candidateDistance = current.distance + arc.lengthMeters;
            const knownDistance = distances.get(arc.to);
            if (knownDistance !== undefined
                && candidateDistance >= knownDistance - POSITION_EPSILON) return;
            distances.set(arc.to, candidateDistance);
            predecessors.set(arc.to, { previous: current.vertexId, arc });
            heap.push({ vertexId: arc.to, distance: candidateDistance });
        });
    }
    return { distances, predecessors, sourceAt };
}

function shortestNetworkRoute(graph, leftSnap, rightSnap, sourceTreeFor) {
    const leftSegment = graph.segmentById.get(leftSnap.segmentId);
    const rightSegment = graph.segmentById.get(rightSnap.segmentId);
    if (!leftSegment || !rightSegment) return null;

    if (leftSegment.id === rightSegment.id) {
        const delta = rightSnap.position - leftSnap.position;
        if ((delta >= -POSITION_EPSILON && leftSegment.forward)
            || (delta <= POSITION_EPSILON && leftSegment.backward)
            || Math.abs(delta) <= POSITION_EPSILON) {
            return {
                distanceMeters: Math.abs(delta) * leftSegment.lengthMeters,
                path: [{ ...leftSnap.point }, { ...rightSnap.point }],
            };
        }
    }

    const targets = endpointOptions(rightSegment, rightSnap, 'target');
    if (!targets.length) return null;
    const tree = sourceTreeFor(leftSnap);
    if (!tree) return null;
    let best = null;
    targets.forEach((target) => {
        const sourceDistance = tree.distances.get(target.vertexId);
        if (sourceDistance === undefined) return;
        const distanceMeters = sourceDistance + target.distanceMeters;
        const tieKey = `${target.vertexId}:${target.key}`;
        if (!best
            || distanceMeters < best.distanceMeters - POSITION_EPSILON
            || (Math.abs(distanceMeters - best.distanceMeters) <= POSITION_EPSILON
                && compareIds(tieKey, best.tieKey) < 0)) {
            best = {
                distanceMeters,
                target,
                targetVertexId: target.vertexId,
                tieKey,
            };
        }
    });

    if (!best) return null;
    const reversedArcs = [];
    let rootVertexId = best.targetVertexId;
    while (tree.predecessors.has(rootVertexId)) {
        const predecessor = tree.predecessors.get(rootVertexId);
        reversedArcs.push(predecessor.arc);
        rootVertexId = predecessor.previous;
    }
    const source = tree.sourceAt.get(rootVertexId);
    if (!source) return null;

    const path = [];
    appendPathPoint(path, leftSnap.point);
    appendPathPoint(path, graph.vertices.get(source.vertexId));
    reversedArcs.reverse().forEach((arc) => {
        appendPathPoint(path, graph.vertices.get(arc.from));
        appendPathPoint(path, graph.vertices.get(arc.to));
    });
    appendPathPoint(path, graph.vertices.get(best.target.vertexId));
    appendPathPoint(path, rightSnap.point);
    return { distanceMeters: best.distanceMeters, path };
}

function fallbackStreetKey(value) {
    const street = normalizeStreetName(streetNameFrom(value));
    const city = String(value?.city ?? value?.address?.city ?? '').trim().toLowerCase();
    const zip = String(value?.zip_code ?? value?.zip ?? value?.postal_code ?? '').trim().toLowerCase();
    if (street) return `address-street:${encodeURIComponent([street, city, zip].join('|'))}`;
    const point = pointFrom(value);
    return point
        ? `geo-point:${point.lat.toFixed(5)}:${point.lng.toFixed(5)}`
        : 'unroutable-point';
}

/**
 * Builds a synchronous, immutable routing context from already-fetched OSM
 * Overpass-style nodes and ways. The module performs no network requests.
 *
 * `distanceBetween` returns miles. `routeBetween` also exposes meters, the
 * road geometry, snap diagnostics, and whether the deterministic aerial
 * fallback was required.
 */
export function createRoadNetworkRoutingContext(input = {}) {
    const allowedHighways = new Set(
        [...(input.allowedHighways || DEFAULT_ROUTABLE_HIGHWAYS)]
            .map((value) => String(value).toLowerCase()),
    );
    const maxSnapDistanceMeters = Number.isFinite(Number(input.maxSnapDistanceMeters))
        ? Math.max(1, Number(input.maxSnapDistanceMeters))
        : 300;
    const maxStreetNameDetourMeters = Number.isFinite(Number(input.maxStreetNameDetourMeters))
        ? Math.max(0, Number(input.maxStreetNameDetourMeters))
        : 100;
    const fallbackRoadFactor = Number.isFinite(Number(input.fallbackRoadFactor))
        ? Math.max(1, Number(input.fallbackRoadFactor))
        : 1.3;
    const spatialCellDegrees = Number.isFinite(Number(input.spatialCellDegrees))
        ? Math.min(1, Math.max(0.0001, Number(input.spatialCellDegrees)))
        : DEFAULT_SPATIAL_CELL_DEGREES;
    const useSpatialIndex = input.useSpatialIndex !== false;
    const includeSnapApproach = input.includeSnapApproach !== false;
    const graph = buildRoadGraph(input, { allowedHighways, spatialCellDegrees });
    const objectSnapCache = new WeakMap();
    const valueSnapCache = new Map();
    const routeCache = new Map();
    const sourceTreeCache = new Map();
    let dijkstraRunCount = 0;
    let snapCandidateEvaluationCount = 0;
    let spatialIndexQueryCount = 0;

    function internalSnapFor(value) {
        if (value && typeof value === 'object' && objectSnapCache.has(value)) {
            return objectSnapCache.get(value);
        }
        const cacheKey = locationCacheKey(value);
        if (!cacheKey) return null;
        if (valueSnapCache.has(cacheKey)) {
            const cached = valueSnapCache.get(cacheKey);
            if (value && typeof value === 'object') objectSnapCache.set(value, cached);
            return cached;
        }

        const point = pointFrom(value);
        const requestedStreet = normalizeStreetName(streetNameFrom(value));
        const candidateSegments = useSpatialIndex
            ? graph.spatialIndex.query(point, maxSnapDistanceMeters)
            : graph.segments;
        if (useSpatialIndex) spatialIndexQueryCount += 1;
        snapCandidateEvaluationCount += candidateSegments.length;
        const ranked = candidateSegments.map((segment) => {
            const projection = projectPointToSegment(point, segment.start, segment.end);
            return {
                segment,
                ...projection,
                nameMatch: requestedStreet
                    ? segment.normalizedNames.includes(requestedStreet)
                    : false,
            };
        }).sort((left, right) => (
            left.distanceMeters - right.distanceMeters
            || compareIds(left.segment.id, right.segment.id)
        ));
        const nearest = ranked[0];
        const named = requestedStreet
            ? ranked
                .filter(({ nameMatch }) => nameMatch)
                .sort((left, right) => (
                    left.distanceMeters - right.distanceMeters
                    || compareIds(left.segment.id, right.segment.id)
                ))[0]
            : null;
        const selected = named
            && named.distanceMeters <= maxSnapDistanceMeters
            && named.distanceMeters <= (nearest?.distanceMeters ?? Infinity) + maxStreetNameDetourMeters
            ? named
            : nearest;
        const snap = !selected || selected.distanceMeters > maxSnapDistanceMeters
            ? null
            : Object.freeze({
                cacheKey,
                edgeId: selected.segment.edgeId,
                segmentId: selected.segment.id,
                streetSegmentKey: selected.segment.streetSegmentKey,
                wayId: selected.segment.wayId,
                componentKey: selected.segment.componentKey,
                highway: selected.segment.highway,
                roadNames: selected.segment.names.map(({ display }) => display),
                position: selected.position,
                point: Object.freeze({ ...selected.point }),
                distanceMeters: selected.distanceMeters,
                basis: selected === named ? 'street_name' : 'nearest',
            });
        valueSnapCache.set(cacheKey, snap);
        if (value && typeof value === 'object') objectSnapCache.set(value, snap);
        return snap;
    }

    function fallbackRoute(left, right, reason, leftSnap = null, rightSnap = null) {
        const leftPoint = pointFrom(left);
        const rightPoint = pointFrom(right);
        if (!leftPoint || !rightPoint) {
            return {
                distanceMeters: Number.POSITIVE_INFINITY,
                distanceMiles: Number.POSITIVE_INFINITY,
                path: [],
                usedFallback: true,
                reason: 'INVALID_POINT',
                fromSnap: publicSnap(leftSnap),
                toSnap: publicSnap(rightSnap),
            };
        }
        const distanceMeters = haversineMeters(leftPoint, rightPoint) * fallbackRoadFactor;
        return {
            distanceMeters,
            distanceMiles: distanceMeters / METERS_PER_MILE,
            path: [leftPoint, rightPoint],
            usedFallback: true,
            reason,
            fromSnap: publicSnap(leftSnap),
            toSnap: publicSnap(rightSnap),
        };
    }

    function sourceTreeFor(snap) {
        const sourceKey = [
            snap.cacheKey,
            snap.segmentId,
            snap.position.toFixed(12),
        ].join('|');
        if (sourceTreeCache.has(sourceKey)) return sourceTreeCache.get(sourceKey);
        const tree = buildShortestPathTree(graph, snap);
        sourceTreeCache.set(sourceKey, tree);
        dijkstraRunCount += 1;
        return tree;
    }

    function routeBetween(left, right) {
        const leftPoint = pointFrom(left);
        const rightPoint = pointFrom(right);
        if (!leftPoint || !rightPoint) return fallbackRoute(left, right, 'INVALID_POINT');
        if (leftPoint.lat === rightPoint.lat && leftPoint.lng === rightPoint.lng) {
            return {
                distanceMeters: 0,
                distanceMiles: 0,
                path: [leftPoint],
                usedFallback: false,
                reason: null,
                fromSnap: publicSnap(internalSnapFor(left)),
                toSnap: publicSnap(internalSnapFor(right)),
            };
        }

        const leftSnap = internalSnapFor(left);
        const rightSnap = internalSnapFor(right);
        const leftKey = locationCacheKey(left);
        const rightKey = locationCacheKey(right);
        const routeKey = `${leftKey}->${rightKey}`;
        if (routeCache.has(routeKey)) return routeCache.get(routeKey);

        let result;
        if (!graph.segments.length) {
            result = fallbackRoute(left, right, 'NO_ROAD_NETWORK', leftSnap, rightSnap);
        } else if (!leftSnap || !rightSnap) {
            result = fallbackRoute(left, right, 'UNSNAPPED_POINT', leftSnap, rightSnap);
        } else if (leftSnap.componentKey !== rightSnap.componentKey) {
            result = fallbackRoute(left, right, 'DISCONNECTED_ROAD_COMPONENTS', leftSnap, rightSnap);
        } else {
            const networkRoute = shortestNetworkRoute(graph, leftSnap, rightSnap, sourceTreeFor);
            if (!networkRoute) {
                result = fallbackRoute(left, right, 'NO_DIRECTED_PATH', leftSnap, rightSnap);
            } else {
                const approachMeters = includeSnapApproach
                    ? leftSnap.distanceMeters + rightSnap.distanceMeters
                    : 0;
                const path = [];
                appendPathPoint(path, leftPoint);
                networkRoute.path.forEach((point) => appendPathPoint(path, point));
                appendPathPoint(path, rightPoint);
                const distanceMeters = networkRoute.distanceMeters + approachMeters;
                result = {
                    distanceMeters,
                    distanceMiles: distanceMeters / METERS_PER_MILE,
                    path,
                    usedFallback: false,
                    reason: null,
                    fromSnap: publicSnap(leftSnap),
                    toSnap: publicSnap(rightSnap),
                };
            }
        }
        const frozen = Object.freeze({
            ...result,
            path: Object.freeze(result.path.map((point) => Object.freeze({ ...point }))),
        });
        routeCache.set(routeKey, frozen);
        return frozen;
    }

    const suppliedPoints = [
        ...(Array.isArray(input.properties) ? input.properties : []),
        input.startLocation ?? input.start,
        input.endLocation ?? input.end,
    ].filter(Boolean);
    const initialSnaps = suppliedPoints.map((value) => internalSnapFor(value));
    const snappedPointCount = initialSnaps.filter(Boolean).length;
    const status = !graph.segments.length
        ? 'unavailable'
        : snappedPointCount < suppliedPoints.length
            ? 'degraded'
            : 'ready';
    const warnings = [];
    if (graph.malformedWayIds.length) {
        warnings.push({
            code: 'MALFORMED_OSM_WAYS',
            wayIds: [...graph.malformedWayIds],
        });
    }
    if (suppliedPoints.length && snappedPointCount < suppliedPoints.length) {
        warnings.push({
            code: 'UNSNAPPED_ROUTE_POINTS',
            count: suppliedPoints.length - snappedPointCount,
        });
    }

    return Object.freeze({
        status,
        distanceUnit: 'miles',
        distanceBetween(left, right) {
            return routeBetween(left, right).distanceMiles;
        },
        distanceBetweenMeters(left, right) {
            return routeBetween(left, right).distanceMeters;
        },
        routeBetween,
        pathBetween(left, right) {
            return routeBetween(left, right).path.map((point) => ({ ...point }));
        },
        snapFor(value) {
            return publicSnap(internalSnapFor(value));
        },
        streetSegmentKey(value) {
            return internalSnapFor(value)?.streetSegmentKey || fallbackStreetKey(value);
        },
        roadComponentKey(value) {
            return internalSnapFor(value)?.componentKey || null;
        },
        diagnostics: Object.freeze({
            sourceNodeCount: graph.sourceNodeCount,
            sourceWayCount: graph.sourceWayCount,
            routableSegmentCount: graph.segments.length,
            roadComponentCount: graph.components.length,
            skippedWayCount: graph.skippedWayCount,
            malformedWayIds: Object.freeze([...graph.malformedWayIds]),
            suppliedPointCount: suppliedPoints.length,
            snappedPointCount,
            maxSnapDistanceMeters,
            fallbackRoadFactor,
            spatialIndexEnabled: useSpatialIndex,
            spatialIndexCellCount: graph.spatialIndex.cellCount,
            spatialIndexOverflowSegmentCount: graph.spatialIndex.overflowSegmentCount,
            warnings: Object.freeze(warnings),
            get dijkstraRunCount() {
                return dijkstraRunCount;
            },
            get cachedSourceTreeCount() {
                return sourceTreeCache.size;
            },
            get snapCandidateEvaluationCount() {
                return snapCandidateEvaluationCount;
            },
            get spatialIndexQueryCount() {
                return spatialIndexQueryCount;
            },
        }),
    });
}

export const roadNetworkRoutingInternals = Object.freeze({
    edgeIdFor,
    normalizeStreetName,
});
