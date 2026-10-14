export function indexRouteLogs(logs = []) {
    const byHash = new Map();
    logs.forEach((log, index) => {
        const hash = log?.address_hash;
        if (!hash) return;
        if (!byHash.has(hash)) byHash.set(hash, []);
        byHash.get(hash).push({ log, index });
    });
    return byHash;
}

export function logsForRouteProperty(byHash, property, { routeId, rerunCreatedAt } = {}) {
    const primary = byHash.get(property.address_hash) || [];
    const legacy = property.legacy_hash && property.legacy_hash !== property.address_hash
        ? byHash.get(property.legacy_hash) || [] : [];
    const result = [];
    let left = 0;
    let right = 0;
    // Merge alias buckets in original input order, preserving timestamp-tie
    // behavior while visiting only this property's history instead of every log.
    while (left < primary.length || right < legacy.length) {
        const entry = right >= legacy.length || (left < primary.length && primary[left].index < legacy[right].index)
            ? primary[left++] : legacy[right++];
        const log = entry.log;
        if (rerunCreatedAt && log.route_id !== routeId) {
            const logTime = new Date(log.created_date || 0).getTime();
            if (Number.isNaN(logTime) || logTime < rerunCreatedAt) continue;
        }
        result.push(log);
    }
    return result;
}
