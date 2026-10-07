// Retain layers through pans, zoom bands and GPS updates. Only changed pins
// need projection/style work; click handlers read the current payload.
export function reconcileMapPins(store, entries, { create, remove }) {
    const keep = new Set();
    const counts = { added: 0, removed: 0, moved: 0, styled: 0 };
    for (const entry of entries) {
        keep.add(entry.key);
        const styleKey = JSON.stringify(entry.style);
        let record = store.get(entry.key);
        if (!record) {
            record = { marker: create(entry), point: entry.point, styleKey };
            store.set(entry.key, record);
            counts.added++;
        } else {
            if (record.point[0] !== entry.point[0] || record.point[1] !== entry.point[1]) {
                record.marker.setLatLng(entry.point);
                record.point = entry.point;
                counts.moved++;
            }
            if (record.styleKey !== styleKey) {
                record.marker.setStyle(entry.style);
                record.styleKey = styleKey;
                counts.styled++;
            }
        }
        record.marker.__payload = entry.payload;
    }
    for (const [key, record] of store) {
        if (keep.has(key)) continue;
        remove(record.marker);
        store.delete(key);
        counts.removed++;
    }
    return counts;
}
