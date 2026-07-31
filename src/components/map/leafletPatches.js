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

export default L;