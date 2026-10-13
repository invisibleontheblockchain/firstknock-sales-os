// Keep a fast wheel gesture from skipping most of the opening camera move.
export function advanceSatelliteProgress(current, target, dt, reducedMotion = false) {
  const destination = Math.max(0, Math.min(6, target));
  if (reducedMotion) return destination;
  const elapsed = Math.max(0, Math.min(0.05, dt));
  const delta = (destination - current) * (1 - Math.pow(0.004, elapsed));
  if (current < 2.75) {
    const maxStep = elapsed * 0.9;
    return current + Math.max(-maxStep, Math.min(maxStep, delta));
  }
  if (destination < 2.75) return Math.max(2.75, current + delta);
  return current + delta;
}
