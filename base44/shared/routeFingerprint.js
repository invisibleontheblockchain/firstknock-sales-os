export function routePropertyOrderFingerprint(propertiesOrHashes) {
  if (!Array.isArray(propertiesOrHashes) || propertiesOrHashes.length === 0) return '';
  const identities = propertiesOrHashes.map((value) => {
    if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
    return String(
      value?.address_hash
      || value?.legacy_hash
      || value?.id
      || '',
    ).trim();
  });
  if (identities.some((identity) => !identity)) return '';

  let first = 2166136261;
  let second = 2246822507;
  identities.forEach((identity) => {
    const framed = `${identity.length}:${identity}|`;
    for (let index = 0; index < framed.length; index += 1) {
      const code = framed.charCodeAt(index);
      first = Math.imul(first ^ code, 16777619);
      second = Math.imul(second ^ code, 3266489909);
    }
  });
  return `${identities.length}:${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}
