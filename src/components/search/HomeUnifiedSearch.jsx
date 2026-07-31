import React, { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import UnifiedMapSearch from './UnifiedMapSearch';
import AddLeadFromAddressDialog from './AddLeadFromAddressDialog';
import { fitMapBounds, focusMapPoint, resolveSelectedProperty } from './searchSelection';
import { removeSearchedAddressMarker, showSearchedAddressMarker } from './searchedAddressLayer';

/**
 * Unified search overlay for the manager map.
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
  className = '',
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
    if (result.type === 'county') {
      claimViewport();
      // County navigation only moves the camera — routes, territories, markers
      // and filters are left exactly as they were.
      const fitted = result.bounds
        ? fitMapBounds(mapRef, result.bounds, { padding: [40, 40], maxZoom: 12 })
        : focusMapPoint(mapRef, result, 10);
      if (!fitted) toast.error('That county could not be located on the map.');
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

  return (
    <>
      <div className={`pointer-events-auto absolute left-1/2 top-3 z-[1100] w-[min(92vw,26rem)] -translate-x-1/2 ${className}`}>
        <UnifiedMapSearch onSelect={handleSelect} onClear={clearSearchedAddress} />
      </div>
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