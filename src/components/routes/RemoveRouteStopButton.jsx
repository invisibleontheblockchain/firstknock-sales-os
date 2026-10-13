import React, { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, ListMinus } from 'lucide-react';
import { toast } from 'sonner';
import { base44 } from '@/api/base44Client';
import { buildFullAddress } from '@/components/logic/navigation';
import { applyRouteStopRemoval, removeSavedRouteStop, routeContainsProperty } from '@/lib/routeStopRemoval';

export default function RemoveRouteStopButton({ route, property, onRemoved, disabled = false }) {
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState(false);
    const inFlight = useRef(false);
    if (!route?.id || route.isSaved === false || route.status === 'ARCHIVED' || !routeContainsProperty(route, property)) return null;

    const remove = async () => {
        if (inFlight.current) return;
        if (!window.confirm(`Remove ${buildFullAddress(property) || 'this address'} from "${route.name || 'this route'}"?\n\nThe address and its visit history will be kept. Only this route will change.`)) return;
        inFlight.current = true;
        setBusy(true);
        try {
            const saved = await removeSavedRouteStop({ route, property, entities: base44.entities });
            // Stop older refetches from overwriting the just-saved manifest.
            await Promise.all(['savedRoutes', 'myRoutes', 'routeProperties'].map(key => queryClient.cancelQueries({ queryKey: [key] })));
            for (const key of ['savedRoutes', 'myRoutes']) {
                queryClient.setQueriesData({ queryKey: [key] }, previous => {
                    const merge = rows => rows.map(row => row.id === saved.id ? applyRouteStopRemoval(row, saved) : row);
                    if (Array.isArray(previous)) return merge(previous);
                    if (Array.isArray(previous?.items)) return { ...previous, items: merge(previous.items) };
                    return previous;
                });
            }
            onRemoved?.(saved);
            for (const key of ['savedRoutes', 'myRoutes', 'routeProperties']) {
                queryClient.invalidateQueries({ queryKey: [key] });
            }
            toast.success('Address removed from this route');
        } catch (error) {
            toast.error(error?.message || 'Could not remove this address. Please try again.');
        } finally {
            inFlight.current = false;
            setBusy(false);
        }
    };

    return (
        <button type="button" onClick={remove} disabled={busy || disabled} aria-busy={busy}
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-red-400/20 bg-red-400/5 px-3 py-2 text-xs font-bold text-red-300 transition-colors hover:bg-red-400/10 disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ListMinus className="h-4 w-4" />}
            {busy ? 'Removing address…' : 'Remove from route'}
        </button>
    );
}
