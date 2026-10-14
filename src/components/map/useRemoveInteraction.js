import { useCallback, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { toast } from 'sonner';
import removeInteraction from '@/components/logic/removeInteraction';

export default function useRemoveInteraction(queryClient, pendingOutcomesRef) {
    const removing = useRef(new Set());
    return useCallback(async (log) => {
        if (!log?.id || removing.current.has(log.id)) return;
        if (String(log.id).startsWith('optimistic-')) {
            toast.info('This interaction is still saving. Please wait before removing it.');
            return;
        }
        if (!confirm('Remove this interaction history?')) return;
        removing.current.add(log.id);
        try {
            const { missing } = await removeInteraction({
                id: log.id,
                remove: (id) => base44.entities.InteractionLog.delete(id),
                queryClient,
                pendingOutcomes: pendingOutcomesRef.current,
            });
            if (missing) toast.info('This interaction is no longer available. History refreshed.');
            else toast.success('Interaction removed');
        } catch (error) {
            toast.error(error?.message || 'Unable to remove this interaction. Please try again.');
        } finally {
            removing.current.delete(log.id);
        }
    }, [queryClient, pendingOutcomesRef]);
}