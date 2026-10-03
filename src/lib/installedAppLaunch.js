import { getLandingDestinations } from './landingNavigation.js';

const INSTALLED_DISPLAY_MODES = ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay'];

export function getInstalledAppDestination({
  browserWindow = globalThis.window,
  isNative = false,
  search = '',
  hash = '',
} = {}) {
  const isInstalled = isNative
    || browserWindow?.navigator?.standalone === true
    || INSTALLED_DISPLAY_MODES.some((mode) => (
      browserWindow?.matchMedia?.(`(display-mode: ${mode})`).matches === true
    ));

  if (!isInstalled) return null;
  return `${getLandingDestinations({ search }).appEntry}${hash}`;
}
