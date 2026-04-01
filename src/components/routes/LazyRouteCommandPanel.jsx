import React from 'react';

// Wrapper with retry logic for transient Vite HMR cache failures
const LazyRouteCommandPanel = React.lazy(() =>
    import('./RouteCommandPanel').catch(() => {
        // Retry once after a short delay
        return new Promise(r => setTimeout(r, 200)).then(() => import('./RouteCommandPanel'));
    })
);

export default LazyRouteCommandPanel;