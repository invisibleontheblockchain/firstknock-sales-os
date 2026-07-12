const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeOwnershipRangeDays(value) {
    const min = Number(Array.isArray(value) ? value[0] : value?.min);
    const max = Number(Array.isArray(value) ? value[1] : value?.max);
    if (!Number.isInteger(min) || !Number.isInteger(max)) return null;
    if (min < 1 || max > 365 || min >= max) return null;
    return [min, max];
}

function isoDateDaysAgo(days, referenceMs) {
    return new Date(referenceMs - days * DAY_MS).toISOString().slice(0, 10);
}

export function customOwnershipDateBounds(range, reference = Date.now()) {
    const normalized = normalizeOwnershipRangeDays(range);
    const referenceMs = reference instanceof Date
        ? reference.getTime()
        : typeof reference === 'string'
            ? new Date(reference).getTime()
            : Number(reference);
    if (!normalized || !Number.isFinite(referenceMs)) return null;
    const [min, max] = normalized;
    return {
        min,
        max,
        oldestDate: isoDateDaysAgo(max, referenceMs),
        newestDate: isoDateDaysAgo(min, referenceMs)
    };
}

export function isSoldDateInCustomOwnershipRange(soldDate, range, reference = Date.now()) {
    const bounds = customOwnershipDateBounds(range, reference);
    if (!bounds || !soldDate) return false;
    const soldTime = new Date(soldDate).getTime();
    if (!Number.isFinite(soldTime)) return false;
    const soldDateOnly = new Date(soldTime).toISOString().slice(0, 10);
    return soldDateOnly >= bounds.oldestDate && soldDateOnly <= bounds.newestDate;
}

export function customOwnershipRangeLabel(range) {
    const normalized = normalizeOwnershipRangeDays(range);
    if (!normalized) return 'the selected custom ownership range';
    return `${normalized[0]}–${normalized[1]} days ago`;
}
