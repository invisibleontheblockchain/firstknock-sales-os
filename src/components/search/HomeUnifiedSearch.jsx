import React, { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import AddLeadFromAddressDialog from './AddLeadFromAddressDialog';
import { fitMapBounds, focusMapPoint, resolveSelectedProperty } from './searchSelection';
import { removeSearchedAddressMarker, showSearchedAddressMarker } from './searchedAddressLayer';
import { GLOBAL_SEARCH_EVENT, takePendingSelection } from './globalSearchBridge';

/**
 * Search result handler for the manager map.
 *
 * The search field itself lives in the app header; this component only reacts
 * to selections made there.
 *
 * Selecting a result is the authoritative viewport action: the initial
 * working-area fit is marked as applied so a later data-loading effect cannot
 * zoom back out to the continental US over an explicit selection.
 */
export default function HomeUnifiedSearch({
  mapRef,
  properties = [],
  onOpenProperty,
  onRefreshProperties,
  workingAreaCenteredRef,
}) {
  const [leadDraft, setLeadDraft] = useState(null);
  const markerRef = useRef(null);

  const clearSearchedAddress = useCallback(() => {
    removeSearchedAddressMarker(mapRef, markerRef.current);
    markerRef.current = null;
  }, [mapRef]);

  useEffect(() => clearSearchedAddress, [clearSearchedAddress]);

  const claimViewport = useCallback(() => {
    if (workingAreaCenteredRef) workingAreaCenteredRef.current = true;
  }, [workingAreaCenteredRef]);

  const handleSelect = useCallback((result) => {
    if (result.type === 'county' || result.type === 'city') {
      claimViewport();
      // Place navigation only moves the camera — routes, territories, markers
      // and filters are left exactly as they were.
      const isCity = result.type === 'city';
      const fitted = result.bounds
        ? fitMapBounds(mapRef, result.bounds, { padding: [40, 40], maxZoom: isCity ? 13 : 12 })
        : focusMapPoint(mapRef, result, isCity ? 12 : 10);
      if (!fitted) toast.error(`That ${isCity ? 'city' : 'county'} could not be located on the map.`);
      return;
    }

    if (result.type === 'address') {
      claimViewport();
      clearSearchedAddress();
      focusMapPoint(mapRef, result, 18);
      markerRef.current = showSearchedAddressMarker(mapRef, result, {
        onAddLead: (addressResult) => setLeadDraft(addressResult),
        onDismiss: clearSearchedAddress,
      });
      return;
    }

    const { property, locatable } = resolveSelectedProperty(result, properties);
    if (!locatable) {
      // The record still opens; it simply cannot be placed on the map.
      onOpenProperty?.(property);
      toast.warning('This record has no usable map location, so it could not be centered.');
      return;
    }
    claimViewport();
    clearSearchedAddress();
    focusMapPoint(mapRef, property, 18);
    onOpenProperty?.(property);
  }, [claimViewport, clearSearchedAddress, mapRef, onOpenProperty, properties]);

  useEffect(() => {
    const onGlobalSelect = (event) => {
      const result = event.detail?.result;
      if (!result) return;
      // Claim the event so the launcher does not navigate away from the map.
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

  return (
    <>
      {leadDraft && (
        <AddLeadFromAddressDialog
          addressResult={leadDraft}
          onCancel={() => setLeadDraft(null)}
          onCreated={async (property, { duplicate }) => {
            setLeadDraft(null);
            clearSearchedAddress();
            await onRefreshProperties?.();
            onOpenProperty?.(property);
            toast.success(duplicate
              ? 'This address already existed in FirstKnock — opening the existing record.'
              : 'Lead added to your territory.');
          }}
        />
      )}
    </>
  );
}