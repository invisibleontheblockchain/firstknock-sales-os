import React from 'react';
import { base44 } from '@/api/base44Client';
import { useAuth } from '@/lib/AuthContext';
import {
  markStoredAcquisitionSynced,
  readStoredAcquisition,
  shouldSyncStoredAcquisition,
} from '@/lib/acquisitionTracking';
import { getAcquisitionIdentity } from '@/lib/acquisitionEvents';

export default function AcquisitionTracker() {
  const { isAuthenticated, user } = useAuth();

  React.useEffect(() => {
    if (!isAuthenticated || !user?.id) return;
    const stored = readStoredAcquisition();
    if (!shouldSyncStoredAcquisition(stored, user.id)) return;

    let cancelled = false;
    const identity = getAcquisitionIdentity();
    base44.functions.invoke('captureAcquisitionAttribution', {
      first_touch: stored.first_touch,
      last_touch: stored.last_touch || stored.first_touch,
      anonymous_id: identity.anonymous_id,
      session_id: identity.session_id,
    }).then(() => {
      if (!cancelled) markStoredAcquisitionSynced(user.id);
    }).catch((error) => {
      console.warn('[Acquisition] Attribution sync deferred', error?.message || error);
    });

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, user?.id]);

  return null;
}
