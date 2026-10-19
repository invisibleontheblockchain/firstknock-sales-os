// The opening move: one continuous crane move over the hero house, from the hero photo (its
// first frame) rising and tilting to straight down, steep by the time section 01
// ("It starts with one front door") is on screen, then pulling back over the neighbourhood.
// Built from the approved Kling rise (frames picked so each step carries about the same
// motion) cut onto a digital zoom-out of the sharp 4K satellite still. The rise ends looking
// straight down at that still's framing (matched to under a pixel), its last frames graded
// to the still's colour, and the zoom-out starts at the rise's own speed, so at the cut only
// the sharpness changes; it eases out onto exactly the image #sat shows. 1912 x 1080 (the rise's
// own size, the layer's aspect to within 0.1%), 24 fps, every frame a keyframe so scroll can
// seek anywhere at once.
export const FLYOVER_SRC = {
  wide: '/landing/flyover-rise-desktop.mp4', // 1912 x 1080
  portrait: '/landing/flyover-rise-phone.mp4', // the middle 864 x 1080 of the same frames, at higher quality for 3x screens
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

// #sat, the 4K still the move ends on, fades in over the video's last frames, which are that
// same view (the last 5 are within 0.4% of its zoom). The camera follows a flick at once, so
// the video can still be on an earlier frame when the fade starts (its seeks haven't caught
// up, or it hasn't loaded): then #sat covers it at once instead, so a different frame never
// shows through the part-transparent still.
export const SAT_MATCH_FRAMES = 5;
export function satelliteOpacity(fade, ready, framesFromEnd) {
  if (!(fade > 0)) return 0;
  return ready && framesFromEnd < SAT_MATCH_FRAMES ? fade : 1;
}
