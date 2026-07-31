import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import AddLeadFromAddressDialog from '@/components/search/AddLeadFromAddressDialog';
import { resolveSelectedProperty } from '@/components/search/searchSelection';
import { GLOBAL_SEARCH_EVENT, takePendingSelection } from '@/components/search/globalSearchBridge';

/**
 * Search result handler for the rep Home screen.
 *
 * The search field lives in the app header; this component only reacts to
 * selections. Customers and addresses behave the same as on the manager map,
 * and a stop that belongs to the current route also opens the route map.
 */
export default function RepUnifiedSearch({ routeProperties = [], onOpenProperty, onLocateOnRoute }) {
  const [leadDraft, setLeadDraft] = useState(null);

  const handleSelect = useCallback((result) => {
    if (result.type === 'address') {
      setLeadDraft(result);
      return;
    }
    if (result.type === 'county') {
      // The rep surface has no persistent territory map to fit a county to.
      toast.info('County search is available on the manager map.');
      return;
    }

    const { property, locatable } = resolveSelectedProperty(result, routeProperties);
    const onRoute = routeProperties.some((stop) => (
      stop?.address_hash && (stop.address_hash === property.address_hash || stop.legacy_hash === property.address_hash)
    ));
    onOpenProperty?.(property);
    if (!locatable) {
      toast.warning('This record has no usable map location, so it could not be shown on the map.');
      return;
    }
    if (onRoute) onLocateOnRoute?.(property);
  }, [onLocateOnRoute, onOpenProperty, routeProperties]);

  useEffect(() => {
    const onGlobalSelect = (event) => {
      const result = event.detail?.result;
      if (!result) return;
      event.preventDefault();
      handleSelect(result);
    };
    window.addEventListener(GLOBAL_SEARCH_EVENT, onGlobalSelect);
    return () => window.removeEventListener(GLOBAL_SEARCH_EVENT, onGlobalSelect);
  }, [handleSelect]);

  useEffect(() => {
    const pending = takePendingSelection();
    if (pending) handleSelect(pending);
    // Only a selection parked before this page loaded should replay, once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!leadDraft) return null;

  return (
    <AddLeadFromAddressDialog
      addressResult={leadDraft}
      onCancel={() => setLeadDraft(null)}
      onCreated={(property, { duplicate }) => {
        setLeadDraft(null);
        onOpenProperty?.(property);
        toast.success(duplicate
          ? 'This address already existed in FirstKnock — opening the existing record.'
          : 'Lead added. Your manager can route it from the map.');
      }}
    />
  );
}