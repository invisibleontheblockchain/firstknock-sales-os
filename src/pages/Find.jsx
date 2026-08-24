import React, { useCallback, useMemo, useRef, useState } from 'react';
import FindMap from '@/components/find/FindMap';
import FindOverlay from '@/components/find/FindOverlay';
import { estimateHomeowners, teaserPoints } from '@/components/find/findEstimate';

// Public acquisition page for ad traffic (firstknock.online/find).
// Unauthenticated by design: visitors search an area, freehand-draw a territory,
// and see an estimated preview. Signup only gates route generation.
export default function Find() {
  const [phase, setPhase] = useState('idle'); // idle | drawing | results
  const [lookbackDays, setLookbackDays] = useState(90);
  const [center, setCenter] = useState(null);
  const [searchedLabel, setSearchedLabel] = useState('');
  const [points, setPoints] = useState([]);
  // Freehand samples arrive faster than React commits, so the live stroke is
  // tracked in a ref and mirrored into state for rendering.
  const strokeRef = useRef([]);

  const estimate = useMemo(
    () => (phase === 'results' ? estimateHomeowners(points, lookbackDays) : 0),
    [phase, points, lookbackDays]
  );
  const teaser = useMemo(
    () => (phase === 'results' ? teaserPoints(points, estimate) : []),
    [phase, points, estimate]
  );

  const handleSelectPlace = (place) => {
    setCenter({ lat: place.lat, lng: place.lng });
    setSearchedLabel([place.label, place.sublabel].filter(Boolean).join(', '));
  };

  const beginStroke = useCallback(() => {
    strokeRef.current = [];
    setPoints([]);
  }, []);

  const addStrokePoint = useCallback((point) => {
    strokeRef.current = [...strokeRef.current, point];
    setPoints(strokeRef.current);
  }, []);

  // Releasing the stroke closes the shape. A stroke too short to form an area
  // resets so the visitor can trace again.
  const endStroke = useCallback(() => {
    if (strokeRef.current.length >= 3) {
      setPhase('results');
      return;
    }
    strokeRef.current = [];
    setPoints([]);
  }, []);

  const resetDraw = () => {
    strokeRef.current = [];
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
        onAddPoint={addStrokePoint}
        onStrokeStart={beginStroke}
        onStrokeEnd={endStroke}
      />
      <FindOverlay
        phase={phase}
        lookbackDays={lookbackDays}
        onLookbackChange={setLookbackDays}
        onSelectPlace={handleSelectPlace}
        searchedLabel={searchedLabel}
        pointCount={points.length}
        estimate={estimate}
        onStartDraw={() => { strokeRef.current = []; setPoints([]); setPhase('drawing'); }}
        onCancelDraw={resetDraw}
        onReset={resetDraw}
      />
    </div>
  );
}