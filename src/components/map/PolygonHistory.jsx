import React, { useState, useEffect, useMemo } from 'react';
import { Marker, Polygon, Tooltip } from 'react-leaflet';
import L from 'leaflet';
import { calculatePolygonAreaSqMiles, formatSqMiles } from '@/components/logic/geoArea';
import { mergePulledAreas } from '@/components/map/mergePulledAreas';

const STORAGE_KEY = 'fk_polygonHistory';
const HIDDEN_KEY = 'fk_polygonHistoryHidden';
const MAX_HISTORY = 20;

function readHiddenKeys() {
    try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]')); } catch { return new Set(); }
}

function polygonKey(polygon = []) {
    const first = polygon[0] || {};
    return `${Number(first.lat || 0).toFixed(5)}:${Number(first.lng || 0).toFixed(5)}:${polygon.length}`;
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

function trashIcon(onDelete, label) {
    const container = document.createElement('button');
    container.type = 'button';
    container.title = `Clear this pulled area (${label})`;
    container.setAttribute('aria-label', `Clear this pulled area (${label})`);
    container.className = 'flex h-9 w-9 items-center justify-center rounded-full border border-red-400/60 bg-black/85 text-red-300 shadow-[0_6px_20px_rgba(0,0,0,0.55)] backdrop-blur-sm transition-colors hover:border-red-400 hover:bg-red-500 hover:text-white active:scale-95';
    container.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.on(container, 'click', (event) => {
        L.DomEvent.stop(event);
        if (!window.confirm(`Clear this pulled area (${label}) from the map?`)) return;
        onDelete();
    });
    return L.divIcon({ html: container, className: '', iconSize: [36, 36], iconAnchor: [18, 18] });
}

export default function PolygonHistory({ currentPolygon, mode, serverHistory = [] }) {
    const [history, setHistory] = useState([]);
    const [hiddenKeys, setHiddenKeys] = useState(() => readHiddenKeys());
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
            if (!key || hiddenKeys.has(key)) return;
            const existing = byKey.get(key);
            const existingTime = new Date(existing?.last_pull_date || existing?.updated_at || existing?.date || 0).getTime();
            const incomingTime = new Date(entry.last_pull_date || entry.updated_at || entry.date || 0).getTime();
            if (existing && Number.isFinite(existingTime) && (!Number.isFinite(incomingTime) || existingTime > incomingTime)) return;
            byKey.set(key, {
                ...existing,
                ...entry,
                queried: true
            });
        });
        return Array.from(byKey.values());
    }, [history, serverHistory, hiddenKeys]);

    // Overlapping pulls are dissolved into one coverage shape so repeated pulls
    // over the same neighborhood stay readable and tappable.
    const mergedAreas = useMemo(() => mergePulledAreas(visibleHistory), [visibleHistory]);

    // Server-sourced pulls cannot be deleted remotely, so a cleared area is also
    // remembered locally as hidden to keep the map view clean.
    const deleteMergedArea = (members) => {
        const removedKeys = new Set(members.map(entry => polygonKey(entry.polygon)));
        const nextHistory = history.filter(entry => !removedKeys.has(polygonKey(entry.polygon)));
        setHistory(nextHistory);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(nextHistory)); } catch {}
        const nextHidden = new Set([...hiddenKeys, ...removedKeys]);
        setHiddenKeys(nextHidden);
        try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(Array.from(nextHidden))); } catch {}
        if (removedKeys.has(selectedKey)) setSelectedKey(null);
    };

    if (!isBuilder || !ghostVisible || mergedAreas.length === 0) return null;

    return (
        <>
            {mergedAreas.map((area, i) => {
                const { polygon, members, newest: entry } = area;
                const key = polygonKey(polygon);
                const selected = isBuilder && members.some(member => polygonKey(member.polygon) === selectedKey);
                const areaLabel = formatSqMiles(calculatePolygonAreaSqMiles(polygon));
                const center = polygonCenter(polygon);

                return (
                    <React.Fragment key={key || i}>
                    <Polygon
                        key={`${key || i}-shape`}
                        positions={polygon}
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
                                setSelectedKey(polygonKey(entry.polygon));
                                window.dispatchEvent(new CustomEvent('fk-select-polygon-history', { detail: entry }));
                            }
                        } : {}}
                    >
                        <Tooltip direction="center" className="bg-black/80 text-gray-300 text-[9px] border border-gray-700 rounded px-1.5 py-0.5 text-center">
                            <div className="font-bold text-white">{areaLabel}</div>
                            <div>{new Date(entry.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
                            {members.length > 1 && <div className="text-gray-400">{members.length} pulls merged</div>}
                            {isBuilder && <div className="text-yellow-400 mt-0.5">Tap to select</div>}
                        </Tooltip>
                    </Polygon>
                    {isBuilder && center && (
                        <Marker
                            position={center}
                            icon={trashIcon(() => deleteMergedArea(members), areaLabel)}
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