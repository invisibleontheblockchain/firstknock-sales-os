import { useEffect, useState } from 'react';
import { dismissFieldBanner, isFieldBannerDismissed } from '@/lib/fieldBannerDismissal';

const deviceStorage = () => { try { return localStorage; } catch { return null; } };

/** [dismissed, dismiss] for one top-of-app notice in its current scope. */
export function useFieldBannerDismissal(bannerId, userId, scope) {
  const read = () => isFieldBannerDismissed(deviceStorage(), { bannerId, userId, scope });
  const [dismissed, setDismissed] = useState(read);
  // A new shift or a change of account brings the notice back.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setDismissed(read()); }, [bannerId, userId, scope]);
  const dismiss = () => {
    dismissFieldBanner(deviceStorage(), { bannerId, userId, scope });
    setDismissed(true);
  };
  return [dismissed, dismiss];
}
