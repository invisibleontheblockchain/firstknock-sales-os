import { base44 } from '@/api/base44Client';
import { toast } from 'sonner';

/**
 * Delete one saved route.
 *
 * Shared by Route Command and the active-route banner so a route can be removed
 * while it is the only one soloed on the map. When the deleted route is the
 * active one, the map is cleared and the remembered knock route is dropped —
 * otherwise the Knock tab would keep pointing at a route that no longer exists.
 */
export async function deleteSavedRoute({ route, queryClient, activeRoute, setActiveRoute }) {
    if (!route?.id) return false;
    if (typeof window !== 'undefined' && !window.confirm(`Delete route "${route.name}"?`)) return false;
    try {
        await base44.entities.SavedRoute.delete(route.id);
        queryClient?.invalidateQueries({ queryKey: ['savedRoutes'] });
        if (activeRoute?.id === route.id) {
            setActiveRoute?.(null);
            try { localStorage.removeItem('fk_selectedKnockRouteId'); } catch {}
        }
        toast.success('Route deleted');
        return true;
    } catch (error) {
        toast.error('Failed to delete route');
        return false;
    }
}