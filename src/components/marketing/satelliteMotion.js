// The opening (the flyover and the pull-back to the neighbourhood, up to OPENING_END screens)
// follows the scroll closely: a short exponential catch-up (time constant OPENING_CATCH_UP
// seconds, frame-rate independent) only smooths uneven scroll steps; it never caps the speed,
// so the camera doesn't trail the page. Past the opening the map views keep their gentler
// easing, and each side hands over to the other at OPENING_END.
export const OPENING_CATCH_UP = 0.03;
export const OPENING_END = 2.75;

export function advanceSatelliteProgress(current, target, dt, reducedMotion = false) {
  const destination = Math.max(0, Math.min(6, target));
  if (reducedMotion) return destination;
  const elapsed = Math.max(0, Math.min(0.05, dt));
  if (current < OPENING_END || (current === OPENING_END && destination <= OPENING_END)) {
    const next = OPENING_CATCH_UP > 0 ? current + (destination - current) * (1 - Math.exp(-elapsed / OPENING_CATCH_UP)) : destination;
    return destination > OPENING_END ? Math.min(OPENING_END, next) : next;
  }
  const delta = (destination - current) * (1 - Math.pow(0.004, elapsed));
  if (destination < OPENING_END) return Math.max(OPENING_END, current + delta);
  return current + delta;
}
