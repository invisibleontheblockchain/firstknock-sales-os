import { useCallback } from 'react';
import { createPageUrl } from '@/utils';
import { dispatchGlobalSearchSelection, parkPendingSelection } from './globalSearchBridge';

/**
 * Shared selection handling for the header search surfaces (icon launcher and
 * the desktop inline bar). If the current screen cannot show the result, the
 * selection is parked and the map is opened.
 */
export default function useGlobalSearchSelect(onDone) {
  return useCallback((result) => {
    onDone?.();
    if (result?.type === 'route' && (result.route_id || result.id)) {
      window.location.href = `${createPageUrl('Home')}?savedRoute=${encodeURIComponent(result.route_id || result.id)}`;
      return;
    }
    if (dispatchGlobalSearchSelection(result)) return;
    parkPendingSelection(result);
    window.location.href = createPageUrl('Home');
  }, [onDone]);
}