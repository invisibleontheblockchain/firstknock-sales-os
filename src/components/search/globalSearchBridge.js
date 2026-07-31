/**
 * Bridge between the header search launcher (rendered in the app Layout) and
 * whichever page owns the map/property surface for the current screen.
 *
 * The launcher dispatches a cancelable event. A page that can handle the result
 * itself calls preventDefault(); otherwise the launcher parks the selection and
 * navigates to the manager map, which consumes it on mount.
 */
export const GLOBAL_SEARCH_EVENT = 'fk-global-search-select';
const PENDING_KEY = 'fk_pending_search_selection';

export function dispatchGlobalSearchSelection(result) {
  const event = new CustomEvent(GLOBAL_SEARCH_EVENT, { detail: { result }, cancelable: true });
  const dispatched = window.dispatchEvent(event);
  // dispatchEvent returns false once a listener called preventDefault().
  return dispatched === false;
}

export function parkPendingSelection(result) {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(result));
  } catch {
    // Session storage is unavailable (private mode); the selection is dropped.
  }
}

export function takePendingSelection() {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(PENDING_KEY);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}