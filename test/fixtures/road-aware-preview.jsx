import React from 'react';
import { createRoot } from 'react-dom/client';
import { RoadAwareComparisonView } from '../../src/components/routes/RoadAwareComparisonHost';
import '../../src/index.css';
import 'leaflet/dist/leaflet.css';

// Synthetic UI fixture; no saved route or provider API is connected.
const properties = Array.from({ length: 6 }, (_, i) => ({ address_hash: String(i), address: 'Synthetic stop ' + (i + 1),
    lat: 35.04 + i / 8000, lng: -80.88 + (i % 2) / 8000 }));
const selected = [properties[0], properties[1], properties[4], properties[3], properties[2], properties[5]];
const points = order => order.map(p => ({ lat: p.lat, lng: p.lng }));
createRoot(document.getElementById('root')).render(<RoadAwareComparisonView preview={{
    routeName: 'Synthetic internal pilot', properties, canApply: true,
    result: { properties: selected, comparisonId: 'synthetic', comparison: { before: { miles: 10, seconds: 3600 },
        after: { miles: 9, seconds: 3000 }, milesSaved: 1, secondsSaved: 600, membershipCount: 6,
        fullMeasurement: false, unresolvedCount: 1, unresolvedIds: ['5'], fallbackWindows: 1, acceptedRegressions: 0,
        reason: 'PARTIAL_ROAD_COVERAGE' },
        geometry: { current: [{ points: points(properties.slice(0, 5)) }], selected: [{ points: points(selected.slice(0, 5)) }] } },
    decide: value => { document.getElementById('root').textContent = value ? 'Use New Route chosen (fixture only)' : 'Keep Current chosen (fixture only)'; },
}} />);
