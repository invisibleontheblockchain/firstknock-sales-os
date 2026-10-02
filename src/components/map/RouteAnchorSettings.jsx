import React, { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { geocodeAddress } from '@/lib/geocoding';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';

export default function RouteAnchorSettings({ route, requesterId, onSaved, open, onOpenChange: setOpen }) {
    const queryClient = useQueryClient();
    const [source, setSource] = useState('rep_base');
    const [address, setAddress] = useState('');
    const [resolved, setResolved] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const { data, isLoading, error: loadError } = useQuery({
        queryKey: ['routeAnchor', route.id, requesterId],
        queryFn: async () => (await base44.functions.invoke('manageRepAnchors', { action: 'get_route', route_id: route.id })).data,
        enabled: open && !!requesterId,
    });
    useEffect(() => {
        if (!open) return;
        setSource(route.metadata?.anchor?.source || 'rep_base'); setAddress(''); setResolved(null); setError('');
    }, [open, route.id, route.metadata?.anchor?.source]);
    async function save() {
        setBusy(true); setError('');
        try {
            if (source === 'custom' && !resolved) { setResolved(await geocodeAddress(address)); return; }
            const response = await base44.functions.invoke('manageRepAnchors', {
                action: 'set_route', route_id: route.id, source, ...(source === 'custom' ? { location: resolved } : {}),
            });
            onSaved(response.data.route);
            await Promise.all(['savedRoutes', 'allRoutes', 'myRoutes', 'routeAnchor'].map(key => queryClient.invalidateQueries({ queryKey: [key] })));
            toast.success(source === 'none' ? 'Route anchor removed' : 'Route optimized from its anchor');
            setOpen(false);
        } catch (err) { setError(err.response?.data?.error || err.message || 'Could not set the anchor.'); }
        finally { setBusy(false); }
    }
    return <>
        <button onClick={event => { event.stopPropagation(); setOpen(true); }} className="hidden xl:inline-flex items-center h-6 px-2 rounded-md border border-yellow-500/30 text-yellow-300 text-[10px] font-bold shrink-0">REP ANCHOR</button>
        <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
            <DialogContent className="bg-[#111] border-gray-800 text-white sm:max-w-md" onClick={event => event.stopPropagation()}>
                <DialogHeader><DialogTitle>Route anchor</DialogTitle></DialogHeader>
                <p className="text-sm text-gray-400">Choose the address where this route starts and finishes.</p>
                {isLoading ? <p className="text-gray-400">Loading anchor…</p> : loadError ? <p role="alert" className="text-red-400">Could not load the current anchor.</p> :
                    <p className="text-sm text-yellow-300 break-words">Current: {data?.anchor?.address || 'No anchor'}</p>}
                <select aria-label="Anchor source" value={source} disabled={busy} onChange={event => { setSource(event.target.value); setError(''); }} className="w-full rounded-md border border-gray-700 bg-black p-2 text-sm">
                    <option value="rep_base" disabled={!route.assigned_to}>Assigned rep’s base</option>
                    <option value="custom">Custom address</option>
                    <option value="none">No anchor</option>
                </select>
                {source === 'custom' && <>
                    <Input aria-label="Route anchor address" value={address} disabled={busy} onChange={event => { setAddress(event.target.value); setResolved(null); setError(''); }} placeholder="Street address, city, state, ZIP" className="bg-black border-gray-700" />
                    {resolved && <p className="text-sm text-yellow-300">Confirm this address: {resolved.address}</p>}
                </>}
                <p className="text-xs text-gray-500">Exact addresses are only available to your manager and the rep assigned to this route.</p>
                {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
                <Button disabled={busy || isLoading || !!loadError || (source === 'custom' && !address.trim()) || (source === 'rep_base' && !route.assigned_to)} onClick={save} className="bg-yellow-500 text-black hover:bg-yellow-400">
                    {busy ? 'Working…' : source === 'custom' && !resolved ? 'Find address' : 'Apply anchor'}
                </Button>
            </DialogContent>
        </Dialog>
    </>;
}
