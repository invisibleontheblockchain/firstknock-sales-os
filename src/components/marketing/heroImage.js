// The landing's opening house photo. It used to be the flyover video's poster:
// a 1.2 MB baseline JPEG, requested late at low priority next to 38 MB of other
// landing media, which the browser painted top-down as the bytes arrived. Now it
// is right-sized AVIF/WebP, preloaded from index.html, and shown only once it is
// fully downloaded and decoded, over a tiny blurred copy of itself.

// Must match the preload in index.html (test/landing-hero-image.test.mjs checks).
export const HERO_AVIF_SRCSET = '/landing/hero-golden-1440.avif 1440w, /landing/hero-golden-1920.avif 1920w, /landing/hero-golden-2688.avif 2688w';
export const HERO_WEBP_SRCSET = '/landing/hero-golden-1440.webp 1440w, /landing/hero-golden-1920.webp 1920w, /landing/hero-golden-2688.webp 2688w';
export const HERO_JPEG_SRC = '/landing/hero-golden.jpg';
// The photo always covers the screen: its width is the viewport width, or 2688/1520
// of the viewport height on screens narrower than the photo (every phone held upright).
export const HERO_SIZES = '(max-aspect-ratio: 2688/1520) 177vh, 100vw';

// The photo at 32 × 18 (216 bytes of WebP), blurred, so the hero shows the house's
// colours from the first frame. Blurring inside the SVG keeps the edges opaque.
const PLACEHOLDER_WEBP = 'UklGRtAAAABXRUJQVlA4IMQAAAAwBQCdASogABIAPu1gp02ppaMiMAgBMB2JZACdMwzqEDd5y3OUJm78lRmNeyn9WPhVMADvzuxwnQkPAuS/WWBsi6zszeRDwDFHeVdPB/HvRJW4RuQw58WjaucBd5+z2JTRrqyUj+m7j9pVeN3hS0AR+GdKhWYnr16hcmszexmyrWE+IUPzXAiCn+nKrUZSUTWJaijJDRAZc2PWWhFrAS88Hp4PTwdXpnTy2KheCrhaYsKrvqflmJD8ROeOsgt4J8jMAAAA';
const PLACEHOLDER_SVG = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 18' preserveAspectRatio='none'>"
  + "<filter id='b' color-interpolation-filters='sRGB'><feGaussianBlur stdDeviation='.8'/>"
  + "<feComponentTransfer><feFuncA type='discrete' tableValues='1 1'/></feComponentTransfer></filter>"
  + `<image width='32' height='18' preserveAspectRatio='none' filter='url(#b)' href='data:image/webp;base64,${PLACEHOLDER_WEBP}'/></svg>`;
export const HERO_PLACEHOLDER = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(PLACEHOLDER_SVG)}")`;

// Calls onSettled(true) once img is fully downloaded and decoded (after marking it
// data-ready, which fades it in), or onSettled(false) if it fails. Never earlier:
// until then the photo stays transparent, so no partially received pixels show.
export function revealWhenDecoded(img, onSettled = () => {}) {
  let settled = false;
  const settle = (ok) => {
    if (settled) return;
    settled = true;
    img.removeEventListener('load', onLoad);
    img.removeEventListener('error', onError);
    if (ok) img.setAttribute('data-ready', '');
    onSettled(ok);
  };
  // decode() can reject for reasons that leave the bytes complete (Safari while
  // the page is hidden, a srcset re-selection); the load already finished.
  const onLoad = () => {
    const decoding = typeof img.decode === 'function' ? img.decode() : Promise.resolve();
    decoding.then(() => settle(true), () => settle(img.naturalWidth > 0));
  };
  const onError = () => settle(false);
  if (img.complete) {
    if (img.naturalWidth > 0) onLoad();
    else settle(false);
  } else {
    img.addEventListener('load', onLoad);
    img.addEventListener('error', onError);
  }
  return () => { settled = true; img.removeEventListener('load', onLoad); img.removeEventListener('error', onError); };
}
