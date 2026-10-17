// Page chunks used to start downloading only after sign-in finished, because
// ProtectedRoute renders nothing until then. On cellular that serialized the
// biggest download behind two account round trips. App registers its lazy page
// loaders here so startup can request the page in parallel with sign-in;
// React.lazy then resolves the same module.
let pageLoaders = {};
const requested = new Set();

export function registerPageLoaders(loaders) {
  pageLoaders = loaders || {};
}

export function pageNameForPath(pathname = '') {
  const segment = String(pathname).split('/').filter(Boolean)[0] || '';
  if (!segment) return null;
  const lower = segment.toLowerCase();
  // Routes match case-insensitively, so /home opens the Home page.
  return Object.keys(pageLoaders).find((name) => name.toLowerCase() === lower) || null;
}

export function preloadPage(name) {
  const loader = name && pageLoaders[name];
  if (!loader || requested.has(name)) return;
  requested.add(name);
  // A failed preload is retried by React.lazy when the page actually renders.
  Promise.resolve().then(loader).catch(() => requested.delete(name));
}
