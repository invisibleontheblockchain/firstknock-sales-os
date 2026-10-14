import { useEffect } from 'react';
import { toast } from 'sonner';
import { base44 } from '@/api/base44Client';
import { retryPendingRouteSaves } from '@/lib/createManagedRoute';

export function usePendingRouteSaves(user, queryClient) {
    useEffect(() => {
        if (!user?.id) return;
        let cancelled = false;
        let busy = false;
        const retry = async () => {
            if (cancelled || busy || navigator.onLine === false) return;
            busy = true;
            try {
                const results = await retryPendingRouteSaves(base44, user.id);
                if (cancelled || !results.length) return;
                const saved = results.filter(result => result.status === 'fulfilled').length;
                if (saved) {
                    await Promise.all(['savedRoutes', 'myRoutes'].map(root => queryClient.invalidateQueries({ queryKey: [root] })));
                    toast.success(`Recovered ${saved} pending route save${saved === 1 ? '' : 's'}.`);
                }
                if (saved < results.length) toast.warning('Some route saves are still pending. Your imported homes are retained; you do not need another data pull.');
            } catch (error) { console.warn('[PendingRouteSaves]', error.message); }
            finally { busy = false; }
        };
        retry();
        window.addEventListener('online', retry);
        const timer = setInterval(retry, 60000);
        return () => { cancelled = true; clearInterval(timer); window.removeEventListener('online', retry); };
    }, [user?.id, queryClient]);
}
