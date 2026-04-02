import React, { useMemo, useState, useEffect } from 'react';
import { GeoJSON, Tooltip, useMap } from 'react-leaflet';

/**
 * Draws real zip code boundary polygons from OpenDataDE GeoJSON files.
 * Falls back to convex-hull approximation if real boundaries can't be loaded.
 */

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

function FallbackZipPolygons({ zipGroups }) {
    return (
        <>
            {zipGroups.map((z, idx) => {
                if (z.hull.length < 3) return null;
                const color = ZIP_COLORS[idx % ZIP_COLORS.length];
                return (
                    <GeoJSON
                        key={z.zip}
                        data={{
                            type: 'Feature',
                            geometry: {
                                type: 'Polygon',
                                coordinates: [z.hull.map(p => [p[1], p[0]])] // GeoJSON is [lng, lat]
                            },
                            properties: { zip: z.zip, count: z.count }
                        }}
                        style={() => ({
                            color,
                            weight: 2,
                            fillColor: color,
                            fillOpacity: 0.08,
                            dashArray: '6,4'
                        })}
                    >
                        <Tooltip permanent direction="center" className="zip-label-tooltip">
                            <span style={{ color, fontWeight: 800, fontSize: '13px', textShadow: '0 0 6px rgba(0,0,0,0.9)', letterSpacing: '0.5px' }}>
                                {z.zip}
                            </span>
                            <br />
                            <span style={{ color: '#999', fontSize: '9px', fontWeight: 600 }}>
                                {z.count.toLocaleString()} homes
                            </span>
                        </Tooltip>
                    </GeoJSON>
                );
            })}
        </>
    );
}

function RealBoundaryFeature({ feature, color, count }) {
    return (
        <GeoJSON
            data={feature}
            style={() => ({
                color,
                weight: 2,
                fillColor: color,
                fillOpacity: 0.08,
                dashArray: '6,4'
            })}
        >
            <Tooltip permanent direction="center" className="zip-label-tooltip">
                <span style={{ color, fontWeight: 800, fontSize: '13px', textShadow: '0 0 6px rgba(0,0,0,0.9)', letterSpacing: '0.5px' }}>
                    {feature.properties.ZCTA5CE10 || feature.properties.ZCTA5CE20 || feature.properties.zip || '?'}
                </span>
                <br />
                <span style={{ color: '#999', fontSize: '9px', fontWeight: 600 }}>
                    {count.toLocaleString()} homes
                </span>
            </Tooltip>
        </GeoJSON>
    );
}

export default function ZipCodeOverlay({ properties = [] }) {
    const [realBoundaries, setRealBoundaries] = useState(null);
    const [loadFailed, setLoadFailed] = useState(false);

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
                        />
                    );
                })}
            </>
        );
    }

    // Fallback to convex hull
    return <FallbackZipPolygons zipGroups={zipGroups} />;
}