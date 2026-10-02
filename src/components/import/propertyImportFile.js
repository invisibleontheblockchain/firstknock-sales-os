import Papa from 'papaparse';
import { hasPropertyColumns } from './propertyImportData.js';

function cellValue(cell) {
  const value = cell.value;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    if ('result' in value) return value.result ?? null;
    if ('richText' in value) return value.richText.map(part => part.text).join('');
    return value.text ?? null;
  }
  return value;
}

export function workbookToRows(workbook) {
  const rows = [];
  for (const sheet of workbook.worksheets.filter(sheet => sheet.state === 'visible')) {
    let headers;
    sheet.eachRow({ includeEmpty: false }, row => {
      if (!headers) {
        const values = row.values.slice(1).map((_, index) => String(cellValue(row.getCell(index + 1)) || '').trim());
        const historyOrCoverageHeaders = ['status', 'parsedstatus', 'originalstatus', 'state', 'stateorprovince', 'county', 'countyname', 'addresshash', 'propertyid', 'mls'];
        if (!hasPropertyColumns(values) && !values.some(header => historyOrCoverageHeaders.includes(String(header).toLowerCase().replace(/[^a-z0-9]/g, '')))) return;
        headers = values;
        return;
      }
      const entries = headers.flatMap((header, index) => header ? [[header, cellValue(row.getCell(index + 1))]] : []);
      if (entries.some(([, value]) => value != null && String(value).trim())) rows.push(Object.fromEntries(entries));
    });
  }
  if (!rows.length) throw new Error('No property rows found in the visible Excel sheets. Include an Address column.');
  return rows;
}

export async function parsePropertyImportFile(file) {
  const extension = file.name.split('.').pop().toLowerCase();
  if (['xlsx', 'xlsm'].includes(extension)) {
    const module = await import('exceljs');
    const ExcelJS = module.default || module;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    return workbookToRows(workbook);
  }
  if (extension === 'json') {
    const parsed = JSON.parse(await file.text());
    const data = Array.isArray(parsed) ? parsed : (parsed?.properties || parsed?.data || parsed?.items || parsed?.results || [parsed]);
    if (!Array.isArray(data) || data.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('JSON must contain property objects or an array of properties.');
    return data;
  }
  if (extension !== 'csv') throw new Error('Please upload a CSV, Excel (.xlsx) or JSON file.');
  const parsed = Papa.parse(await file.text(), { header: true, skipEmptyLines: 'greedy', transformHeader: header => header.trim() });
  if (parsed.errors.some(error => error.type === 'Quotes')) throw new Error('The CSV contains an unclosed quote. Correct the file and try again.');
  const rows = parsed.data.filter(row => Object.values(row).some(value => value != null && String(value).trim()));
  if (!rows.length) throw new Error('The file has no data rows.');
  return rows;
}
