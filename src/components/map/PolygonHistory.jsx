import React, { useState, useEffect } from 'react';
import { Polygon, Tooltip } from 'react-leaflet';

const STORAGE_KEY = 'fk_polygonHistory';
const MAX_HISTORY = 20;

export function savePolygonToHistory(polygon) {
    if (!polygon || polygon.length < 3) return;
    try {
        const history = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        history.unshift({ polygon, date: new Date().toISOString() });
        if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    } catch {}
}

export function clearPolygonHistory() {
    localStorage.removeItem(STORAGE_KEY);
}

export default function PolygonHistory({ currentPolygon }) {
    const [history, setHistory] = useState([]);

    useEffect(() => {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
            setHistory(saved);
        } catch {}
    }, [currentPolygon]);

    // Filter out the current active polygon from history display
    const filtered = history.filter(h => {
        if (!currentPolygon || currentPolygon.length === 0) return true;
        // Skip if it's essentially the same polygon (compare first point)
        const c = currentPolygon[0];
        const p = h.polygon[0];
        if (Math.abs(c.lat - p.lat) < 0.0001 && Math.abs(c.lng - p.lng) < 0.0001) return false;
        return true;
    });

    if (filtered.length === 0) return null;

    return (
        <>
            {filtered.map((entry, i) => (
                <Polygon
                    key={i}
                    positions={entry.polygon}
                    pathOptions={{
                        fillColor: '#888',
                        color: '#666',
                        fillOpacity: 0.08,
                        weight: 1,
                        dashArray: '4,4',
                        interactive: true
                    }}
                >
                    <Tooltip direction="center" className="bg-black/80 text-gray-300 text-[9px] border border-gray-700 rounded px-1.5 py-0.5">
                        {new Date(entry.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </Tooltip>
                </Polygon>
            ))}
        </>
    );
}