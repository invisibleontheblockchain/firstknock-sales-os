import React from 'react';
import { base44 } from '@/api/base44Client';
import { useAuth } from '@/lib/AuthContext';
import {
  readStoredAcquisition,
  shouldSyncStoredAcquisition,
} from '@/lib/acquisitionTracking';
import { getAcquisitionIdentity } from '@/lib/acquisitionEvents';
import { syncAcquisitionAttribution } from '@/lib/acquisitionSync';

export default function AcquisitionTracker() {
  const { isAuthenticated, user } = useAuth();

  React.useEffect(() => {
    if (!isAuthenticated || !user?.id) return;
    const stored = readStoredAcquisition();
    if (!shouldSyncStoredAcquisition(stored, user.id)) return;

    let cancelled = false;
    const identity = getAcquisitionIdentity();
    void syncAcquisitionAttribution({
      invoke: (functionName, payload) => (
        base44.functions.invoke(functionName, payload)
      ),
      userId: user.id,
      stored,
      identity,
      shouldCancel: () => cancelled,
      onRetry: (error) => {
        console.warn(
          '[Acquisition] Attribution sync retrying',
          error?.message || error,
        );
      },
    }).catch((error) => {
      console.warn('[Acquisition] Attribution sync deferred', error?.message || error);
    });

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, user?.id]);

  return null;
}
