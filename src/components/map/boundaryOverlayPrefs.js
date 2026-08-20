/**
 * ZIP and county boundary visibility.
 *
 * These are per-device display preferences, so they live in localStorage and are
 * broadcast the same way the navigation-app preference is — the settings panel
 * writes, the map layer listens. That keeps the toggles out of the Home page's
 * prop chain and makes them survive a reload.
 */

const EVENT = 'fk-boundary-overlays-changed';
const KEYS = { zip: 'fk_showZipOverlay', county: 'fk_showCountyOverlay' };

export function getBoundaryOverlays() {
  try {
    return {
      zip: localStorage.getItem(KEYS.zip) === 'true',
      county: localStorage.getItem(KEYS.county) === 'true',
    };
  } catch {
    return { zip: false, county: false };
  }
}

export function previewBoundaryOverlays(overlays) {
  const next = { zip: Boolean(overlays?.zip), county: Boolean(overlays?.county) };
  window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
  return next;
}

export function saveBoundaryOverlays(overlays) {
  const next = previewBoundaryOverlays(overlays);
  try {
    localStorage.setItem(KEYS.zip, next.zip ? 'true' : 'false');
    localStorage.setItem(KEYS.county, next.county ? 'true' : 'false');
  } catch { /* private mode */ }
  return next;
}

export function setBoundaryOverlay(name, value) {
  return saveBoundaryOverlays({ ...getBoundaryOverlays(), [name]: Boolean(value) });
}

export function subscribeBoundaryOverlays(onChange) {
  const handler = (event) => onChange(event.detail || getBoundaryOverlays());
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}