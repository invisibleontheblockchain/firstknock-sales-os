const KEY = 'fk_recent_searches';
const MAX = 8;

/** Lightweight local history of chosen search results so reps can revisit a customer they just looked up. */
export function loadRecentSearches() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(parsed) ? parsed.slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export function addRecentSearch(result) {
  if (!result) return loadRecentSearches();
  const key = result.id || result.formatted_address || result.label;
  if (!key) return loadRecentSearches();
  const next = [result, ...loadRecentSearches().filter((item) => (item.id || item.formatted_address || item.label) !== key)].slice(0, MAX);
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage full or blocked */ }
  return next;
}

export function clearRecentSearches() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  return [];
}