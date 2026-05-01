import React, { useState, useEffect } from 'react';
import { Polygon, Tooltip } from 'react-leaflet';
import { calculatePolygonAreaSqMiles, formatSqMiles } from '@/components/logic/geoArea';

const STORAGE_KEY = 'fk_polygonHistory';
const MAX_HISTORY = 20;

function polygonKey(polygon = []) {
    const first = polygon[0] || {};
    return `${Number(first.lat || 0).toFixed(5)}:${Number(first.lng || 0).toFixed(5)}:${polygon.length}`;
}

export function savePolygonToHistory(polygon) {
    if (!polygon || polygon.length < 3) return;
    try {
        const history = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        const key = polygonKey(polygon);
        const deduped = history.filter(entry => polygonKey(entry.polygon) !== key);
        deduped.unshift({ polygon, date: new Date().toISOString() });
        if (deduped.length > MAX_HISTORY) deduped.length = MAX_HISTORY;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(deduped));
    } catch {}
}

export function clearPolygonHistory() {
    localStorage.removeItem(STORAGE_KEY);
}

export default function PolygonHistory({ currentPolygon, mode }) {
    const [history, setHistory] = useState([]);
    const [selectedKey, setSelectedKey] = useState(null);
    const isBuilder = mode === 'generate';

    useEffect(() => {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
            setHistory(saved);
        } catch {}
    }, [currentPolygon]);

    const currentKey = currentPolygon?.length > 2 ? polygonKey(currentPolygon) : null;
    const visibleHistory = history.filter(entry => polygonKey(entry.polygon) !== currentKey);

    if (visibleHistory.length === 0) return null;

    return (
        <>
            {visibleHistory.map((entry, i) => {
                const key = polygonKey(entry.polygon);
                const selected = key === selectedKey;
                const areaLabel = formatSqMiles(calculatePolygonAreaSqMiles(entry.polygon));

                return (
                    <Polygon
                        key={key || i}
                        positions={entry.polygon}
                        pathOptions={{
                            fillColor: selected ? '#FFD93D' : '#64748b',
                            color: selected ? '#FFD93D' : '#94a3b8',
                            fillOpacity: selected ? 0.16 : 0.07,
                            weight: selected ? 3 : 1.5,
                            dashArray: selected ? null : '5,5',
                            interactive: true
                        }}
                        eventHandlers={{
                            click: () => {
                                setSelectedKey(key);
                                if (isBuilder) {
                                    window.dispatchEvent(new CustomEvent('fk-select-polygon-history', { detail: entry }));
                                }
                            }
                        }}
                    >
                        <Tooltip direction="center" className="bg-black/80 text-gray-300 text-[9px] border border-gray-700 rounded px-1.5 py-0.5 text-center">
                            <div className="font-bold text-white">{areaLabel}</div>
                            <div>{new Date(entry.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
                            {isBuilder && <div className="text-yellow-400 mt-0.5">Tap to select</div>}
                        </Tooltip>
                    </Polygon>
                );
            })}
        </>
    );
}