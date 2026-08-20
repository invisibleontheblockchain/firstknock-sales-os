let updateCheckInFlight = null;

function publishedRelease(html) {
  return html.match(/const FK_PWA_RELEASE = ['"]([^'"]+)['"]/)?.[1] || null;
}

export function checkForPublishedRelease(currentRelease) {
  if (!navigator.onLine || updateCheckInFlight) return updateCheckInFlight;

  updateCheckInFlight = (async () => {
    const url = new URL('/', window.location.origin);
    url.searchParams.set('fk_release_check', Date.now().toString());
    const response = await fetch(url, { cache: 'no-store', headers: { 'cache-control': 'no-cache' } });
    if (!response.ok) return false;

    const latestRelease = publishedRelease(await response.text());
    if (!latestRelease || latestRelease === currentRelease) return false;

    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name)));
    }
    const registration = await navigator.serviceWorker?.getRegistration();
    await registration?.update();

    const destination = new URL(window.location.href);
    destination.searchParams.set('fk_release', latestRelease);
    window.location.replace(destination.toString());
    return true;
  })().catch((error) => {
    console.warn('Published release check skipped', error);
    return false;
  }).finally(() => {
    updateCheckInFlight = null;
  });

  return updateCheckInFlight;
}