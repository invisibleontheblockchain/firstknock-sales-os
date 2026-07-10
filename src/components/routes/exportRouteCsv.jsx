const getValue = (property, keys) => {
  for (const key of keys) {
    const value = property?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
};

const escapeCsv = (value) => {
  const text = String(value ?? '');
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
};

const sanitizeFileName = (name) => {
  return String(name || 'route')
    .trim()
    .replace(/[^a-z0-9-_]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'route';
};

export function exportRouteToCsv(route) {
  const properties = Array.isArray(route?.properties) ? route.properties : [];
  if (properties.length === 0) return 0;

  const columns = [
    ['Stop #', (_p, index) => index + 1],
    ['Full Address', (p) => getValue(p, ['full_address', 'address'])],
    ['House #', (p) => getValue(p, ['house_number'])],
    ['Street', (p) => getValue(p, ['street_name'])],
    ['City', (p) => getValue(p, ['city'])],
    ['State', (p) => getValue(p, ['state'])],
    ['Zip', (p) => getValue(p, ['zip_code', 'zip'])],
    ['Owner', (p) => getValue(p, ['owner_full_name', 'owner_name', 'ownerFullName'])],
    ['Owner Source', (p) => p?.owner_full_name_source === 'batchdata_job_observation'
      ? 'BatchData current observation - not sale-deed verified'
      : getValue(p, ['owner_full_name_source'])],
    ['Value', (p) => getValue(p, ['price', 'estimated_value', 'estimatedValue'])],
    ['Beds', (p) => getValue(p, ['beds', 'bedrooms'])],
    ['Baths', (p) => getValue(p, ['baths', 'bathrooms'])],
    ['Sqft', (p) => getValue(p, ['sqft', 'squareFootage', 'livingAreaSquareFeet'])],
    ['Lot Size', (p) => getValue(p, ['lot_size', 'lotSize', 'lotSizeSquareFeet'])],
    ['Year Built', (p) => getValue(p, ['year_built', 'yearBuilt'])],
    ['Sold Date', (p) => getValue(p, ['sold_date', 'soldDate'])],
    ['Sale Type', (p) => getValue(p, ['sale_type', 'saleType'])],
    ['Property Type', (p) => getValue(p, ['property_type', 'propertyType'])],
    ['Latitude', (p) => getValue(p, ['lat', 'latitude'])],
    ['Longitude', (p) => getValue(p, ['lng', 'longitude'])],
    ['Address Hash', (p) => getValue(p, ['address_hash', 'id'])],
  ];

  const rows = [
    columns.map(([label]) => escapeCsv(label)).join(','),
    ...properties.map((property, index) =>
      columns.map(([, resolve]) => escapeCsv(resolve(property, index))).join(',')
    )
  ];

  const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${sanitizeFileName(route?.name)}-route-export.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  return properties.length;
}
