import React, { useMemo, useState } from 'react';
import FindMap from '@/components/find/FindMap';
import FindOverlay from '@/components/find/FindOverlay';
import { estimateHomeowners, teaserPoints } from '@/components/find/findEstimate';
import { geocodeAddress } from '@/lib/geocoding';

// Public acquisition page for ad traffic (firstknock.online/find).
// Unauthenticated by design: visitors search an area, draw a territory, and
// see an estimated preview. Signup only gates the unlock step.
export default function Find() {
  const [phase, setPhase] = useState('idle'); // idle | drawing | results
  const [lookbackDays, setLookbackDays] = useState(14);
  const [center, setCenter] = useState(null);
  const [searchedLabel, setSearchedLabel] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [points, setPoints] = useState([]);

  const estimate = useMemo(
    () => (phase === 'results' ? estimateHomeowners(points, lookbackDays) : 0),
    [phase, points, lookbackDays]
  );
  const teaser = useMemo(
    () => (phase === 'results' ? teaserPoints(points, estimate) : []),
    [phase, points, estimate]
  );

  const handleSearch = async (query) => {
    setSearching(true);
    setSearchError('');
    try {
      const result = await geocodeAddress(query);
      setCenter({ lat: result.lat, lng: result.lng });
      setSearchedLabel(result.address.split(',').slice(0, 2).join(',').trim());
    } catch (error) {
      setSearchError(error?.message || 'We could not find that place. Try adding the state.');
    } finally {
      setSearching(false);
    }
  };

  const resetDraw = () => {
    setPoints([]);
    setPhase('idle');
  };

  return (
    <div className="fixed inset-0 overflow-hidden bg-black">
      <FindMap
        center={center}
        drawing={phase === 'drawing'}
        polygonPoints={points}
        closed={phase === 'results'}
        teaser={teaser}
        onAddPoint={(p) => setPoints((current) => [...current, p])}
      />
      <FindOverlay
        phase={phase}
        lookbackDays={lookbackDays}
        onLookbackChange={setLookbackDays}
        onSearch={handleSearch}
        searching={searching}
        searchError={searchError}
        searchedLabel={searchedLabel}
        pointCount={points.length}
        estimate={estimate}
        onStartDraw={() => { setPoints([]); setPhase('drawing'); }}
        onFinishDraw={() => setPhase('results')}
        onCancelDraw={resetDraw}
        onReset={resetDraw}
      />
    </div>
  );
}