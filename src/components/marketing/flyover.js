// The opening move: one continuous flyover of the hero house, from the hero photo (its
// first frame) up to the overhead and on to the dusk neighbourhood, whose last frame is
// satellite-hero-dusk (the #sat still the scene crossfades to). Built from two approved
// generated clips: joined on their shared overhead frame, the still stretches trimmed and
// frames picked so each step carries about the same motion, 24 fps, every frame a
// keyframe so scroll can seek anywhere at once.
export const FLYOVER_SRC = {
  wide: '/landing/flyover-hero-desktop.mp4', // 1920 x 1080
  portrait: '/landing/flyover-hero-phone.mp4', // the middle 864 x 1080 of the same frames
};
// Screens this narrow see only the middle of the frame until #sat covers it, even as
// the camera starts to pull back (SatelliteLanding.css places the crop).
export const PORTRAIT_QUERY = '(max-aspect-ratio: 3/5)';

export const DUSK_STILLS = {
  tight: { avif: '/landing/satellite-hero-dusk.avif', webp: '/landing/satellite-hero-dusk.webp', jpg: '/landing/satellite-hero-dusk.jpg' },
  wide: { avif: '/landing/satellite-zoom-hero-dusk.avif', webp: '/landing/satellite-zoom-hero-dusk.webp', jpg: '/landing/satellite-zoom-hero-dusk.jpg' },
};

const MOVE_START = 0.08; // scroll (screens) where the flyover starts (satelliteScene.js)
const HANDOFF = 0.02; // screens over which the video's first frame fades in over the photo

// The video over the hero photo: hidden at rest and until it has a frame to show; its
// first frame is the photo, so it fades in over it before the camera starts to move.
// Showing any later frame (a seek still landing, a fast scroll back) it stays fully
// opaque, so a moved house never blends over the photo.
export function flyoverOpacity(cur, hasFrame, onFirstFrame = true) {
  if (!hasFrame) return 0;
  if (!onFirstFrame) return 1;
  return Math.min(1, Math.max(0, (cur - MOVE_START) / HANDOFF));
}
