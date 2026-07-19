import { useCallback, useEffect, useRef, useState } from 'react';
import { scheduleFieldRoutesInspection } from '@/api/fieldRoutes';
import {
  acknowledgeFieldRoutesInspection,
  discardFieldRoutesAttentionBySource,
  flushQueuedFieldRoutesInspections,
  listQueuedFieldRoutesInspections,
  makeFieldRoutesIdempotencyKey,
  markFieldRoutesInspectionAttempt,
  queueFieldRoutesInspection,
} from './fieldRoutesInspectionQueue';
import {
  FIELDROUTES_COPY,
  fieldRoutesDelivery,
  fieldRoutesServerAcknowledged,
} from './fieldRoutesPresentation';

const DEVICE_RETRY_INTERVAL_MS = 60_000;

function terminalClientError(error) {
  const status = Number(error?.status || error?.response?.status);
  return Number.isFinite(status)
    && status >= 400
    && status < 500
    && ![408, 425, 429].includes(status)
    && error?.retryable !== true;
}

export function useFieldRoutesInspectionQueue({ actorUserId, managerId, onServerAcknowledged } = {}) {
  const [pendingCount, setPendingCount] = useState(0);
  const [pendingBySource, setPendingBySource] = useState({});
  const flushingRef = useRef(false);
  const actor = String(actorUserId || '').trim();
  const manager = String(managerId || '').trim();
  const activeScopeRef = useRef('');
  const activeScope = actor && manager ? `${actor}:${manager}` : '';
  activeScopeRef.current = activeScope;

  const refreshPendingCount = useCallback(async () => {
    if (!actor || !manager) {
      setPendingCount(0);
      setPendingBySource({});
      return 0;
    }
    const requestedScope = `${actor}:${manager}`;
    const rows = await listQueuedFieldRoutesInspections({ actorUserId: actor, managerId: manager });
    if (activeScopeRef.current !== requestedScope) return rows.length;
    setPendingCount(rows.length);
    setPendingBySource(Object.fromEntries(rows.map((row) => {
      const sourceKey = String(row?.intent?.source?.source_key || '');
      const status = row.sync_state === 'needs_attention'
        ? {
            kind: 'device_attention',
            local_only: true,
            source_key: sourceKey,
            state: 'needs_review',
            safe_message: row.last_error_message || 'This device copy needs review before it can sync.',
          }
        : { kind: 'device_pending', delivery: 'device_pending' };
      return [sourceKey, status];
    }).filter(([sourceKey]) => sourceKey)));
    return rows.length;
  }, [actor, manager]);

  const flush = useCallback(async () => {
    if (!actor || !manager || flushingRef.current || typeof navigator !== 'undefined' && navigator.onLine === false) return;
    flushingRef.current = true;
    try {
      await flushQueuedFieldRoutesInspections({
        actorUserId: actor,
        managerId: manager,
        send: scheduleFieldRoutesInspection,
        isAcknowledged: fieldRoutesServerAcknowledged,
        onAcknowledged: onServerAcknowledged,
      });
    } finally {
      flushingRef.current = false;
      await refreshPendingCount();
    }
  }, [actor, manager, onServerAcknowledged, refreshPendingCount]);

  useEffect(() => {
    refreshPendingCount();
    if (!actor || !manager) return undefined;
    flush();
    const onVisible = () => {
      if (document.visibilityState === 'visible') flush();
    };
    window.addEventListener('online', flush);
    window.addEventListener('focus', flush);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', flush);
      window.removeEventListener('focus', flush);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [actor, flush, manager, refreshPendingCount]);

  useEffect(() => {
    if (!actor || !manager || pendingCount < 1) return undefined;
    const interval = window.setInterval(() => {
      // Expiry cleanup must run even while the device remains offline.
      refreshPendingCount();
      flush();
    }, DEVICE_RETRY_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [actor, flush, manager, pendingCount, refreshPendingCount]);

  const submitInspection = useCallback(async ({ source, contact, property, notes }) => {
    if (!actor || !manager) throw new Error('Your signed-in team identity is not ready yet.');
    const intent = {
      schema_version: 1,
      idempotency_key: makeFieldRoutesIdempotencyKey(),
      actor_user_id: actor,
      manager_id: manager,
      source,
      contact,
      property,
      notes: String(notes || '').trim() || null,
      client_recorded_at: new Date().toISOString(),
    };
    const queued = await queueFieldRoutesInspection(intent);
    await refreshPendingCount();

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return { kind: 'device_pending', copy: FIELDROUTES_COPY.devicePending, intent };
    }

    try {
      const result = await scheduleFieldRoutesInspection(intent);
      if (!fieldRoutesServerAcknowledged(result)) {
        throw new Error('FieldRoutes did not confirm durable server ownership of this inspection request.');
      }
      await acknowledgeFieldRoutesInspection(queued);
      await refreshPendingCount();
      await onServerAcknowledged?.(result, intent);
      return { ...fieldRoutesDelivery(result), result, intent };
    } catch (error) {
      await markFieldRoutesInspectionAttempt(queued, {
        sync_state: terminalClientError(error) ? 'needs_attention' : 'pending',
        error_code: error?.code || null,
        error_message: String(error?.message || 'Inspection sync failed.').slice(0, 500),
      });
      await refreshPendingCount();
      if (terminalClientError(error)) throw error;
      return {
        kind: 'device_pending',
        copy: typeof navigator !== 'undefined' && navigator.onLine === false
          ? FIELDROUTES_COPY.devicePending
          : 'Saved on this device — retrying when FieldRoutes is reachable.',
        intent,
        error,
      };
    }
  }, [actor, manager, onServerAcknowledged, refreshPendingCount]);

  const discardAttentionBySource = useCallback(async (sourceKey) => {
    if (!actor || !manager) throw new Error('Your signed-in team identity is not ready yet.');
    const discarded = await discardFieldRoutesAttentionBySource({
      actorUserId: actor,
      managerId: manager,
      sourceKey,
    });
    if (!discarded) throw new Error('This device copy is no longer available to discard. Refresh and try again.');
    await refreshPendingCount();
    return discarded;
  }, [actor, manager, refreshPendingCount]);

  return { discardAttentionBySource, flush, pendingBySource, pendingCount, refreshPendingCount, submitInspection };
}
