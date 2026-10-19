// The opening move: one continuous camera move over the hero house, from the hero photo (its
// first frame) rising and tilting to about 80 degrees by the time section 01 ("It starts with
// one front door") is on screen, then turning straight down and climbing until the whole
// subdivision is in view by section 02 ("Draw your territory"). Built from the one-house master
// (four start-frame Kling clips, each starting on the previous one's last frame, so the house
// never changes), frames picked so each step carries about the same motion. 1912 x 1080 (the
// layer's aspect to within 0.1%), 24 fps, every frame a keyframe so scroll can seek anywhere at once.
export const FLYOVER_SRC = {
  wide: '/landing/flyover-house-desktop.mp4', // 1912 x 1080
  portrait: '/landing/flyover-house-phone.mp4', // the middle 864 x 1080 of the same frames, at higher quality for 3x screens
};
export const FLYOVER_FRAMES = 180;
export const DOOR_FRAME = 39; // the master's frame 304: the ~80 degree view for section 01
// Screens this narrow see only the middle of the frame until #sat covers it (SatelliteLanding.css
// places the crop); the camera only pulls back once #sat is up.
export const PORTRAIT_QUERY = '(max-aspect-ratio: 3/5)';

export const SATELLITE_STILLS = {
  // #sat: the video's last frame (the subdivision) as a still, in the layer's aspect (1910 x 1080:
  // the frame less the ~1 px the video's cover crop trims each side), so the switch is invisible.
  end: { avif: '/landing/satellite-house-end.avif', webp: '/landing/satellite-house-end.webp', jpg: '/landing/satellite-house-end.jpg' },
  // The same frame inside a 2x outpaint of the same subdivision in the same light (3816 x 2130, the
  // frame at END_WIDE.frameX/Y, the same pixels beyond its 140 px inner feather): the camera pulls
  // back inside it first, so for the first 2x everything on screen is that one subdivision.
  wide: { avif: '/landing/satellite-house-wide.avif', webp: '/landing/satellite-house-wide.webp', jpg: '/landing/satellite-house-wide.jpg' },
};
export const END_WIDE = { frameX: 941, frameY: 517, width: 3816, height: 2130, mask: '/landing/satellite-house-wide-mask.png' };
// Where the frame sits in the region map (region px). The map has the whole composite pasted there
// under the same soft, irregular edge as the wide layer's mask, graded toward the terrain around it
// (more toward the edge) and with the map around it warmed toward it a little, so it takes over
// from the same place with no patch of a different colour.
export const END_PATCH = { k: 0.12, cx: 1284.86, cy: 762.6 };

export const MOVE_START = 0.08; // scroll (screens) where the flyover starts
export const HANDOFF_AT = MOVE_START + 0.01; // the video takes over here, on its first frame

// Scroll (screens) -> video frame. The move starts at MOVE_START, shows DOOR_FRAME when section
// 01's heading is fully on screen (door) and its last frame when section 02's is (end): a monotone
// cubic through those three points (PCHIP), still at both ends, so the camera never jumps speed.
// door and end come from the page layout (phones show each heading later than desktops).
export function flyoverFrame(cur, door, end, frames = FLYOVER_FRAMES, doorFrame = DOOR_FRAME) {
  const x0 = MOVE_START, last = frames - 1;
  if (!(cur > x0)) return 0;
  if (cur >= end) return last;
  const h0 = door - x0, h1 = end - door, d0 = doorFrame / h0, d1 = (last - doorFrame) / h1;
  const w1 = 2 * h1 + h0, w2 = h1 + 2 * h0;
  const m = Math.min((w1 + w2) / (w1 / d0 + w2 / d1), 3 * d0, 3 * d1);
  const hermite = (t, y0, y1, h, m0, m1) => (2 * t ** 3 - 3 * t ** 2 + 1) * y0 + (t ** 3 - 2 * t ** 2 + t) * h * m0 + (3 * t ** 2 - 2 * t ** 3) * y1 + (t ** 3 - t ** 2) * h * m1;
  return cur < door ? hermite((cur - x0) / h0, 0, doorFrame, h0, 0, m) : hermite((cur - door) / h1, doorFrame, last, h1, m, 0);
}

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

// #sat, the still of the video's last frame, fades in once the video shows that frame. The
// camera follows a flick at once, so the video can still be on an earlier frame when the fade
// starts (its seeks haven't caught up, or it hasn't loaded): then #sat covers it at once
// instead, so a different frame never shows through the part-transparent still.
export const SAT_MATCH_FRAMES = 1;
export function satelliteOpacity(fade, ready, framesFromEnd) {
  if (!(fade > 0)) return 0;
  return ready && framesFromEnd < SAT_MATCH_FRAMES ? fade : 1;
}
