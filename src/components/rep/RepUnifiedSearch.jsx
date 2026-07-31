import React, { useCallback, useState } from 'react';
import { toast } from 'sonner';
import UnifiedMapSearch from '@/components/search/UnifiedMapSearch';
import AddLeadFromAddressDialog from '@/components/search/AddLeadFromAddressDialog';
import { resolveSelectedProperty } from '@/components/search/searchSelection';

/**
 * Unified search for the rep Home screen.
 *
 * Counties are not offered here: the rep surface has no persistent territory
 * map to fit them to. Customers and addresses behave the same as on the manager
 * map, and a stop that belongs to the current route also opens the route map.
 */
export default function RepUnifiedSearch({ routeProperties = [], onOpenProperty, onLocateOnRoute }) {
  const [leadDraft, setLeadDraft] = useState(null);

  const handleSelect = useCallback((result) => {
    if (result.type === 'address') {
      setLeadDraft(result);
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

  return (
    <>
      <UnifiedMapSearch
        onSelect={handleSelect}
        enableCounties={false}
        placeholder="Search customers or addresses…"
      />
      {leadDraft && (
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
      )}
    </>
  );
}