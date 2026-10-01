// Reads an Excel workbook into the same array-of-objects shape Papa.parse gives
// CSV files, so every importer downstream handles both identically.

export const isExcelFileName = (name) => /\.(xlsx|xlsm)$/i.test(String(name || ''));
export const isLegacyExcelFileName = (name) => /\.xls$/i.test(String(name || ''));

const isBlankCell = (cell) => cell === null || cell === undefined || String(cell).trim() === '';

function cellValue(cell) {
  if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? null : cell.toISOString().slice(0, 10);
  if (typeof cell === 'string') return cell.trim();
  return cell ?? null;
}

/**
 * Convert a sheet matrix (first non-empty row = headers) into row objects.
 * Blank rows are dropped; blank or repeated headers are made unique so no
 * column is silently overwritten.
 */
export function matrixToRows(matrix = []) {
  const headerIndex = matrix.findIndex((row) => Array.isArray(row) && row.some((cell) => !isBlankCell(cell)));
  if (headerIndex === -1) return [];

  const seen = new Map();
  const headers = matrix[headerIndex].map((cell, index) => {
    const base = isBlankCell(cell) ? `Column ${index + 1}` : String(cell).trim();
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });

  return matrix
    .slice(headerIndex + 1)
    .filter((row) => Array.isArray(row) && row.some((cell) => !isBlankCell(cell)))
    .map((row) => Object.fromEntries(headers.map((header, index) => [header, cellValue(row[index])])));
}

/**
 * Read the first sheet that has data. `readSheet` is injectable for tests;
 * the Excel parser is loaded on demand because most uploads are CSV.
 */
export async function readExcelRows(file, { readSheet, readSheetNames } = {}) {
  let read = readSheet;
  let names = readSheetNames;
  if (!read) {
    const module = await import('read-excel-file');
    read = (source, options) => module.default(source, options);
    names = names || module.readSheetNames;
  }

  const firstSheet = await read(file);
  const rows = matrixToRows(firstSheet);
  if (rows.length > 0 || typeof names !== 'function') return rows;

  const sheetNames = await names(file);
  for (let i = 1; i < sheetNames.length; i += 1) {
    const rowsFromSheet = matrixToRows(await read(file, { sheet: i + 1 }));
    if (rowsFromSheet.length > 0) return rowsFromSheet;
  }
  return [];
}
