// The opening move: one continuous flyover of the hero house in golden-hour daylight, from
// the hero photo (its first frame) up to the overhead and on to the neighbourhood, whose
// last frame is satellite-hero-day (the #sat still the scene crossfades to; the region,
// metro and state views after it are daylight too). Built from two approved generated
// clips: joined on their shared overhead frame, the still stretches trimmed, the zoom-out's
// blended stretch (two layouts of the street from ~2.9 s) left out: after its last clean
// frame, one cut onto the sharp 4K satellite still at the same framing (the house matched
// in position and scale), then a digital zoom-out on that still to the #sat framing, which
// can't morph, with the light eased from golden to daylight. Frames are picked so each step
// carries about the same motion; 24 fps, every frame a keyframe so scroll can seek anywhere.
export const FLYOVER_SRC = {
  wide: '/landing/flyover-golden-v3-desktop.mp4', // 1920 x 1080
  portrait: '/landing/flyover-golden-v3-phone.mp4', // the middle 864 x 1080 of the same frames, at higher quality for 3x screens
};
// Screens this narrow see only the middle of the frame until #sat covers it, even as
// the camera starts to pull back (SatelliteLanding.css places the crop).
export const PORTRAIT_QUERY = '(max-aspect-ratio: 3/5)';

export const SATELLITE_STILLS = {
  // #sat and the roof hold: the 4K re-render in the layer's aspect, so close zooms stay sharp
  // on 3x phones. It fills the same layer as the hero photo, hence the same sizes rule.
  tight: {
    avif: '/landing/satellite-hero-day-2688.avif 2688w, /landing/satellite-hero-day-3820.avif 3820w',
    webp: '/landing/satellite-hero-day-2688.webp 2688w, /landing/satellite-hero-day-3820.webp 3820w',
    jpg: '/landing/satellite-hero-day-2688.jpg',
    sizes: '(max-aspect-ratio: 2688/1520) 177vh, 100vw',
  },
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
