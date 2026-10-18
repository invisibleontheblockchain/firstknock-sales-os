// The opening move from the hero photo to the aerial neighbourhood. The landing has no
// footage of one house from the front all the way up: the flyover clip redraws it (the
// hero house is modern at dusk, the aerial one traditional in daylight). So the move
// is built from the images that are consistent on each side:
//   push   - the camera pushes toward the hero photo's front door,
//   tilt   - and tilts up off the house into the dusk sky (the photo's sky, extended),
//   rise   - up into a cloud bank that fills the screen; the light turns from dusk to
//            day and the house switches only while the bank covers everything,
//   descend- the clouds part outward onto the flyover's first settled aerial frame
//            (3.5 s), from where the existing flyover and satellite views carry on.
// Everything here is a pure function of the scroll progress (cur, in screens), so the
// move plays the same scrolling down or up, at any speed.

export const SKY_START = 0.08; // the flyover's scroll range starts here (satelliteScene.js)
export const AERIAL_VIDEO_TIME = 84 / 24; // 3.5 s: the clip's first settled aerial frame
export const DOOR = { x: 0.455, y: 0.526 }; // the front door in house-lux.jpg

// Phases, as fractions u of the move (0 at SKY_START, 1 where the flyover reaches 3.5 s).
export const PHASES = {
  push: [0, 0.34],
  tilt: [0.22, 0.6],
  feather: [0.18, 0.28], // done before the photo's top edge reaches the screen (u ~0.3)
  bank: [0.38, 0.6], // rises until it covers the screen at 0.6
  day: [0.6, 0.67], // dusk to daylight, under full cover
  swap: 0.635, // hero out, aerial in: the bank is fully up from 0.6
  clear: [0.68, 0.8], // the even day fog lifts from the centre ...
  part: [0.68, 0.98], // ... while the ring of cloud opens outward
  ringFade: [0.86, 0.98],
};

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (v) => { v = clamp01(v); return v * v * (3 - 2 * v); };
const phase = ([a, b], u) => smooth((u - a) / (b - a));

// Scroll progress where band(0.08, 1.7, cur) * dur reaches `time` (the scene's flyover mapping).
export function scrollAtFlyTime(time, dur = 8) {
  const target = clamp01(time / dur);
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (smooth(mid) < target) lo = mid; else hi = mid; }
  return SKY_START + ((lo + hi) / 2) * (1.7 - SKY_START);
}

export function skyFrame(cur, { dur = 8, reduce = false } = {}) {
  const end = scrollAtFlyTime(AERIAL_VIDEO_TIME, dur);
  const u = clamp01((cur - SKY_START) / (end - SKY_START));
  const aerial = u >= PHASES.swap;
  const day = phase(PHASES.day, u);
  if (reduce) {
    // No camera move: fade through the cloud colour and back.
    const cover = smooth((u - 0.45) / 0.15) * (1 - smooth((u - 0.7) / 0.15));
    return { u, aerial, scale: 1, dx: 0, ty: 0, feather: 0, clouds: u > 0.45 && u < 0.85, bankY: -50, bank: u < 0.67 ? cover : 0, day: u < 0.67 ? Math.min(cover, day) : cover, ring: 0, ringScale: 1, puffs: [] };
  }
  const push = phase(PHASES.push, u);
  const tilt = phase(PHASES.tilt, u);
  const bank = phase(PHASES.bank, u);
  const clear = phase(PHASES.clear, u);
  const part = phase(PHASES.part, u);
  const rise = smooth((u - 0.36) / 0.3);
  return {
    u,
    aerial,
    // hero camera: scale about the door, drift the door toward the centre, tilt up (the
    // photo moves down by up to 1.05 of its height, revealing the sky above it)
    scale: 1 + 0.22 * push,
    dx: (0.5 - DOOR.x) * push,
    ty: 1.05 * tilt,
    feather: phase(PHASES.feather, u),
    clouds: u > 0.34 && u < 1,
    // dusk cloud bank: a 200%-tall gradient sliding up until its opaque half fills the screen
    bankY: 50 - 100 * bank,
    bank: u < PHASES.clear[0] ? 1 : 0,
    day: day * (1 - clear),
    ring: day * (1 - phase(PHASES.ringFade, u)),
    ringScale: 1 + 2.6 * part,
    // three layers of soft cloud (y in vh): rise with the camera, then rush outward past it
    puffs: [0, 1, 2].map((i) => ({
      y: 70 - (90 + 15 * i) * rise,
      scale: 1 + (1.2 + 0.5 * i) * part,
      opacity: smooth((u - 0.36 - 0.03 * i) / 0.12) * (1 - smooth((u - 0.72 - 0.04 * i) / 0.18)) * (0.55 - 0.1 * i),
    })),
  };
}

// The frame the flyover may show for the scroll's video time: never one before 3.5 s, so
// the redrawn house can't appear; before the swap the video waits there, hidden.
export function aerialVideoTime(want) {
  return Math.max(AERIAL_VIDEO_TIME, want);
}

// Soft cloud texture: fractal value noise shaped into puffs, as an alpha channel.
export function cloudAlpha(size, seed, frequency = 4) {
  const hash = (x, y) => {
    let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const noise = (x, y, period) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
    const at = (i, j) => hash(((i % period) + period) % period, ((j % period) + period) % period);
    const top = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * sx;
    const bottom = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * sx;
    return top + (bottom - top) * sy;
  };
  const alpha = new Uint8ClampedArray(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let n = 0, amp = 0.5, f = frequency;
      for (let o = 0; o < 5; o++) { n += amp * noise((x / size) * f, (y / size) * f, f); amp /= 2; f *= 2; }
      alpha[y * size + x] = Math.round(255 * smooth((n - 0.38) / 0.4));
    }
  }
  return alpha;
}
