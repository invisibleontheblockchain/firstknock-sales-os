export function csvCell(value) {
  const text = String(value ?? '');
  const safe = /^[=+\-@]/.test(text.trimStart()) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
