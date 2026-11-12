// Precision areas are also kept on the device: the builder's "previous
// Precision areas" (ghost button) list, the areas cleared from it, and the
// outline being worked on. Those keys never recorded which account wrote them,
// so the next account signed in on the same phone or browser saw the last
// account's areas as its own.
//
// The device now records which account its area keys belong to. When a
// different account signs in, the keys are cleared before any page reads them,
// and signing out clears them too. Each account's pulled areas still come back
// from the server (its routes and pull jobs); only device-only extras are lost
// on a switch: previews that were never pulled and the list of areas cleared
// from the map.
//
// Dependency-free so node --test can import it directly.

export const DEVICE_AREA_KEYS = Object.freeze([
    'fk_polygonHistory',
    'fk_polygonHistoryHidden',
    'fk_drawnPolygon',
    'fk_drawnPolygonQueried',
]);

export const DEVICE_AREA_ACCOUNT_KEY = 'fk_deviceAreasAccount';

/** The account a device's area keys belong to, or null when signed out. */
export function deviceAreaAccountId(user) {
    const id = String(user?.id ?? '').trim();
    if (id) return id;
    const email = String(user?.email ?? '').trim().toLowerCase();
    return email || null;
}

/** Removes every device area key and the record of whose they were. */
export function clearDeviceAreaStorage(storage) {
    if (!storage) return;
    [...DEVICE_AREA_KEYS, DEVICE_AREA_ACCOUNT_KEY].forEach((key) => {
        try { storage.removeItem(key); } catch { /* blocked storage: nothing to clear */ }
    });
}

/**
 * Makes the device's area keys belong to this account. Keys written by another
 * account, or by no recorded account (stored before this check existed), are
 * cleared first, because whose areas they hold can't be known.
 * Returns true when anything was cleared.
 */
export function claimDeviceAreaStorage(storage, user) {
    const account = deviceAreaAccountId(user);
    if (!storage || !account) return false;
    let owner = null;
    try { owner = storage.getItem(DEVICE_AREA_ACCOUNT_KEY); } catch { return false; }
    if (owner === account) return false;
    clearDeviceAreaStorage(storage);
    try { storage.setItem(DEVICE_AREA_ACCOUNT_KEY, account); } catch { /* storage full or blocked */ }
    return true;
}
