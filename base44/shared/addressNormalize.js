// Shared address/name normalization for account search, manual lead creation
// and spreadsheet imports. Every caller that decides whether two strings are
// the same door must agree on the exact canonical form, otherwise "123 Water
// Street" from one file and "123 Water St" from another end up as two houses.
//
// Kept free of Deno/Node/browser imports so it runs in Base44 functions, the
// Vite bundle and node:test alike.

// USPS Publication 28, Appendix C1: every common spelling of a street suffix
// collapses to the standard abbreviation. Standard forms map to themselves so
// an already-abbreviated address is left exactly as it is.
const SUFFIX_FAMILIES = {
  aly: ['allee', 'alley', 'ally'], anx: ['anex', 'annex', 'annx'], arc: ['arcade'],
  ave: ['av', 'aven', 'avenu', 'avenue', 'avn', 'avnue'], byu: ['bayoo', 'bayou'], bch: ['beach'],
  bnd: ['bend'], blf: ['bluf', 'bluff'], blfs: ['bluffs'], btm: ['bot', 'bottm', 'bottom'],
  blvd: ['boul', 'boulevard', 'boulv'], br: ['brnch', 'branch'], brg: ['brdge', 'bridge'],
  brk: ['brook'], brks: ['brooks'], bg: ['burg'], bgs: ['burgs'], byp: ['bypa', 'bypas', 'bypass', 'byps'],
  cp: ['camp', 'cmp'], cyn: ['canyn', 'canyon', 'cnyn'], cpe: ['cape'], cswy: ['causeway', 'causwa'],
  ctr: ['cen', 'cent', 'center', 'centr', 'centre', 'cnter', 'cntr'], ctrs: ['centers'],
  cir: ['circ', 'circl', 'circle', 'crcl', 'crcle'], cirs: ['circles'], clf: ['cliff'], clfs: ['cliffs'],
  clb: ['club'], cmn: ['common'], cmns: ['commons'], cor: ['corner'], cors: ['corners'], crse: ['course'],
  ct: ['court'], cts: ['courts'], cv: ['cove'], cvs: ['coves'], crk: ['creek'],
  cres: ['crescent', 'crsent', 'crsnt'], crst: ['crest'], xing: ['crossing', 'crssng'], xrd: ['crossroad'],
  xrds: ['crossroads'], curv: ['curve'], dl: ['dale'], dm: ['dam'], dv: ['div', 'divide', 'dvd'],
  dr: ['driv', 'drive', 'drv'], drs: ['drives'], est: ['estate'], ests: ['estates'],
  expy: ['exp', 'expr', 'express', 'expressway', 'expw'], ext: ['extension', 'extn', 'extnsn'], exts: ['extensions'],
  fls: ['falls'], fry: ['ferry', 'frry'], fld: ['field'], flds: ['fields'], flt: ['flat'], flts: ['flats'],
  frd: ['ford'], frds: ['fords'], frst: ['forest', 'forests'], frg: ['forg', 'forge'], frgs: ['forges'],
  frk: ['fork'], frks: ['forks'], ft: ['fort', 'frt'], fwy: ['freeway', 'freewy', 'frway', 'frwy'],
  gdn: ['garden', 'gardn', 'grden', 'grdn'], gdns: ['gardens', 'grdns'],
  gtwy: ['gateway', 'gatewy', 'gatway', 'gtway'], gln: ['glen'], glns: ['glens'], grn: ['green'], grns: ['greens'],
  grv: ['grov', 'grove'], grvs: ['groves'], hbr: ['harb', 'harbor', 'harbr', 'hrbor'], hbrs: ['harbors'],
  hvn: ['haven'], hts: ['heights'], hwy: ['highway', 'highwy', 'hiway', 'hiwy', 'hway'], hl: ['hill'], hls: ['hills'],
  holw: ['hllw', 'hollow', 'hollows', 'holws'], inlt: ['inlet'], is: ['island', 'islnd'], iss: ['islands', 'islnds'],
  isle: ['isles'], jct: ['jction', 'jctn', 'junction', 'junctn', 'juncton'], jcts: ['jctns', 'junctions'],
  ky: ['key'], kys: ['keys'], knl: ['knol', 'knoll'], knls: ['knolls'], lk: ['lake'], lks: ['lakes'],
  lndg: ['landing', 'lndng'], ln: ['lane'], lgt: ['light'], lgts: ['lights'], lf: ['loaf'], lck: ['lock'],
  lcks: ['locks'], ldg: ['ldge', 'lodg', 'lodge'], loop: ['loops'], mnr: ['manor'], mnrs: ['manors'],
  mdw: ['meadow'], mdws: ['meadows', 'medows'], ml: ['mill'], mls: ['mills'], msn: ['missn', 'mssn', 'mission'],
  mtwy: ['motorway'], mt: ['mnt', 'mount'], mtn: ['mntain', 'mntn', 'mountain', 'mountin', 'mtin'],
  mtns: ['mntns', 'mountains'], nck: ['neck'], orch: ['orchard', 'orchrd'], oval: ['ovl'], opas: ['overpass'],
  park: ['parks', 'prk'], pkwy: ['parkway', 'parkwy', 'pkway', 'pky', 'parkways', 'pkwys'], psge: ['passage'],
  path: ['paths'], pike: ['pikes'], pne: ['pine'], pnes: ['pines'], pl: ['place'], pln: ['plain'], plns: ['plains'],
  plz: ['plaza', 'plza'], pt: ['point'], pts: ['points'], prt: ['port'], prts: ['ports'], pr: ['prairie', 'prr'],
  radl: ['rad', 'radial', 'radiel'], rnch: ['ranch', 'ranches', 'rnchs'], rpd: ['rapid'], rpds: ['rapids'],
  rst: ['rest'], rdg: ['rdge', 'ridge'], rdgs: ['ridges'], riv: ['river', 'rvr', 'rivr'], rd: ['road'], rds: ['roads'],
  rte: ['route'], shl: ['shoal'], shls: ['shoals'], shr: ['shoar', 'shore'], shrs: ['shoars', 'shores'],
  skwy: ['skyway'], spg: ['spng', 'spring', 'sprng'], spgs: ['spngs', 'springs', 'sprngs'], spur: ['spurs'],
  sq: ['sqr', 'sqre', 'squ', 'square'], sqs: ['sqrs', 'squares'], sta: ['station', 'statn', 'stn'],
  stra: ['strav', 'straven', 'stravenue', 'stravn', 'strvn', 'strvnue'], strm: ['stream', 'streme'],
  st: ['street', 'strt', 'str'], sts: ['streets'], smt: ['sumit', 'sumitt', 'summit'], ter: ['terr', 'terrace'],
  trwy: ['throughway'], trce: ['trace', 'traces'], trak: ['track', 'tracks', 'trk', 'trks'], trfy: ['trafficway'],
  trl: ['trail', 'trails', 'trls'], tunl: ['tunel', 'tunls', 'tunnel', 'tunnels', 'tunnl'],
  tpke: ['trnpk', 'turnpike', 'turnpk'], upas: ['underpass'], un: ['union'], uns: ['unions'],
  vly: ['valley', 'vally', 'vlly'], vlys: ['valleys'], via: ['vdct', 'viadct', 'viaduct'], vw: ['view'], vws: ['views'],
  vlg: ['vill', 'villag', 'village', 'villg', 'villiage'], vlgs: ['villages'], vl: ['ville'],
  vis: ['vist', 'vista', 'vst', 'vsta'], walk: ['walks'], way: ['wy'], wl: ['well'], wls: ['wells'],
};

// Words that are not suffixes but are abbreviated just as inconsistently.
const WORD_FAMILIES = {
  n: ['north'], s: ['south'], e: ['east'], w: ['west'],
  ne: ['northeast'], nw: ['northwest'], se: ['southeast'], sw: ['southwest'],
  st: ['saint'],
  '1st': ['first'], '2nd': ['second'], '3rd': ['third'], '4th': ['fourth'], '5th': ['fifth'],
  '6th': ['sixth'], '7th': ['seventh'], '8th': ['eighth'], '9th': ['ninth'], '10th': ['tenth'],
};

const CANONICAL_TOKENS = (() => {
  const table = {};
  for (const families of [SUFFIX_FAMILIES, WORD_FAMILIES]) {
    for (const [standard, variants] of Object.entries(families)) {
      table[standard] = standard;
      for (const variant of variants) table[variant] = standard;
    }
  }
  return table;
})();

// USPS Appendix C2 secondary unit designators. The word is dropped and the
// identifier kept, so "Apt 4", "Unit 4" and "#4" are the same unit.
const UNIT_WORDS = new Set([
  '#', 'apt', 'apartment', 'unit', 'ste', 'suite', 'bldg', 'building', 'lot', 'trlr', 'trailer', 'rm', 'room',
  'fl', 'floor', 'ph', 'penthouse', 'spc', 'space', 'slip', 'pier', 'hangar', 'hngr', 'dept', 'department',
  'ofc', 'office',
]);
// Designators that stand alone ("123 Main St Rear"): the word is the unit.
const STANDALONE_UNIT_WORDS = new Set(['bsmt', 'basement', 'frnt', 'front', 'lbby', 'lobby', 'lowr', 'lower', 'rear', 'side', 'uppr', 'upper']);

const ZIP_TOKEN = /^\d{5}(?:-?\d{4})?$/;

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

function canonicalToken(token) {
  return CANONICAL_TOKENS[token] || token;
}

function splitUnitTokens(tokens) {
  const street = [];
  let unit = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    // A designator needs something after it, except the stand-alone ones.
    // "123 Key West Ave" keeps "key" as a street word because a street follows.
    if (UNIT_WORDS.has(token) && index > 0 && index === tokens.length - 2) {
      unit = tokens.slice(index + 1);
      break;
    }
    if (UNIT_WORDS.has(token) && index > 0 && index < tokens.length - 1 && /\d/.test(tokens[index + 1])) {
      unit = tokens.slice(index + 1);
      break;
    }
    if (STANDALONE_UNIT_WORDS.has(token) && index > 0 && index === tokens.length - 1) {
      unit = [token];
      break;
    }
    street.push(token);
  }
  return { street: street.map(canonicalToken), unit };
}

/**
 * Split an address into its canonical street part and its unit label.
 * Units are kept separate so 12 Oak St Apt 1 and Apt 2 never merge.
 */
export function splitAddressUnit(value) {
  const { street, unit } = splitUnitTokens(tokenize(value));
  return { street: street.join(' '), unit: unit.join(' ') };
}

/**
 * Whole-string canonical form: suffixes, directionals and unit designators
 * standardized, nothing dropped. Search matches substrings of this.
 */
export function normalizeAddress(value) {
  const { street, unit } = splitAddressUnit(value);
  return unit ? `${street} # ${unit}` : street;
}

export function normalizeZip(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.slice(0, 5);
}

// A comma segment that names a unit ("Apt 2", "2nd Floor") rather than a
// locality. "FL 33605" closes a locality however much FL looks like a floor,
// and a lone word ("FL", "Suite") names nothing.
function isUnitSegment(segment) {
  const tokens = tokenize(segment);
  if (tokens.length < 2) return false;
  if (ZIP_TOKEN.test(tokens[tokens.length - 1]) && /^[a-z]{2}$/.test(tokens[tokens.length - 2])) return false;
  return tokens.some((token) => UNIT_WORDS.has(token) || STANDALONE_UNIT_WORDS.has(token));
}

function endsWith(tokens, tail) {
  // Never strip down to the house number alone: "123 Toms River" in Toms River
  // is a street named after the town, not a town after a street.
  if (!tail.length || tokens.length - tail.length < 2) return false;
  return tail.every((token, index) => tokens[tokens.length - tail.length + index] === token);
}

/**
 * The street line of an address on its own, as one file may carry "123 Water
 * St" while another carries "123 Water St, Toms River, NJ 08753" or the same
 * without commas. Anything after the first comma is dropped unless it names a
 * unit. From the first segment a trailing ZIP (the record's own, or any ZIP
 * right after a two-letter state), then the known state, then the known city
 * are removed, in that order and only as a run from the end. The ZIP found
 * there is returned so a record without a ZIP column can still be keyed by it.
 */
export function parseStreetLine(value, { city = '', state = '', zip = '' } = {}) {
  const segments = String(value || '').split(',');
  const tokens = tokenize(segments[0]);
  const knownZip = normalizeZip(zip);
  let inferredZip = '';
  let strippedLocality = false;

  const last = tokens[tokens.length - 1];
  if (tokens.length > 2 && last && ZIP_TOKEN.test(last)) {
    const candidate = normalizeZip(last);
    const afterState = /^[a-z]{2}$/.test(tokens[tokens.length - 2]);
    // A road number ("County Road 12345") is not a ZIP: without the record's
    // own ZIP to confirm it, only a ZIP that follows a state is trusted.
    if (candidate === knownZip || (!knownZip && afterState)) {
      inferredZip = candidate;
      tokens.pop();
      strippedLocality = true;
      // The two-letter code right before a closing ZIP is the state, whether
      // or not the sheet names it (or spells it out).
      if (afterState && tokens.length > 2) tokens.pop();
    }
  }
  // "…, Toms River, NJ 08753": a ZIP closing the last locality segment is
  // this record's ZIP when the sheet had no ZIP column of its own.
  if (!knownZip && !inferredZip && segments.length > 1) {
    const lastSegment = segments[segments.length - 1];
    const tailTokens = tokenize(lastSegment);
    const tailZip = tailTokens[tailTokens.length - 1];
    if (tailZip && ZIP_TOKEN.test(tailZip) && !isUnitSegment(lastSegment)) inferredZip = normalizeZip(tailZip);
  }
  const stateTokens = tokenize(state).filter((token) => token !== '#');
  const cityTokens = tokenize(city).filter((token) => token !== '#');
  // "NE" is both Nebraska and a directional, so the state goes only when the
  // ZIP went before it or the city sits right in front of it.
  if (endsWith(tokens, stateTokens) && (strippedLocality || endsWith(tokens.slice(0, -stateTokens.length), cityTokens))) {
    tokens.splice(tokens.length - stateTokens.length, stateTokens.length);
    strippedLocality = true;
  }
  if (strippedLocality && endsWith(tokens, cityTokens)) {
    tokens.splice(tokens.length - cityTokens.length, cityTokens.length);
  }

  for (const segment of segments.slice(1)) {
    if (isUnitSegment(segment)) tokens.push(...tokenize(segment));
  }

  const { street, unit } = splitUnitTokens(tokens);
  return { street: street.join(' '), unit: unit.join(' '), zip: inferredZip };
}

/**
 * The canonical street line with its unit ("123 water st # 2") plus the ZIP
 * to key it by: the record's own ZIP, else the one found in the address.
 */
export function canonicalStreetLine(address, { city = '', state = '', zip = '' } = {}) {
  const line = parseStreetLine(address, { city, state, zip });
  return {
    line: line.unit ? `${line.street} # ${line.unit}` : line.street,
    zip: normalizeZip(zip) || line.zip,
  };
}

/**
 * Canonical key for duplicate detection: normalized street line + unit + ZIP.
 * ZIP+4 collapses to ZIP5 so the same door imported twice still matches.
 */
export function addressDedupeKey({ address, city = '', state = '', zip = '' } = {}) {
  const { line, zip: zip5 } = canonicalStreetLine(address, { city, state, zip });
  return `${line}|${zip5}`;
}

export function parseHouseNumber(value) {
  const match = String(value || '').trim().match(/^(\d+)/);
  return match ? Number(match[1]) : null;
}

export function parseStreetName(value) {
  const { street } = splitAddressUnit(value);
  return street.replace(/^\d+\s*/, '').trim();
}
