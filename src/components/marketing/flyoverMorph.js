// The landing flyover (flyover-roof-consistent.mp4) is AI-generated: as the drone
// rises, the clip redraws the house between these two times. Before MORPH_FROM it is
// the hero photo's house seen from the front; from MORPH_TO it is the aerial house the
// satellite views continue (flat roofs become hip roofs, the curved driveway and
// stepping stones straighten on the way). Scroll never shows the frames in between:
// the video holds its last front-view frame while a still of its first settled
// aerial frame (flyover-roof-consistent-3500ms.*) dissolves in over it, then the video
// plays on from that same frame. Both times are whole frames of the 24 fps clip.
export const MORPH_FROM = 30 / 24; // 1.25 s
export const MORPH_TO = 84 / 24; // 3.5 s

// The video time to show for the scroll's video time.
export function flyoverVideoTime(want) {
  return want > MORPH_FROM && want < MORPH_TO ? MORPH_FROM : want;
}

// Opacity of the aerial still, given the scroll's video time (want) and the time of
// the frame the video is actually showing (shown, from its last 'seeked'). The still
// also covers the video whenever that lags on a frame of the redraw.
export function aerialStillOpacity(want, shown, frame = 1 / 24) {
  const k = (want - MORPH_FROM) / (MORPH_TO - MORPH_FROM);
  const showsRedrawOrAerial = shown > MORPH_FROM + frame / 2;
  const showsAerial = shown > MORPH_TO - frame / 2;
  if (k <= 0) return showsRedrawOrAerial ? 1 : 0;
  if (k >= 1) return showsAerial ? 0 : 1;
  return showsRedrawOrAerial ? 1 : k * k * (3 - 2 * k);
}

// The still settles from 1.15x onto the house as it dissolves in, so the camera keeps
// rising through the swap and lands exactly on the video's frame (scale 1) at MORPH_TO.
export const AERIAL_STILL_ZOOM = 0.15;
export function aerialStillScale(want) {
  const k = Math.min(1, Math.max(0, (want - MORPH_FROM) / (MORPH_TO - MORPH_FROM)));
  return 1 + AERIAL_STILL_ZOOM * (1 - k * k * (3 - 2 * k));
}
