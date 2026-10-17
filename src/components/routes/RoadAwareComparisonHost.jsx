import React, { useEffect, useState } from 'react';
import { subscribeRoadAwareApproval } from '@/lib/roadAwareBetaApproval';

// The comparison map (Leaflet and its tiles) loads only when a preview opens,
// so it no longer rides in the first download of every page.
const RoadAwareComparisonView = React.lazy(() => import('./RoadAwareComparisonView'));

export default function RoadAwareComparisonHost() {
    const [preview, setPreview] = useState(null);
    useEffect(() => subscribeRoadAwareApproval(setPreview), []);
    return preview ? (
        <React.Suspense fallback={null}>
            <RoadAwareComparisonView key={preview.result.comparisonId} preview={preview} />
        </React.Suspense>
    ) : null;
}
