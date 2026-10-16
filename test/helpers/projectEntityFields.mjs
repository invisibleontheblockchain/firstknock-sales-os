// Model Base44's server-side field projection, including dotted metadata paths.
export function projectEntityFields(row, fields) {
  if (!fields) return structuredClone(row);
  const result = {};
  for (const field of fields) {
    const path = field.split('.');
    const value = path.reduce((object, key) => object?.[key], row);
    if (value === undefined) continue;
    let target = result;
    for (const key of path.slice(0, -1)) target = target[key] ??= {};
    target[path.at(-1)] = structuredClone(value);
  }
  return result;
}
