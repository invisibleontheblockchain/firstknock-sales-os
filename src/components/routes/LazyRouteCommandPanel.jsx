import React from 'react';

// Retry wrapper for dynamic import — handles transient Vite HMR failures
function retryImport(fn, retries = 3, delay = 500) {
    return fn().catch((err) => {
        if (retries <= 0) throw err;
        return new Promise(r => setTimeout(r, delay)).then(() => retryImport(fn, retries - 1, delay * 2));
    });
}

const LazyRouteCommandPanel = React.lazy(() =>
    retryImport(() => import('./RouteCommandPanel'))
);

export default LazyRouteCommandPanel;