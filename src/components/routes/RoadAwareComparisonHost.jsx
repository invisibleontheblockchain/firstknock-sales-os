import React, { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Polyline, CircleMarker, Tooltip, Popup } from 'react-leaflet';
import { subscribeRoadAwareApproval } from '@/lib/roadAwareBetaApproval';
import { Button } from '@/components/ui/button';
import { ESRI_IMAGERY_ATTRIBUTION } from '@/components/map/mapAttribution';
import '@/components/map/leafletPatches';

const number = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : 'Unavailable';
const key = p => String(p.address_hash || p.legacy_hash || p.id);
const percent = (saved, total) => total > 0 ? number(saved / total * 100, 1) + '%' : 'Unavailable';

export function RoadAwareComparisonView({ preview }) {
    const [mode, setMode] = useState('Compare');
    const { result, properties, canApply } = preview;
    const c = result.comparison;
    const order = mode === 'Current' ? properties : result.properties;
    const unknown = new Set(c.unresolvedIds || []);
    const points = properties.filter(p => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)))
        .map(p => [Number(p.lat), Number(p.lng)]);
    const segments = arm => (result.geometry?.[arm] || []).filter(segment => segment.points?.length > 1);
    return <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/80 p-2 sm:p-6">
        <section role="dialog" aria-modal="true" aria-labelledby="road-comparison-title"
            onKeyDown={event => { if (event.key === 'Escape') preview.decide(false); }}
            className="flex max-h-[96vh] w-full max-w-5xl flex-col overflow-auto rounded-xl border border-slate-600 bg-slate-950 text-white shadow-2xl">
            <div className="p-4">
                <h2 id="road-comparison-title" className="text-lg font-bold">Route comparison — {preview.routeName}</h2>
                <p className="text-sm text-slate-300">The saved route stays unchanged until you choose Use New Route. Times are modeled driving time.</p>
                {!c.fullMeasurement && <p className="mt-2 text-sm text-amber-300">Partial road coverage: totals below cover the same measurable legs only. Unknown access stays in its current position.</p>}
                <table className="mt-3 w-full text-left text-sm">
                    <thead><tr><th>Order</th><th>Road miles</th><th>Drive minutes</th></tr></thead>
                    <tbody><tr><th>Current</th><td>{number(c.before?.miles)}</td><td>{number(c.before?.seconds / 60)}</td></tr>
                        <tr><th>Road-aware</th><td>{number(c.after?.miles)}</td><td>{number(c.after?.seconds / 60)}</td></tr>
                        <tr><th>Saved</th><td>{number(c.milesSaved)} / {percent(c.milesSaved, c.before?.miles)}</td>
                            <td>{number(c.secondsSaved / 60)} / {percent(c.secondsSaved, c.before?.seconds)}</td></tr></tbody>
                </table>
                <p className="mt-2 text-xs text-slate-300">{c.membershipCount} stops preserved · {c.unresolvedCount || 0} unresolved access points · {c.fallbackWindows || 0} fallback windows · {c.acceptedRegressions} accepted regressions</p>
                {c.reason && <p className="text-sm text-amber-300">{c.reason.replaceAll('_', ' ')}</p>}
                <div className="mt-3 flex gap-2" aria-label="Comparison map view">
                    {['Current', 'Road-aware', 'Compare'].map(value => <Button key={value} variant={mode === value ? 'default' : 'outline'}
                        aria-pressed={mode === value} onClick={() => setMode(value)}>{value}</Button>)}
                </div>
                <p className="mt-2 text-xs text-slate-300">Current: gray dashed. Road-aware: blue. Stop numbers follow the selected order; Compare shows the proposed order. Yellow marks unresolved access. Lines show verified road segments only.</p>
            </div>
            {points.length > 0 && <div className="h-[45vh] min-h-[280px] shrink-0">
                <MapContainer bounds={points} boundsOptions={{ padding: [20, 20], maxZoom: 19 }} className="h-full w-full" scrollWheelZoom preferCanvas>
                    <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                        attribution={ESRI_IMAGERY_ATTRIBUTION} maxNativeZoom={19} />
                    {mode !== 'Road-aware' && segments('current').map((segment, i) => <Polyline key={'current' + i} positions={segment.points}
                        pathOptions={{ color: '#a1a1aa', dashArray: '8 7', weight: 3, opacity: 0.85 }} />)}
                    {mode !== 'Current' && segments('selected').map((segment, i) => <Polyline key={'selected' + i} positions={segment.points}
                        pathOptions={{ color: '#3b82f6', weight: 5, opacity: 0.95 }} />)}
                    {order.filter(p => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng))).map((p, i) =>
                        <CircleMarker key={key(p)} center={[Number(p.lat), Number(p.lng)]} radius={5}
                            pathOptions={{ color: unknown.has(key(p)) ? '#fbbf24' : mode === 'Current' ? '#a1a1aa' : '#60a5fa', fillOpacity: 1 }}>
                            <Tooltip permanent={order.length <= 200} direction="top">{i + 1}</Tooltip>
                            <Popup>{i + 1}. {p.address || p.street_address || key(p)}{unknown.has(key(p)) ? ' — unresolved access' : ''}</Popup>
                        </CircleMarker>)}
                </MapContainer>
            </div>}
            {!segments('current').length && !segments('selected').length && <p className="px-4 text-sm text-amber-300">Verified route geometry is unavailable; no speculative road line is drawn.</p>}
            <div className="sticky bottom-0 z-[1000] flex shrink-0 justify-end gap-3 border-t border-slate-700 bg-slate-950 p-4">
                <Button autoFocus variant="outline" onClick={() => preview.decide(false)}>Keep Current</Button>
                <Button disabled={!canApply} onClick={() => preview.decide(true)}>Use New Route</Button>
            </div>
        </section>
    </div>;
}

export default function RoadAwareComparisonHost() {
    const [preview, setPreview] = useState(null);
    useEffect(() => subscribeRoadAwareApproval(setPreview), []);
    return preview ? <RoadAwareComparisonView key={preview.result.comparisonId} preview={preview} /> : null;
}
