// Dense-territory dot sizing.
//
// A 4px dot reads well over a few hundred homes and turns into a solid mass of
// color over a few thousand, so past DENSE_PIN_THRESHOLD the map defaults to a
// smaller dot. The stored `fk_pinSize_v2` value cannot decide this on its own:
// Home writes it back on every load, so its presence proves nothing about
// intent. This separate flag is set only when the Dot size slider is moved, and
// once set the user's choice always wins.

const USER_SET_KEY = 'fk_pinSizeUserSet_v1';

export const DENSE_PIN_THRESHOLD = 200;
export const DENSE_PIN_SIZE = 2;

export function markPinSizeUserSet() {
    try { localStorage.setItem(USER_SET_KEY, 'true'); } catch { /* private mode / quota */ }
}

export function clearPinSizeUserSet() {
    try { localStorage.removeItem(USER_SET_KEY); } catch { /* private mode / quota */ }
}

export function isPinSizeUserSet() {
    try { return localStorage.getItem(USER_SET_KEY) === 'true'; } catch { return false; }
}

export function resolvePinSize(pinSize, propertyCount) {
    const size = Number(pinSize) || 4;
    if (isPinSizeUserSet()) return size;
    return Number(propertyCount) > DENSE_PIN_THRESHOLD ? Math.min(size, DENSE_PIN_SIZE) : size;
}

// Street-level zoom spreads the doors far apart, so a dense-mode 2px dot ends up
// a speck lost against the imagery. The dot grows back as the crowding that made
// it small disappears; wide views keep the small dot.
export function zoomAdjustedPinSize(pinSize, zoomLevel) {
    const size = Number(pinSize) || 4;
    const z = Number(zoomLevel) || 0;
    const bump = z >= 19 ? 4 : z >= 18 ? 3 : z >= 17 ? 2 : z >= 16 ? 1 : 0;
    return size + bump;
}