import React, { useMemo, useState, useEffect } from 'react';
import { GeoJSON, Tooltip, useMap, useMapEvents } from 'react-leaflet';

/**
 * Draws real zip code boundary polygons from OpenDataDE GeoJSON files.
 * Falls back to convex-hull approximation if real boundaries can't be loaded.
 *
 * Refreshed styling: the polygons are non-interactive so they can never swallow a
 * tap meant for a property pin, the fill is light enough to read street detail
 * through, and the permanent ZIP labels only appear once the map is zoomed in far
 * enough for them not to pile on top of each other.
 */
const LABEL_MIN_ZOOM = 9;

const BOUNDARY_STYLE = (color) => ({
    color,
    weight: 1.5,
    opacity: 0.85,
    fillColor: color,
    fillOpacity: 0.05,
    dashArray: '8,6',
});

function ZipLabel({ zip, count }) {
    return (
        <Tooltip permanent direction="center" className="zip-label-tooltip">
            <span style={{ color: '#fff', fontWeight: 800, fontSize: '12px', letterSpacing: '0.5px' }}>{zip}</span>
            <br />
            <span style={{ color: '#999', fontSize: '9px', fontWeight: 600 }}>{count.toLocaleString()} homes</span>
        </Tooltip>
    );
}

/** Current zoom, so labels can be hidden when the view is too wide for them. */
function useZoomLevel() {
    const map = useMap();
    const [zoom, setZoom] = useState(() => map.getZoom());
    useMapEvents({ zoomend: () => setZoom(map.getZoom()) });
    return zoom;
}

const ZIP_COLORS = [
    '#FFD700', '#3b82f6', '#22c55e', '#ef4444', '#8b5cf6',
    '#f97316', '#06b6d4', '#ec4899', '#14b8a6', '#eab308',
    '#6366f1', '#f43f5e', '#10b981', '#a855f7', '#84cc16',
];

// Simple convex hull (Graham scan) — fallback
function convexHull(points) {
    if (points.length < 3) return points;
    const sorted = [...points].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const p of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
    }
    const upper = [];
    for (const p of sorted.reverse()) {
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
        upper.push(p);
    }
    upper.pop();
    lower.pop();
    return lower.concat(upper);
}

// Cache for fetched state GeoJSON files
const geoJsonCache = {};

async function fetchStateZipBoundaries(stateAbbr) {
    const key = stateAbbr.toLowerCase();
    if (geoJsonCache[key]) return geoJsonCache[key];
    
    try {
        const url = `https://raw.githubusercontent.com/OpenDataDE/State-zip-code-GeoJSON/master/${key}_${stateAbbr.toLowerCase()}_zip_codes_geo.min.json`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        geoJsonCache[key] = data;
        return data;
    } catch (e) {
        console.warn(`[ZipOverlay] Failed to fetch boundaries for ${stateAbbr}:`, e.message);
        return null;
    }
}

function FallbackZipPolygons({ zipGroups, showLabels }) {
    return (
        <>
            {zipGroups.map((z, idx) => {
                if (z.hull.length < 3) return null;
                const color = ZIP_COLORS[idx % ZIP_COLORS.length];
                return (
                    <GeoJSON
                        key={z.zip}
                        interactive={false}
                        data={{
                            type: 'Feature',
                            geometry: {
                                type: 'Polygon',
                                coordinates: [z.hull.map(p => [p[1], p[0]])] // GeoJSON is [lng, lat]
                            },
                            properties: { zip: z.zip, count: z.count }
                        }}
                        style={() => BOUNDARY_STYLE(color)}
                    >
                        {showLabels && <ZipLabel zip={z.zip} count={z.count} />}
                    </GeoJSON>
                );
            })}
        </>
    );
}

function RealBoundaryFeature({ feature, color, count, showLabel }) {
    return (
        <GeoJSON data={feature} interactive={false} style={() => BOUNDARY_STYLE(color)}>
            {showLabel && (
                <ZipLabel
                    zip={feature.properties.ZCTA5CE10 || feature.properties.ZCTA5CE20 || feature.properties.zip || '?'}
                    count={count}
                />
            )}
        </GeoJSON>
    );
}

export default function ZipCodeOverlay({ properties = [] }) {
    const [realBoundaries, setRealBoundaries] = useState(null);
    const [loadFailed, setLoadFailed] = useState(false);
    const zoom = useZoomLevel();
    const showLabels = zoom >= LABEL_MIN_ZOOM;

    // Group properties by zip and compute stats
    const { zipGroups, states, zipCountMap } = useMemo(() => {
        const byZip = {};
        const stateSet = new Set();
        properties.forEach(p => {
            const zip = String(p.zip_code || '').trim().slice(0, 5);
            if (!zip || !p.lat || !p.lng) return;
            if (!byZip[zip]) byZip[zip] = [];
            byZip[zip].push([p.lat, p.lng]);
            if (p.state) stateSet.add(p.state.toUpperCase());
        });

        const groups = [];
        const countMap = {};
        const zips = Object.keys(byZip).sort();
        zips.forEach((zip) => {
            const pts = byZip[zip];
            countMap[zip] = pts.length;
            if (pts.length < 3) return;
            const hull = convexHull(pts);
            if (hull.length < 3) return;
            groups.push({ zip, hull, count: pts.length });
        });

        return { zipGroups: groups, states: [...stateSet], zipCountMap: countMap };
    }, [properties]);

    // Try to load real boundaries
    useEffect(() => {
        if (states.length === 0 || zipGroups.length === 0) return;
        
        let cancelled = false;
        
        async function load() {
            // Load GeoJSON for each state we have properties in
            const allFeatures = [];
            const targetZips = new Set(zipGroups.map(z => z.zip));
            
            for (const state of states) {
                const geoData = await fetchStateZipBoundaries(state);
                if (cancelled) return;
                if (!geoData || !geoData.features) continue;
                
                // Filter to only our zip codes
                for (const feature of geoData.features) {
                    const fZip = feature.properties?.ZCTA5CE10 || feature.properties?.ZCTA5CE20 || '';
                    if (targetZips.has(fZip)) {
                        allFeatures.push(feature);
                    }
                }
            }
            
            if (cancelled) return;
            
            if (allFeatures.length > 0) {
                setRealBoundaries(allFeatures);
            } else {
                setLoadFailed(true);
            }
        }
        
        load().catch(() => { if (!cancelled) setLoadFailed(true); });
        return () => { cancelled = true; };
    }, [states.join(','), zipGroups.length]);

    if (zipGroups.length === 0) return null;

    // Use real boundaries if available, otherwise fallback
    if (realBoundaries && realBoundaries.length > 0 && !loadFailed) {
        return (
            <>
                {realBoundaries.map((feature, idx) => {
                    const fZip = feature.properties?.ZCTA5CE10 || feature.properties?.ZCTA5CE20 || '';
                    const color = ZIP_COLORS[idx % ZIP_COLORS.length];
                    const count = zipCountMap[fZip] || 0;
                    return (
                        <RealBoundaryFeature
                            key={fZip || idx}
                            feature={feature}
                            color={color}
                            count={count}
                            showLabel={showLabels}
                        />
                    );
                })}
            </>
        );
    }

    // Fallback to convex hull
    return <FallbackZipPolygons zipGroups={zipGroups} showLabels={showLabels} />;
}