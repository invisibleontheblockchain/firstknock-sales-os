import React, { useEffect, useState } from 'react';
import ZipCodeOverlay from '@/components/map/ZipCodeOverlay';
import CountyBoundariesLayer from '@/components/map/CountyBoundariesLayer';
import { getBoundaryOverlays, subscribeBoundaryOverlays } from '@/components/map/boundaryOverlayPrefs';

/** Boundary reference lines for the map: ZIP areas and county lines. */
export default function BoundaryOverlays({ properties = [] }) {
  const [overlays, setOverlays] = useState(getBoundaryOverlays);

  useEffect(() => subscribeBoundaryOverlays(setOverlays), []);

  return (
    <>
      {overlays.zip && <ZipCodeOverlay properties={properties} />}
      {overlays.county && <CountyBoundariesLayer />}
    </>
  );
}