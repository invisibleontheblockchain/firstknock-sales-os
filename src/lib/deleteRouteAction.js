import { base44 } from '@/api/base44Client';
import { toast } from 'sonner';
import { isUnsavedRoute } from '@/lib/routeSaveState';

/**
 * Delete one saved route, or discard one that only exists on this device.
 *
 * Shared by Route Command and the active-route banner so a route can be removed
 * while it is the only one soloed on the map. When the deleted route is the
 * active one, the map is cleared and the remembered knock route is dropped —
 * otherwise the Knock tab would keep pointing at a route that no longer exists.
 */
export async function deleteSavedRoute({ route, queryClient, activeRoute, setActiveRoute, savedRouteIds = null, onDiscardUnsaved }) {
    if (!route?.id) return false;
    const unsaved = isUnsavedRoute(route, savedRouteIds);
    const prompt = unsaved
        ? `Discard route "${route.name}"? It was never saved to your account.`
        : `Delete route "${route.name}"?`;
    if (typeof window !== 'undefined' && !window.confirm(prompt)) return false;
    const clearActive = () => {
        if (activeRoute?.id === route.id) {
            setActiveRoute?.(null);
            try { localStorage.removeItem('fk_selectedKnockRouteId'); } catch {}
        }
    };
    if (unsaved) {
        // Nothing exists on the server to delete; remove it from this device only.
        onDiscardUnsaved?.(route);
        clearActive();
        toast.success('Route discarded');
        return true;
    }
    try {
        await base44.entities.SavedRoute.delete(route.id);
        queryClient?.invalidateQueries({ queryKey: ['savedRoutes'] });
        clearActive();
        toast.success('Route deleted');
        return true;
    } catch (error) {
        // Keep the server's reason visible; a bare toast hid a permission denial for reps.
        console.error('Route delete failed', error);
        const reason = error?.response?.data?.message || error?.response?.data?.error || error?.message;
        toast.error(reason ? `Failed to delete route: ${reason}` : 'Failed to delete route');
        return false;
    }
}
