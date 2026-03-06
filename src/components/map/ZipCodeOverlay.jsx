import React, { useMemo } from 'react';
import { Polygon, Tooltip } from 'react-leaflet';

/**
 * Draws zip code boundary polygons derived from property locations.
 * Uses convex hull of properties in each zip to approximate boundaries.
 */

// Simple convex hull (Graham scan)
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
    return lower.concat(upper);
}

const ZIP_COLORS = [
    '#FFD700', '#3b82f6', '#22c55e', '#ef4444', '#8b5cf6',
    '#f97316', '#06b6d4', '#ec4899', '#14b8a6', '#eab308',
    '#6366f1', '#f43f5e', '#10b981', '#a855f7', '#84cc16',
];

export default function ZipCodeOverlay({ properties = [] }) {
    const zipPolygons = useMemo(() => {
        // Group properties by zip
        const byZip = {};
        properties.forEach(p => {
            const zip = String(p.zip_code || '').trim().slice(0, 5);
            if (!zip || !p.lat || !p.lng) return;
            if (!byZip[zip]) byZip[zip] = [];
            byZip[zip].push([p.lat, p.lng]);
        });

        // Build convex hull for each zip
        const results = [];
        const zips = Object.keys(byZip).sort();
        zips.forEach((zip, idx) => {
            const pts = byZip[zip];
            if (pts.length < 3) return;

            const hull = convexHull(pts);
            if (hull.length < 3) return;

            // Compute centroid for label
            const centLat = pts.reduce((s, p) => s + p[0], 0) / pts.length;
            const centLng = pts.reduce((s, p) => s + p[1], 0) / pts.length;

            results.push({
                zip,
                hull,
                center: [centLat, centLng],
                count: pts.length,
                color: ZIP_COLORS[idx % ZIP_COLORS.length]
            });
        });

        return results;
    }, [properties]);

    if (zipPolygons.length === 0) return null;

    return (
        <>
            {zipPolygons.map(z => (
                <Polygon
                    key={z.zip}
                    positions={z.hull}
                    pathOptions={{
                        color: z.color,
                        weight: 2,
                        fillColor: z.color,
                        fillOpacity: 0.08,
                        dashArray: '6,4'
                    }}
                >
                    <Tooltip
                        permanent
                        direction="center"
                        className="zip-label-tooltip"
                    >
                        <span style={{
                            color: z.color,
                            fontWeight: 800,
                            fontSize: '13px',
                            textShadow: '0 0 6px rgba(0,0,0,0.9), 0 0 12px rgba(0,0,0,0.7)',
                            letterSpacing: '0.5px'
                        }}>
                            {z.zip}
                        </span>
                        <br />
                        <span style={{
                            color: '#999',
                            fontSize: '9px',
                            fontWeight: 600
                        }}>
                            {z.count.toLocaleString()} homes
                        </span>
                    </Tooltip>
                </Polygon>
            ))}
        </>
    );
}