// @ts-nocheck
import React, { useMemo } from 'react';
import { Source, Layer, Marker } from 'react-map-gl/maplibre';

/**
 * Draws zip code boundary polygons derived from property locations.
 * Uses convex hull of properties in each zip to approximate boundaries.
 */

// Simple convex hull (Graham scan) expecting points as [lng, lat]
function convexHull(points) {
    if (points.length < 3) return points;

    const sorted = [...points].sort((a, b) => a[1] - b[1] || a[0] - b[0]);

    const cross = (o, a, b) =>
        (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

    const lower = [];
    for (const p of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
            lower.pop();
        lower.push(p);
    }

    const upper = [];
    for (const p of sorted.reverse()) {
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
            upper.pop();
        upper.push(p);
    }

    upper.pop();
    lower.pop();
    const hull = lower.concat(upper);
    
    // Ensure polygon is closed for GeoJSON
    if (hull.length > 0) {
        hull.push([...hull[0]]);
    }
    return hull;
}

const ZIP_COLORS = [
    '#FFD700', '#3b82f6', '#22c55e', '#ef4444', '#8b5cf6',
    '#f97316', '#06b6d4', '#ec4899', '#14b8a6', '#eab308',
    '#6366f1', '#f43f5e', '#10b981', '#a855f7', '#84cc16',
];

export default function ZipCodeOverlay({ properties = [] }) {
    const { geoData, labels } = useMemo(() => {
        // Group properties by zip
        const byZip = {};
        properties.forEach(p => {
            const zip = String(p.zip_code || '').trim().slice(0, 5);
            if (!zip || !p.lat || !p.lng) return;
            if (!byZip[zip]) byZip[zip] = [];
            byZip[zip].push([p.lng, p.lat]); // Store as [lng, lat] for MapLibre
        });

        // Build convex hull for each zip
        const features = [];
        const labelData = [];
        const zips = Object.keys(byZip).sort();
        
        zips.forEach((zip, idx) => {
            const pts = byZip[zip];
            if (pts.length < 3) return;

            const hull = convexHull(pts);
            if (hull.length < 3) return;

            // Compute centroid for label
            const centLng = pts.reduce((s, p) => s + p[0], 0) / pts.length;
            const centLat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
            const color = ZIP_COLORS[idx % ZIP_COLORS.length];

            features.push({
                type: 'Feature',
                geometry: {
                    type: 'Polygon',
                    coordinates: [hull]
                },
                properties: { zip, color }
            });

            labelData.push({
                zip,
                lng: centLng,
                lat: centLat,
                count: pts.length,
                color
            });
        });

        return { 
            geoData: { type: 'FeatureCollection', features },
            labels: labelData
        };
    }, [properties]);

    if (labels.length === 0) return null;

    return (
        <>
            <Source id="zip-boundaries-source" type="geojson" data={geoData}>
                <Layer
                    id="zip-boundaries-fill"
                    type="fill"
                    paint={{
                        'fill-color': ['get', 'color'],
                        'fill-opacity': 0.08
                    }}
                />
                <Layer
                    id="zip-boundaries-line"
                    type="line"
                    paint={{
                        'line-color': ['get', 'color'],
                        'line-width': 2,
                        'line-dasharray': [3, 2] // approx '6,4'
                    }}
                />
            </Source>
            
            {labels.map(l => (
                <Marker key={`zip-label-${l.zip}`} longitude={l.lng} latitude={l.lat} anchor="center">
                    <div style={{ textAlign: 'center', pointerEvents: 'none' }}>
                        <div style={{
                            color: l.color,
                            fontWeight: 800,
                            fontSize: '13px',
                            textShadow: '0 0 6px rgba(0,0,0,0.9), 0 0 12px rgba(0,0,0,0.7)',
                            letterSpacing: '0.5px',
                            lineHeight: '1.2'
                        }}>
                            {l.zip}
                        </div>
                        <div style={{
                            color: '#e5e5e5',
                            fontSize: '10px',
                            fontWeight: 700,
                            textShadow: '0 1px 2px #000'
                        }}>
                            {l.count.toLocaleString()} homes
                        </div>
                    </div>
                </Marker>
            ))}
        </>
    );
}