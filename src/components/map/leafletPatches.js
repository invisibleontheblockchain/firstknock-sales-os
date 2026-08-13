import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Default marker icons + two defensive patches for fast unmount / scroll-wheel
// zoom races that otherwise throw inside Leaflet during navigation.
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

const originalGetMapPanePos = L.Map.prototype._getMapPanePos;
if (originalGetMapPanePos) {
  L.Map.prototype._getMapPanePos = function patchedGetMapPanePos() {
    if (!this._mapPane) return L.point(0, 0);
    return originalGetMapPanePos.call(this);
  };
}

const originalSetPosition = L.DomUtil.setPosition;
if (originalSetPosition) {
  L.DomUtil.setPosition = function patchedSetPosition(el, point) {
    if (!el) return undefined;
    return originalSetPosition.call(this, el, point);
  };
}

// Leaflet can retain one scheduled Canvas redraw after React has removed the
// renderer. Ignore that stale frame once its map or 2D context is gone.
const originalCanvasRedraw = L.Canvas.prototype._redraw;
if (originalCanvasRedraw) {
  L.Canvas.prototype._redraw = function patchedCanvasRedraw() {
    if (!this._map || !this._ctx) {
      this._redrawRequest = null;
      return undefined;
    }
    return originalCanvasRedraw.call(this);
  };
}

// Touch-friendly hit detection: give every canvas-rendered pin and route line
// ~12px of extra tap slop so small markers are easy to tap on mobile.
L.Canvas.mergeOptions({ tolerance: 12 });

export default L;