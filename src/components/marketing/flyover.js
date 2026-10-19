// The opening move: one continuous flyover of the hero house in golden-hour daylight, from
// the hero photo (its first frame) up to the overhead and on to the neighbourhood, whose
// last frame is satellite-hero-day (the #sat still the scene crossfades to; the region,
// metro and state views after it are daylight too). Built from two approved generated
// clips: joined on their shared overhead frame, the still stretches trimmed, the zoom-out's
// blended stretch (two layouts of the street at ~3 s) left out with a cut between the clean
// frames either side, and frames picked so each step carries about the same motion; 24 fps,
// every frame a keyframe so scroll can seek anywhere at once.
export const FLYOVER_SRC = {
  wide: '/landing/flyover-golden-v2-desktop.mp4', // 1920 x 1080
  portrait: '/landing/flyover-golden-v2-phone.mp4', // the middle 864 x 1080 of the same frames, at higher quality for 3x screens
};
// Screens this narrow see only the middle of the frame until #sat covers it, even as
// the camera starts to pull back (SatelliteLanding.css places the crop).
export const PORTRAIT_QUERY = '(max-aspect-ratio: 3/5)';

export const SATELLITE_STILLS = {
  tight: { avif: '/landing/satellite-hero-day.avif', webp: '/landing/satellite-hero-day.webp', jpg: '/landing/satellite-hero-day.jpg' },
  wide: { avif: '/landing/satellite-zoom-hero-day.avif', webp: '/landing/satellite-zoom-hero-day.webp', jpg: '/landing/satellite-zoom-hero-day.jpg' },
};

const MOVE_START = 0.08; // scroll (screens) where the flyover starts (satelliteScene.js)
export const HANDOFF_AT = MOVE_START + 0.01; // the video takes over here, on its first frame

// The video over the hero photo: hidden at rest and until its first frame is ready (the
// scene seeks to it explicitly: iOS Safari otherwise shows a later frame after loading).
// That frame is the photo, so the video takes over in one frame as the camera starts to
// move, never faded: a fade would show two copies of the house if the two layers ever
// differed. Showing any later frame (a seek still landing, a fast scroll back) it stays
// fully opaque, so a moved house never sits over the photo.
export function flyoverOpacity(cur, ready, onFirstFrame = true) {
  if (!ready) return 0;
  if (!onFirstFrame) return 1;
  return cur >= HANDOFF_AT ? 1 : 0;
}
