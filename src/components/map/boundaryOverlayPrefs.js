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

export function setBoundaryOverlay(name, value) {
  const next = { ...getBoundaryOverlays(), [name]: Boolean(value) };
  try { localStorage.setItem(KEYS[name], value ? 'true' : 'false'); } catch { /* private mode */ }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
  return next;
}

export function subscribeBoundaryOverlays(onChange) {
  const handler = (event) => onChange(event.detail || getBoundaryOverlays());
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}