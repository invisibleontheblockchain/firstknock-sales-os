import React, { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { getRoadAwareBetaStatus, setRoadAwareBetaEnabled, getRoadAwareBetaHistory,
    restoreRoadAwareBetaComparison } from '@/lib/roadAwareRoutingBeta';

export default function RoutingBeta() {
    const [status, setStatus] = useState(null), [rows, setRows] = useState([]), [error, setError] = useState(''), [busy, setBusy] = useState(false);
    const query = useQueryClient();
    const refresh = async () => {
        try {
            const current = await getRoadAwareBetaStatus();
            setStatus(current);
            if (current.eligible) setRows((await getRoadAwareBetaHistory()).comparisons);
            else setRows([]);
            setError('');
        } catch { setError('Routing beta resources are unavailable. Routing stays on the current production path.'); }
    };
    useEffect(() => { void refresh(); }, []);
    const toggle = async () => {
        setBusy(true);
        try { await setRoadAwareBetaEnabled(!status.enabled); await refresh(); }
        catch (e) { toast.error(e.response?.data?.error || 'Could not change routing beta status.'); }
        finally { setBusy(false); }
    };
    const restore = async id => {
        setBusy(true);
        try {
            const restored = await restoreRoadAwareBetaComparison(id);
            await Promise.all([query.invalidateQueries({ queryKey: ['savedRoutes'] }),
                query.invalidateQueries({ queryKey: ['myRoutes'] }), query.invalidateQueries({ queryKey: ['routeProperties'] })]);
            toast.success('Previous route order restored. Refresh any route currently open on the map.');
            if (restored.history_warning) toast.warning(restored.history_warning);
            await refresh();
        } catch (e) { toast.error(e.response?.data?.error || 'Route could not be restored. Newer edits were preserved.'); }
        finally { setBusy(false); }
    };
    return <div className="mx-auto max-w-5xl space-y-4 p-6 text-white">
        <h1 className="text-2xl font-bold">Routing Beta</h1>
        <p className="text-slate-300">Opt-in regional driving optimization. Savings are modeled; they are not observed rep time. All other workspaces retain their existing routing.</p>
        {error && <p role="alert" className="text-amber-300">{error}</p>}
        {status && <div className="rounded-lg border border-slate-700 p-4">
            <p>Workspace beta: {status.enabled ? 'ON' : 'OFF'} · Regional provider: {status.available ? 'configured' : 'not configured'}</p>
            {!status.eligible && <p>This workspace is outside the internal beta cohort.</p>}
            {status.canToggle && <Button disabled={busy || (!status.enabled && !status.available)} onClick={toggle} className="mt-3">
                {status.enabled ? 'Disable workspace beta' : 'Enable workspace beta'}
            </Button>}
            {!status.available && status.eligible && <p className="mt-2 text-amber-300">Configure and validate the private Charlotte road provider before enabling this workspace.</p>}
        </div>}
        <Button variant="outline" disabled={busy} onClick={refresh}>Refresh history</Button>
        <div className="space-y-3">{rows.map(row => {
            const c = row.comparison;
            return <article key={row.id} className="rounded-lg border border-slate-700 p-4 text-sm">
                <p className="font-bold">{row.entry_point} · {row.decision} · {c.membershipCount} stops</p>
                <p>Route: {row.route_id || 'generation awaiting save'} · {new Date(row.created_date).toLocaleString()}</p>
                <p>{c.fullMeasurement ? 'Full road measurement' : 'Measurable legs only'} · {c.milesSaved?.toFixed(2) ?? 'Unavailable'} miles saved · {c.secondsSaved != null ? (c.secondsSaved / 60).toFixed(1) : 'Unavailable'} modeled minutes saved</p>
                <p>{c.unresolvedCount || 0} unresolved · {c.fallbackWindows || 0} fallback windows · guard: {c.guard}</p>
                {row.decision === 'used_new' && <Button disabled={busy} variant="outline" onClick={() => restore(row.id)} className="mt-2">Restore previous order</Button>}
            </article>;
        })}</div>
    </div>;
}
