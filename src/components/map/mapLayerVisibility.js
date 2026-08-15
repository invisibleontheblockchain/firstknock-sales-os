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

export function shouldRenderPrecisionMapLayers({ routeMode } = {}) {
  // Canvas is territory-first and owns the whole map while it is active: no
  // Precision property pins, saved-route overviews, or heatmap belong in it.
  // Switching back to Precision restores every one of those layers.
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