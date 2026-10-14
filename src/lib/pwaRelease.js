let updateCheckInFlight = null;
let lastReleaseCheckAt = 0;
const RELEASE_CHECK_INTERVAL_MS = 60_000;

function publishedRelease(html) {
  return html.match(/const FK_PWA_RELEASE = ['"]([^'"]+)['"]/)?.[1] || null;
}

export function checkForPublishedRelease(currentRelease) {
  const isBase44Preview = /(^|\.)preview(?:-sandbox)?--.*\.base44\.app$/i.test(window.location.hostname);
  // import.meta.env.DEV covers every Vite dev-server host, not just the known
  // preview domains — dev HTML should never offer a production update.
  if (import.meta.env.DEV || isBase44Preview || !navigator.onLine || updateCheckInFlight) return updateCheckInFlight;
  if (lastReleaseCheckAt && Date.now() - lastReleaseCheckAt < RELEASE_CHECK_INTERVAL_MS) return null;
  lastReleaseCheckAt = Date.now();

  updateCheckInFlight = (async () => {
    const url = new URL('/', window.location.origin);
    url.searchParams.set('fk_release_check', Date.now().toString());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let latestRelease;
    try {
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store', headers: { 'cache-control': 'no-cache' } });
      if (!response.ok) return false;
      latestRelease = publishedRelease(await response.text());
    } finally {
      clearTimeout(timer);
    }
    if (!latestRelease || latestRelease === currentRelease) return false;

    // A stale HTML response or an update while returning from Maps must not
    // restart the app. The caller offers a user-initiated refresh instead.
    return latestRelease;
  })().catch((error) => {
    console.warn('Published release check skipped', error);
    return false;
  }).finally(() => {
    updateCheckInFlight = null;
  });

  return updateCheckInFlight;
}

export function refreshToPublishedRelease(release) {
  if (!release) return;
  const destination = new URL(window.location.href);
  destination.searchParams.set('fk_release', release);
  window.location.replace(destination.toString());
}
