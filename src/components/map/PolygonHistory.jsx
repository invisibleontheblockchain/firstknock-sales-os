import React, { useState, useEffect } from 'react';
import { Marker, Polygon, Tooltip } from 'react-leaflet';
import L from 'leaflet';
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
        deduped.unshift({ polygon, date: new Date().toISOString(), queried: true });
        if (deduped.length > MAX_HISTORY) deduped.length = MAX_HISTORY;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(deduped));
    } catch {}
}

export function clearPolygonHistory() {
    localStorage.removeItem(STORAGE_KEY);
}

function polygonCenter(polygon = []) {
    if (!polygon.length) return null;
    return {
        lat: polygon.reduce((sum, p) => sum + p.lat, 0) / polygon.length,
        lng: polygon.reduce((sum, p) => sum + p.lng, 0) / polygon.length
    };
}

function trashIcon(onDelete) {
    const container = document.createElement('button');
    container.type = 'button';
    container.className = 'w-8 h-8 rounded-full bg-red-500/90 border border-white/40 shadow-xl flex items-center justify-center text-white hover:bg-red-400';
    container.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.on(container, 'click', (event) => {
        L.DomEvent.stop(event);
        onDelete();
    });
    return L.divIcon({ html: container, className: '', iconSize: [32, 32], iconAnchor: [16, 16] });
}

export default function PolygonHistory({ currentPolygon, mode }) {
    const [history, setHistory] = useState([]);
    const [selectedKey, setSelectedKey] = useState(null);
    const isBuilder = mode === 'generate';

    useEffect(() => {
        const loadHistory = () => {
            try {
                const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
                const queriedOnly = saved.filter(entry => entry?.queried === true);
                if (queriedOnly.length !== saved.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(queriedOnly));
                setHistory(queriedOnly);
            } catch {}
        };
        loadHistory();
        window.addEventListener('fk-polygon-history-updated', loadHistory);
        return () => window.removeEventListener('fk-polygon-history-updated', loadHistory);
    }, [currentPolygon]);

    useEffect(() => {
        if (!isBuilder) setSelectedKey(null);
    }, [isBuilder]);

    const currentKey = currentPolygon?.length > 2 ? polygonKey(currentPolygon) : null;
    const visibleHistory = history.filter(entry => polygonKey(entry.polygon) !== currentKey);

    const deleteHistoryEntry = (keyToDelete) => {
        const nextHistory = history.filter(entry => polygonKey(entry.polygon) !== keyToDelete);
        setHistory(nextHistory);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(nextHistory)); } catch {}
        if (selectedKey === keyToDelete) setSelectedKey(null);
    };

    if (visibleHistory.length === 0) return null;

    return (
        <>
            {visibleHistory.map((entry, i) => {
                const key = polygonKey(entry.polygon);
                const selected = isBuilder && key === selectedKey;
                const areaLabel = formatSqMiles(calculatePolygonAreaSqMiles(entry.polygon));
                const center = polygonCenter(entry.polygon);

                return (
                    <React.Fragment key={key || i}>
                    <Polygon
                        key={`${key || i}-shape`}
                        positions={entry.polygon}
                        pathOptions={{
                            fillColor: selected ? '#FFD93D' : '#64748b',
                            color: selected ? '#FFD93D' : '#94a3b8',
                            fillOpacity: selected ? 0.16 : 0.07,
                            weight: selected ? 3 : 1.5,
                            dashArray: selected ? null : '5,5',
                            interactive: isBuilder
                        }}
                        eventHandlers={isBuilder ? {
                            click: () => {
                                setSelectedKey(key);
                                window.dispatchEvent(new CustomEvent('fk-select-polygon-history', { detail: entry }));
                            }
                        } : {}}
                    >
                        <Tooltip direction="center" className="bg-black/80 text-gray-300 text-[9px] border border-gray-700 rounded px-1.5 py-0.5 text-center">
                            <div className="font-bold text-white">{areaLabel}</div>
                            <div>{new Date(entry.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
                            {isBuilder && <div className="text-yellow-400 mt-0.5">Tap to select</div>}
                        </Tooltip>
                    </Polygon>
                    {isBuilder && center && (
                        <Marker
                            position={center}
                            icon={trashIcon(() => deleteHistoryEntry(key))}
                            interactive={true}
                            zIndexOffset={1000}
                        />
                    )}
                    </React.Fragment>
                );
            })}
        </>
    );
}