import turf from 'turf';

/**
 * Previously-pulled Precision areas overlap constantly — managers re-pull over
 * the same neighborhood. Drawing each one separately stacked translucent fills
 * into an unreadable blob and made taps ambiguous, so overlapping areas are
 * dissolved into a single coverage shape before they reach the map.
 */

const toFeature = (polygon) => {
  const ring = polygon.map((point) => [Number(point.lng), Number(point.lat)]);
  const [firstLng, firstLat] = ring[0];
  const [lastLng, lastLat] = ring[ring.length - 1];
  if (firstLng !== lastLng || firstLat !== lastLat) ring.push([firstLng, firstLat]);
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
};

const toLatLngs = (feature) => {
  const geometry = feature?.geometry;
  if (geometry?.type !== 'Polygon') return null;
  const ring = geometry.coordinates?.[0] || [];
  if (ring.length < 4) return null;
  return ring.slice(0, -1).map(([lng, lat]) => ({ lat, lng }));
};

const entryTime = (entry) => {
  const time = new Date(entry?.last_pull_date || entry?.updated_at || entry?.date || 0).getTime();
  return Number.isFinite(time) ? time : 0;
};

/**
 * Dissolves overlapping/touching areas into single shapes.
 * @returns {Array<{ polygon: Array<{lat:number,lng:number}>, members: Array<object>, newest: object }>}
 */
export function mergePulledAreas(entries = []) {
  const clusters = entries
    .filter((entry) => Array.isArray(entry?.polygon) && entry.polygon.length >= 3)
    .map((entry) => ({ feature: toFeature(entry.polygon), members: [entry] }));

  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < clusters.length && !merged; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        let union = null;
        try { union = turf.union(clusters[i].feature, clusters[j].feature); } catch { union = null; }
        // A MultiPolygon result means the two areas are disjoint — leave them apart.
        if (union?.geometry?.type !== 'Polygon') continue;
        clusters[i] = { feature: union, members: [...clusters[i].members, ...clusters[j].members] };
        clusters.splice(j, 1);
        merged = true;
        break;
      }
    }
  }

  return clusters.map((cluster) => {
    const polygon = toLatLngs(cluster.feature) || cluster.members[0].polygon;
    const newest = [...cluster.members].sort((a, b) => entryTime(b) - entryTime(a))[0];
    return { polygon, members: cluster.members, newest };
  });
}