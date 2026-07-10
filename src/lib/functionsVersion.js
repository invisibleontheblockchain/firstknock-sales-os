export const LEGACY_FUNCTIONS_VERSION_STORAGE_KEY = 'base44_functions_version';

/**
 * A function version is a release/preview selector, not a durable preference.
 * Persisting it across deployments can pair a new frontend with old functions.
 */
export function resolveFunctionsVersion({ search = '', configuredVersion = null, storage = null } = {}) {
  try { storage?.removeItem?.(LEGACY_FUNCTIONS_VERSION_STORAGE_KEY); } catch {}
  const fromUrl = new URLSearchParams(search || '').get('functions_version');
  return fromUrl || configuredVersion || null;
}
