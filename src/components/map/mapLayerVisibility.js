export function isRenderableMapPoint(point) {
  if (!point) return false;
  if (
    point.lat === null
    || point.lat === undefined
    || point.lat === ''
    || point.lng === null
    || point.lng === undefined
    || point.lng === ''
  ) return false;
  const lat = Number(point.lat);
  const lng = Number(point.lng);
  return Number.isFinite(lat)
    && Number.isFinite(lng)
    && lat >= -90
    && lat <= 90
    && lng >= -180
    && lng <= 180;
}

export function shouldRenderPrecisionMapLayers({ mode, routeMode, activeRoute } = {}) {
  // Canvas is a builder choice. It must not hide the saved-route overview, or
  // a selected saved route, after the manager returns to the main map.
  return routeMode !== 'canvas' || mode === 'analyze' || Boolean(activeRoute);
}

export function filterRoutesByStatus(routes = [], routeStatusView = 'all') {
  if (!Array.isArray(routes)) return [];
  if (routeStatusView === 'completed') {
    return routes.filter((route) => route?.status === 'COMPLETED');
  }
  if (routeStatusView === 'active') {
    return routes.filter((route) => route?.status !== 'COMPLETED');
  }
  return routes;
}
