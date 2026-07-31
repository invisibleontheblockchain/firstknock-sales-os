// Shared address/name normalization for account search and manual lead creation.
// Both searchAccountRecords and createLeadFromAddress must agree on the exact
// canonical form, otherwise a searched address and a saved lead can disagree
// about whether they are the same door.

const STREET_SUFFIXES = {
  street: 'st', str: 'st', st: 'st',
  road: 'rd', rd: 'rd',
  avenue: 'ave', av: 'ave', ave: 'ave',
  drive: 'dr', dr: 'dr',
  lane: 'ln', ln: 'ln',
  court: 'ct', ct: 'ct',
  circle: 'cir', cir: 'cir',
  boulevard: 'blvd', blvd: 'blvd',
  place: 'pl', pl: 'pl',
  terrace: 'ter', ter: 'ter',
  trail: 'trl', trl: 'trl',
  parkway: 'pkwy', pkwy: 'pkwy',
  highway: 'hwy', hwy: 'hwy',
  way: 'way',
  north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
};

const UNIT_WORDS = new Set(['apt', 'apartment', 'unit', 'ste', 'suite', '#', 'bldg', 'building', 'lot', 'trlr', 'rm', 'room']);

export function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/#/g, ' # ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * Split an address into its canonical street part and its unit label.
 * Units are kept separate so 12 Oak St Apt 1 and Apt 2 never merge.
 */
export function splitAddressUnit(value) {
  const tokens = tokenize(value);
  const street = [];
  let unit = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (UNIT_WORDS.has(token)) {
      unit = tokens.slice(index + 1);
      break;
    }
    street.push(token);
  }
  return {
    street: street.map((token) => STREET_SUFFIXES[token] || token).join(' '),
    unit: unit.join(' '),
  };
}

export function normalizeAddress(value) {
  const { street, unit } = splitAddressUnit(value);
  return unit ? `${street} # ${unit}` : street;
}

export function normalizeZip(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.slice(0, 5);
}

/**
 * Canonical key for duplicate detection: normalized street + unit + ZIP.
 * ZIP+4 collapses to ZIP5 so the same door imported twice still matches.
 */
export function addressDedupeKey({ address, zip }) {
  return `${normalizeAddress(address)}|${normalizeZip(zip)}`;
}

export function parseHouseNumber(value) {
  const match = String(value || '').trim().match(/^(\d+)/);
  return match ? Number(match[1]) : null;
}

export function parseStreetName(value) {
  const { street } = splitAddressUnit(value);
  return street.replace(/^\d+\s*/, '').trim();
}