// Map controls float over the map: the toolbar and the selected route's header
// card at the top, the Run Route button at the bottom. Fitting a route to the
// whole container centred it on the container instead of the part a person can
// see, and could hide its first rows of stops under the header card. Overlays
// that cover the map mark themselves with data-map-inset="top" or "bottom", and
// fits use the area they leave visible.
export const MAP_FIT_MARGIN = 30;

/**
 * How far top and bottom overlays reach into the map, in CSS pixels.
 * @param {Element} mapElement the Leaflet container
 * @param {ParentNode} [root]
 */
export function measureMapInsets(mapElement, root = globalThis.document) {
  const insets = { top: 0, bottom: 0 };
  if (!mapElement?.getBoundingClientRect || !root?.querySelectorAll) return insets;
  const map = mapElement.getBoundingClientRect();
  root.querySelectorAll('[data-map-inset]').forEach((element) => {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return; // hidden
    if (rect.right <= map.left || rect.left >= map.right || rect.bottom <= map.top || rect.top >= map.bottom) return;
    const side = element.getAttribute('data-map-inset');
    if (side === 'top') insets.top = Math.max(insets.top, Math.min(rect.bottom, map.bottom) - map.top);
    if (side === 'bottom') insets.bottom = Math.max(insets.bottom, map.bottom - Math.max(rect.top, map.top));
  });
  // Never let overlays claim the whole map; keep at least a third visible.
  const limit = Math.max(0, map.height * (2 / 3));
  const total = insets.top + insets.bottom;
  if (total > limit && total > 0) {
    insets.top = Math.round(insets.top * (limit / total));
    insets.bottom = Math.round(insets.bottom * (limit / total));
  }
  return insets;
}

export function visibleAreaFitOptions(insets, { margin = MAP_FIT_MARGIN, maxZoom = 17, animate = false } = {}) {
  return {
    paddingTopLeft: [margin, (insets?.top || 0) + margin],
    paddingBottomRight: [margin, (insets?.bottom || 0) + margin],
    maxZoom,
    animate,
  };
}

/** Fits bounds inside the part of the map the overlays leave visible. */
export function fitBoundsToVisibleArea(map, bounds, options = {}) {
  if (!map?._mapPane || !bounds) return;
  const insets = measureMapInsets(map.getContainer());
  map.fitBounds(bounds, visibleAreaFitOptions(insets, options));
}
