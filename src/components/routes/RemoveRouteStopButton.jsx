import React, { useRef, useState } from 'react';
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import {
    AlertDialog, AlertDialogPortal, AlertDialogOverlay, AlertDialogHeader,
    AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, ListMinus } from 'lucide-react';
import { toast } from 'sonner';
import { base44 } from '@/api/base44Client';
import { buildFullAddress } from '@/components/logic/navigation';
import { applyRouteStopRemoval, removeSavedRouteStop, routeContainsProperty } from '@/lib/routeStopRemoval';

export default function RemoveRouteStopButton({ route, property, onRemoved, disabled = false }) {
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState(false);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [error, setError] = useState('');
    const inFlight = useRef(false);
    if (!route?.id || route.isSaved === false || route.status === 'ARCHIVED' || !routeContainsProperty(route, property)) return null;

    const remove = async () => {
        if (inFlight.current) return;
        inFlight.current = true;
        setBusy(true);
        setError('');
        try {
            const { savedRoute: saved, nextStop } = await removeSavedRouteStop({ route, property, entities: base44.entities });
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
            setConfirmOpen(false);
            onRemoved?.(saved, nextStop);
            for (const key of ['savedRoutes', 'myRoutes', 'routeProperties']) {
                queryClient.invalidateQueries({ queryKey: [key] });
            }
            toast.success('Address removed from this route');
        } catch (error) {
            setError(error?.message || 'Could not remove this address. Please try again.');
            toast.error(error?.message || 'Could not remove this address. Please try again.');
        } finally {
            inFlight.current = false;
            setBusy(false);
        }
    };

    return (
        <AlertDialog open={confirmOpen} onOpenChange={(open) => { if (!inFlight.current) setConfirmOpen(open); }}>
        <button type="button" onClick={() => { setError(''); setConfirmOpen(true); }} disabled={busy || disabled} aria-busy={busy}
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-red-400/20 bg-red-400/5 px-3 py-2 text-xs font-bold text-red-300 transition-colors hover:bg-red-400/10 disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ListMinus className="h-4 w-4" />}
            {busy ? 'Removing address…' : 'Remove from route'}
        </button>
        <AlertDialogPortal>
            <AlertDialogOverlay className="z-[4000]" />
            <AlertDialogPrimitive.Content onClick={event => event.stopPropagation()}
                onEscapeKeyDown={event => { if (inFlight.current) event.preventDefault(); }}
                className="fixed left-1/2 top-1/2 z-[4001] grid w-[calc(100%_-_2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 rounded-2xl border border-white/15 bg-[#151515] p-5 text-white shadow-2xl">
                <AlertDialogHeader>
                    <AlertDialogTitle>Please confirm removal</AlertDialogTitle>
                    <AlertDialogDescription className="text-white/70">
                        Remove {buildFullAddress(property) || 'this address'} from “{route.name || 'this route'}”?
                        {' '}It will disappear from this route and its map, and the route will continue to the next stop.
                        {' '}The address record and its visit history will be kept.
                    </AlertDialogDescription>
                </AlertDialogHeader>
                {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={busy} className="border-white/15 bg-white/5 text-white hover:bg-white/10">Cancel</AlertDialogCancel>
                    <AlertDialogAction disabled={busy} aria-busy={busy} onClick={event => { event.preventDefault(); remove(); }}
                        className="gap-2 bg-red-500 text-white hover:bg-red-600">
                        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                        {busy ? 'Removing…' : 'Confirm remove and continue'}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogPrimitive.Content>
        </AlertDialogPortal>
        </AlertDialog>
    );
}
