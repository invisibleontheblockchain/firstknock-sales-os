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
    && (lat !== 0 || lng !== 0)
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

export function shouldRenderPrecisionPropertyPins({ routeMode } = {}) {
  // Canvas is territory-first: it has no property inventory of its own, so the
  // Precision property pins are not its data and must stay out of its map.
  // Saved routes and a selected route are still owned by
  // shouldRenderPrecisionMapLayers above.
  return routeMode !== 'canvas';
}

export function filterRoutesByStatus(routes = [], routeStatusView = 'all') {
  if (!Array.isArray(routes)) return [];
  const visibleRoutes = routes.filter((route) => route?.status !== 'ARCHIVED');
  if (routeStatusView === 'completed') {
    return visibleRoutes.filter((route) => route?.status === 'COMPLETED');
  }
  if (routeStatusView === 'active') {
    return visibleRoutes.filter((route) => route?.status !== 'COMPLETED');
  }
  return visibleRoutes;
}