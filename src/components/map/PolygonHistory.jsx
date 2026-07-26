import React, { useState, useEffect, useMemo } from 'react';
import { Marker, Polygon, Tooltip } from 'react-leaflet';
import L from 'leaflet';
import { calculatePolygonAreaSqMiles, formatSqMiles } from '@/components/logic/geoArea';

const STORAGE_KEY = 'fk_polygonHistory';
const MAX_HISTORY = 20;

function polygonKey(polygon = []) {
    if (!Array.isArray(polygon) || polygon.length < 3) return null;
    const normalized = polygon.map((point) => {
        const lat = Number(point?.lat);
        const lng = Number(point?.lng);
        return Number.isFinite(lat) && Number.isFinite(lng)
            ? { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) }
            : null;
    });
    if (normalized.some((point) => point === null)) return null;
    const first = normalized[0];
    const last = normalized[normalized.length - 1];
    if (normalized.length > 3 && first.lat === last.lat && first.lng === last.lng) normalized.pop();
    return normalized.map((point) => `${point.lat},${point.lng}`).join(';');
}

export function savePolygonToHistory(polygon, metadata = {}) {
    if (!polygon || polygon.length < 3) return;
    try {
        const history = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        const key = polygonKey(polygon);
        const existing = history.find(entry => polygonKey(entry.polygon) === key) || {};
        const deduped = history.filter(entry => polygonKey(entry.polygon) !== key);
        deduped.unshift({
            ...existing,
            ...metadata,
            polygon,
            date: metadata.date || existing.date || new Date().toISOString(),
            updated_at: new Date().toISOString(),
            queried: true
        });
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

export default function PolygonHistory({ currentPolygon, mode, serverHistory = [] }) {
    const [history, setHistory] = useState([]);
    const [selectedKey, setSelectedKey] = useState(null);
    const [ghostVisible, setGhostVisible] = useState(() => {
        try { return localStorage.getItem('fk_showGhostAreas') === 'true'; } catch { return false; }
    });
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
        const visibilityHandler = (event) => setGhostVisible(!!event.detail?.visible);
        window.addEventListener('fk-polygon-history-updated', loadHistory);
        window.addEventListener('fk-ghost-areas-visibility', visibilityHandler);
        return () => {
            window.removeEventListener('fk-polygon-history-updated', loadHistory);
            window.removeEventListener('fk-ghost-areas-visibility', visibilityHandler);
        };
    }, [currentPolygon]);

    useEffect(() => {
        if (!isBuilder) setSelectedKey(null);
    }, [isBuilder]);

    const visibleHistory = useMemo(() => {
        const byKey = new Map();
        [...serverHistory, ...history].forEach((entry) => {
            if (!entry?.polygon || entry.polygon.length < 3) return;
            const key = polygonKey(entry.polygon);
            if (!key) return;
            const existing = byKey.get(key);
            const existingTime = new Date(existing?.last_pull_date || existing?.updated_at || existing?.date || 0).getTime();
            const incomingTime = new Date(entry.last_pull_date || entry.updated_at || entry.date || 0).getTime();
            if (existing && Number.isFinite(existingTime) && (!Number.isFinite(incomingTime) || existingTime > incomingTime)) {
                byKey.set(key, {
                    ...existing,
                    criteria: {
                        ...(entry.criteria || {}),
                        ...(existing.criteria || {})
                    }
                });
                return;
            }
            byKey.set(key, {
                ...existing,
                ...entry,
                criteria: {
                    ...(existing?.criteria || {}),
                    ...(entry.criteria || {})
                },
                queried: true
            });
        });
        return Array.from(byKey.values());
    }, [history, serverHistory]);

    const deleteHistoryEntry = (keyToDelete) => {
        const nextHistory = history.filter(entry => polygonKey(entry.polygon) !== keyToDelete);
        setHistory(nextHistory);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(nextHistory)); } catch {}
        if (selectedKey === keyToDelete) setSelectedKey(null);
    };

    if (!isBuilder || !ghostVisible || visibleHistory.length === 0) return null;

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
                            fillColor: selected ? '#FFD93D' : '#FFFFFF',
                            color: selected ? '#FFD93D' : '#FFFFFF',
                            fillOpacity: selected ? 0.16 : 0.18,
                            weight: selected ? 3 : 2.5,
                            opacity: selected ? 1 : 0.95,
                            dashArray: selected ? null : '6,5',
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
                    {isBuilder && center && entry.source !== 'server' && (
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
