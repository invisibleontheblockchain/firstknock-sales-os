/**
 * Pin themes — one click sets the dots, the route paths, and the colour scheme
 * together.
 *
 * These used to be three separate sections of sliders (dot fill, line pattern,
 * colour scheme) that a manager had to tune individually to get a look that
 * matched. A theme is just a patch of the same mapSettings keys plus a pin size,
 * so the individual controls still work underneath for anyone who wants them.
 */

export const PIN_THEMES = [
  {
    id: 'command',
    label: 'Command',
    hint: 'Sharp green dots, dashed paths',
    swatch: ['#2EEB57', '#00F5A0', '#FFD93D', '#FF6B6B'],
    settings: {
      colorScheme: 'default', fillStyle: 'solid', glowEffect: false,
      pinOpacity: 0.9, pinBorderWidth: 1, pinBorderColor: '#000',
      lineStyle: 'dashed', lineWidth: 2, lineOpacity: 0.5,
    },
    pinSize: 4,
  },
  {
    id: 'neon_grid',
    label: 'Neon Grid',
    hint: 'Glowing pins, bright paths',
    swatch: ['#00fff7', '#39ff14', '#ffed00', '#ff073a'],
    settings: {
      colorScheme: 'neon', fillStyle: 'glow', glowEffect: true,
      pinOpacity: 1, pinBorderWidth: 0, pinBorderColor: '#000',
      lineStyle: 'solid', lineWidth: 3, lineOpacity: 0.8,
    },
    pinSize: 5,
  },
  {
    id: 'heat',
    label: 'Heat',
    hint: 'Warm density read',
    swatch: ['#ff4500', '#ff8c00', '#8b0000', '#1e3a5f'],
    settings: {
      colorScheme: 'heatmap', fillStyle: 'solid', glowEffect: true,
      pinOpacity: 0.95, pinBorderWidth: 0, pinBorderColor: '#000',
      lineStyle: 'dotted', lineWidth: 2, lineOpacity: 0.45,
    },
    pinSize: 6,
  },
  {
    id: 'soft',
    label: 'Soft',
    hint: 'Low-contrast, easy on the eyes',
    swatch: ['#a8b8c8', '#77dd77', '#fff176', '#b39ddb'],
    settings: {
      colorScheme: 'pastel', fillStyle: 'solid', glowEffect: false,
      pinOpacity: 0.75, pinBorderWidth: 0.5, pinBorderColor: '#000',
      lineStyle: 'solid', lineWidth: 1.5, lineOpacity: 0.35,
    },
    pinSize: 4,
  },
  {
    id: 'outline',
    label: 'Outline',
    hint: 'Hollow dots, thin paths',
    swatch: ['#ffffff', '#2EEB57', '#888888', '#555555'],
    settings: {
      colorScheme: 'monochrome', fillStyle: 'outline', glowEffect: false,
      pinOpacity: 0.9, pinBorderWidth: 2, pinBorderColor: '#000',
      lineStyle: 'dashdot', lineWidth: 1.5, lineOpacity: 0.5,
    },
    pinSize: 5,
  },
  {
    id: 'dense',
    label: 'Dense',
    hint: 'Tiny dots for big territories',
    swatch: ['#404040', '#00F5A0', '#FFD93D', '#FF6B6B'],
    settings: {
      colorScheme: 'default', fillStyle: 'solid', glowEffect: false,
      pinOpacity: 0.8, pinBorderWidth: 0, pinBorderColor: '#000',
      lineStyle: 'dotted', lineWidth: 1, lineOpacity: 0.3,
    },
    pinSize: 2,
  },
];

/** The theme whose every setting matches the current state, or null when tuned by hand. */
export function matchPinTheme(mapSettings = {}, pinSize = null) {
  return PIN_THEMES.find((theme) => (
    (pinSize === null || pinSize === theme.pinSize)
    && Object.entries(theme.settings).every(([key, value]) => mapSettings[key] === value)
  ))?.id || null;
}