import React, { useMemo } from 'react';
import L from 'leaflet';
import { Marker, Polyline, Tooltip, useMap } from 'react-leaflet';
import { calculatePolygonAreaSqMi } from '@/components/logic/canvasZones';

const ROAD_CACHE = new Map();
const MILES_PER_METER = 0.000621371;

function handleIcon() {
  return L.divIcon({
    className: 'canvas-boundary-handle',
    html: '<div style="width:18px;height:18px;border-radius:999px;background:white;border:3px solid #111;box-shadow:0 0 0 2px rgba(168,85,247,.75),0 8px 18px rgba(0,0,0,.45)"></div>',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function distanceMeters(a, b) {
  const lat = ((a.lat + b.lat) / 2) * Math.PI / 180;
  const dx = (a.lng - b.lng) * 111320 * Math.cos(lat);
  const dy = (a.lat - b.lat) * 110540;
  return Math.sqrt(dx * dx + dy * dy);
}

function movePointAlongNormal(point, normal, meters) {
  const latRad = point.lat * Math.PI / 180;
  return {
    lat: point.lat + (normal.lat * meters) / 110540,
    lng: point.lng + (normal.lng * meters) / (111320 * Math.cos(latRad)),
  };
}

function lineMidpoint(a, b) {
  return { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
}

function normalizePoint(point) {
  return { lat: Number(point.lat ?? point[0]), lng: Number(point.lng ?? point[1]) };
}

function getEdges(zone) {
  const parts = zone.parts?.length ? zone.parts : [zone.geometry];
  return parts.flatMap((part, partIndex) => {
    if (!part?.length) return [];
    return part.map((point, index) => ({
      zone,
      partIndex,
      index,
      a: point,
      b: part[(index + 1) % part.length],
      mid: lineMidpoint(point, part[(index + 1) % part.length]),
    }));
  });
}

function findSharedBoundaries(zones) {
  const edges = zones.flatMap(getEdges);
  const pairs = [];
  for (let i = 0; i < edges.length; i += 1) {
    for (let j = i + 1; j < edges.length; j += 1) {
      if (edges[i].zone.zone_number === edges[j].zone.zone_number) continue;
      const sameDirection = distanceMeters(edges[i].a, edges[j].a) < 20 && distanceMeters(edges[i].b, edges[j].b) < 20;
      const oppositeDirection = distanceMeters(edges[i].a, edges[j].b) < 20 && distanceMeters(edges[i].b, edges[j].a) < 20;
      if (sameDirection || oppositeDirection) {
        pairs.push({
          id: `${edges[i].zone.zone_number}-${edges[j].zone.zone_number}-${edges[i].index}-${edges[j].index}`,
          left: edges[i],
          right: edges[j],
          a: edges[i].a,
          b: edges[i].b,
          mid: lineMidpoint(edges[i].a, edges[i].b),
        });
      }
    }
  }
  return pairs;
}

async function fetchNearbyRoads(point) {
  const key = `${point.lat.toFixed(3)},${point.lng.toFixed(3)}`;
  if (ROAD_CACHE.has(key)) return ROAD_CACHE.get(key);
  const delta = 0.01;
  const query = `[out:json][timeout:8];way["highway"](${point.lat - delta},${point.lng - delta},${point.lat + delta},${point.lng + delta});out geom;`;
  const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    const roads = (data.elements || []).flatMap((way) => (way.geometry || []).slice(1).map((node, index) => ({
      a: normalizePoint(way.geometry[index]),
      b: normalizePoint(node),
    })));
    ROAD_CACHE.set(key, roads);
    return roads;
  } catch {
    ROAD_CACHE.set(key, []);
    return [];
  }
}

function nearestPointOnSegment(point, a, b) {
  const lat = point.lat * Math.PI / 180;
  const ax = a.lng * 111320 * Math.cos(lat);
  const ay = a.lat * 110540;
  const bx = b.lng * 111320 * Math.cos(lat);
  const by = b.lat * 110540;
  const px = point.lng * 111320 * Math.cos(lat);
  const py = point.lat * 110540;
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / Math.max(1, dx * dx + dy * dy)));
  return { lat: (ay + dy * t) / 110540, lng: (ax + dx * t) / (111320 * Math.cos(lat)) };
}

function snapToGrid(point) {
  const meters = 50;
  return {
    lat: Math.round((point.lat * 110540) / meters) * meters / 110540,
    lng: Math.round((point.lng * 111320 * Math.cos(point.lat * Math.PI / 180)) / meters) * meters / (111320 * Math.cos(point.lat * Math.PI / 180)),
  };
}

async function snapPoint(point) {
  const roads = await fetchNearbyRoads(point);
  let best = null;
  roads.forEach((road) => {
    const snapped = nearestPointOnSegment(point, road.a, road.b);
    const distance = distanceMeters(point, snapped);
    if (!best || distance < best.distance) best = { point: snapped, distance };
  });
  return best && best.distance <= 100 ? best.point : snapToGrid(point);
}

function updateZoneForBoundary(zone, partIndex, edgeIndex, newA, newB, density) {
  const parts = (zone.parts?.length ? zone.parts : [zone.geometry]).map((part) => [...(part || [])]);
  const geometry = parts[partIndex];
  if (!geometry || geometry.length < 3) return zone;
  geometry[edgeIndex] = newA;
  geometry[(edgeIndex + 1) % geometry.length] = newB;
  const totalArea = parts.reduce((sum, part) => sum + calculatePolygonAreaSqMi(part), 0);
  const allPoints = parts.flat();
  return {
    ...zone,
    manual_adjusted: true,
    geometry: parts[0] || [],
    parts,
    area_sq_mi: Number(totalArea.toFixed(2)),
    estimated_doors: Math.max(1, Math.round(totalArea * density)),
    drop_point: allPoints.reduce((best, point) => !best || point.lat > best.lat || (Math.abs(point.lat - best.lat) < 0.000001 && point.lng < best.lng) ? point : best, null),
  };
}

export default function CanvasBoundaryHandles({ zones = [] }) {
  const map = useMap();
  const boundaries = useMemo(() => findSharedBoundaries(zones), [zones]);

  const handleDragEnd = async (boundary, event) => {
    const snappedMid = await snapPoint(event.target.getLatLng());
    const originalMid = boundary.mid;
    const edgeLat = boundary.b.lat - boundary.a.lat;
    const edgeLng = boundary.b.lng - boundary.a.lng;
    const normal = { lat: -edgeLng, lng: edgeLat };
    const normalLength = Math.max(0.0000001, Math.sqrt(normal.lat * normal.lat + normal.lng * normal.lng));
    const unitNormal = { lat: normal.lat / normalLength, lng: normal.lng / normalLength };
    const movedMeters = distanceMeters(originalMid, snappedMid);
    const direction = ((snappedMid.lat - originalMid.lat) * unitNormal.lat + (snappedMid.lng - originalMid.lng) * unitNormal.lng) >= 0 ? 1 : -1;
    const offset = Math.min(180, movedMeters) * direction;
    const newA = movePointAlongNormal(boundary.a, unitNormal, offset);
    const newB = movePointAlongNormal(boundary.b, unitNormal, offset);
    const nextZones = zones.map((zone) => {
      if (zone.zone_number === boundary.left.zone.zone_number) return updateZoneForBoundary(zone, boundary.left.partIndex, boundary.left.index, newA, newB, zone.density_doors_per_sq_mi || 150);
      if (zone.zone_number === boundary.right.zone.zone_number) return updateZoneForBoundary(zone, boundary.right.partIndex, boundary.right.index, newB, newA, zone.density_doors_per_sq_mi || 150);
      return zone;
    });
    localStorage.setItem('fk_canvasZones', JSON.stringify(nextZones));
    window.dispatchEvent(new CustomEvent('fk-canvas-zones-updated', { detail: { zones: nextZones } }));
    window.dispatchEvent(new CustomEvent('fk-canvas-zones-manually-adjusted', { detail: { zones: nextZones } }));
    map.dragging.enable();
  };

  return (
    <>
      {boundaries.map((boundary) => (
        <React.Fragment key={boundary.id}>
          <Polyline positions={[boundary.a, boundary.b]} pathOptions={{ color: '#FFFFFF', weight: 1, opacity: 0.55, dashArray: '4,8' }} />
          <Marker
            position={boundary.mid}
            icon={handleIcon()}
            draggable
            eventHandlers={{
              dragstart: () => map.dragging.disable(),
              dragend: (event) => handleDragEnd(boundary, event),
            }}
          >
            <Tooltip direction="top">Drag to adjust shared boundary</Tooltip>
          </Marker>
        </React.Fragment>
      ))}
    </>
  );
}