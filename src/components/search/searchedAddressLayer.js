import L from 'leaflet';

// The temporary searched-address marker is created imperatively so it can live
// with the search UI instead of inside the map's React tree. It is deliberately
// styled differently from a stored FirstKnock pin and holds no database record.
const SEARCH_PIN = L.divIcon({
  className: '',
  html: '<div style="width:20px;height:20px;border-radius:50%;background:rgba(255,255,255,0.92);border:3px dashed #39FF4A;box-shadow:0 0 16px rgba(57,255,74,0.6)"></div>',
  iconSize: [20, 20],
  iconAnchor: [10, 10],
});

function popupContent(result, { onAddLead, onDismiss }) {
  const wrapper = document.createElement('div');
  wrapper.style.minWidth = '200px';

  const title = document.createElement('p');
  title.textContent = result.formatted_address || result.name || 'Searched address';
  title.style.cssText = 'margin:0;font-size:12px;font-weight:700';

  const note = document.createElement('p');
  note.textContent = 'Not in FirstKnock yet.';
  note.style.cssText = 'margin:4px 0 8px;font-size:11px;color:#555';

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px';

  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.textContent = 'Add as Lead';
  addButton.style.cssText = 'flex:1;padding:8px;border-radius:8px;border:none;background:#2EEB57;color:#000;font-weight:800;font-size:11px';
  addButton.addEventListener('click', () => onAddLead?.(result));

  const dismissButton = document.createElement('button');
  dismissButton.type = 'button';
  dismissButton.textContent = 'Dismiss';
  dismissButton.style.cssText = 'padding:8px;border-radius:8px;border:1px solid #ccc;background:#fff;font-size:11px;font-weight:700';
  dismissButton.addEventListener('click', () => onDismiss?.());

  row.append(addButton, dismissButton);
  wrapper.append(title, note, row);
  return wrapper;
}

export function showSearchedAddressMarker(mapRef, result, handlers = {}) {
  const map = mapRef?.current;
  const lat = Number(result?.lat);
  const lng = Number(result?.lng);
  if (!map || !map._mapPane || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const marker = L.marker([lat, lng], { icon: SEARCH_PIN, zIndexOffset: 1000 })
    .bindTooltip('Searched address', { direction: 'top', offset: [0, -12], permanent: true })
    .bindPopup(popupContent(result, handlers), { autoPan: false });
  marker.addTo(map);
  marker.openPopup();
  return marker;
}

export function removeSearchedAddressMarker(mapRef, marker) {
  const map = mapRef?.current;
  if (!marker) return;
  try {
    if (map) map.removeLayer(marker);
    else marker.remove();
  } catch {
    // The map may already be unmounted; nothing else to clean up.
  }
}