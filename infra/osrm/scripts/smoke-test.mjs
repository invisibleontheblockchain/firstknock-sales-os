#!/usr/bin/env node

const baseUrl = String(process.argv[2] || process.env.OSRM_BASE_URL || 'http://127.0.0.1:8080')
  .replace(/\/+$/, '');
const profile = String(process.env.OSRM_API_PROFILE || 'foot');
const token = String(process.env.OSRM_GATEWAY_TOKEN || '');
const expectedVersion = String(process.env.OSRM_DATA_VERSION || '');
const expectedFingerprint = String(process.env.OSRM_BUILD_FINGERPRINT || '');
const expectedCoverage = String(process.env.OSRM_COVERAGE_ID || 'us-50-states-dc');

const precisionCoordinates = '-96.5992,32.7668;-96.6075,32.7708';
const jurisdictionCenters = [
  ['AL', -86.3000, 32.3777], ['AK', -134.4197, 58.3019],
  ['AZ', -112.0740, 33.4484], ['AR', -92.2896, 34.7465],
  ['CA', -121.4944, 38.5816], ['CO', -104.9903, 39.7392],
  ['CT', -72.6851, 41.7637], ['DE', -75.5244, 39.1582],
  ['FL', -84.2807, 30.4383], ['GA', -84.3880, 33.7490],
  ['HI', -157.8583, 21.3069], ['ID', -116.2023, 43.6150],
  ['IL', -89.6501, 39.7817], ['IN', -86.1581, 39.7684],
  ['IA', -93.6091, 41.5868], ['KS', -95.6890, 39.0473],
  ['KY', -84.8733, 38.2009], ['LA', -91.1403, 30.4515],
  ['ME', -69.7795, 44.3106], ['MD', -76.4922, 38.9784],
  ['MA', -71.0589, 42.3601], ['MI', -84.5555, 42.7325],
  ['MN', -93.0899, 44.9537], ['MS', -90.1848, 32.2988],
  ['MO', -92.1735, 38.5767], ['MT', -112.0391, 46.5891],
  ['NE', -96.7026, 40.8136], ['NV', -119.7674, 39.1638],
  ['NH', -71.5376, 43.2081], ['NJ', -74.7429, 40.2171],
  ['NM', -105.9378, 35.6870], ['NY', -73.7562, 42.6526],
  ['NC', -78.6382, 35.7796], ['ND', -100.7837, 46.8083],
  ['OH', -82.9988, 39.9612], ['OK', -97.5164, 35.4676],
  ['OR', -123.0351, 44.9429], ['PA', -76.8867, 40.2732],
  ['RI', -71.4128, 41.8240], ['SC', -81.0348, 34.0007],
  ['SD', -100.3510, 44.3683], ['TN', -86.7816, 36.1627],
  ['TX', -97.7431, 30.2672], ['UT', -111.8910, 40.7608],
  ['VT', -72.5754, 44.2601], ['VA', -77.4360, 37.5407],
  ['WA', -122.9007, 47.0379], ['WV', -81.6326, 38.3498],
  ['WI', -89.4012, 43.0731], ['WY', -104.8202, 41.1400],
  ['DC', -77.0280, 38.8983],
];
const coverageProbes = jurisdictionCenters.map(([name, longitude, latitude]) => ({
  name,
  coordinates: `${longitude},${latitude};${(longitude + 0.001).toFixed(4)},${latitude}`,
}));

if (!/^[0-9a-f]{64}$/i.test(token)) {
  console.error('Set OSRM_GATEWAY_TOKEN to exactly 64 hexadecimal characters before running this smoke test.');
  process.exit(2);
}
if (!/^[0-9a-f]{64}$/i.test(expectedFingerprint)) {
  console.error('Set OSRM_BUILD_FINGERPRINT to the promoted 64-character content/runtime SHA-256.');
  process.exit(2);
}

async function request(path, {
  authenticated = true,
  authorizationToken = token,
  expectedStatus = 200,
  parseJson = true,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7_000);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: authenticated ? { Authorization: `Bearer ${authorizationToken}` } : {},
      signal: controller.signal,
    });
    const body = await response.text();
    if (response.status !== expectedStatus) {
      throw new Error(`Expected HTTP ${expectedStatus}, received ${response.status}: ${body.slice(0, 200)}`);
    }
    return { response, json: parseJson ? JSON.parse(body) : null };
  } finally {
    clearTimeout(timer);
  }
}

const startedAt = performance.now();
const health = await request('/healthz', { authenticated: false });
if (health.json?.code !== 'Ok') {
  throw new Error(`Health response code was ${String(health.json?.code)}`);
}

const coordinates = precisionCoordinates;
const tablePath = `/table/v1/${profile}/${coordinates}`
  + '?annotations=duration,distance&radiuses=150;150';

await request(tablePath, { authenticated: false, expectedStatus: 401, parseJson: false });
await request(tablePath, {
  authorizationToken: `${token}invalid`,
  expectedStatus: 401,
  parseJson: false,
});

const table = await request(tablePath);
const { durations, distances, sources, destinations } = table.json || {};

if (table.json?.code !== 'Ok') {
  throw new Error(`Table response code was ${String(table.json?.code)}`);
}

for (const [name, matrix] of [['durations', durations], ['distances', distances]]) {
  if (!Array.isArray(matrix) || matrix.length !== 2 || matrix.some((row) => !Array.isArray(row) || row.length !== 2)) {
    throw new Error(`${name} was not a 2x2 matrix.`);
  }
  if (matrix.some((row) => row.some((value) => !Number.isFinite(value)))) {
    throw new Error(`${name} contained a null or non-finite value.`);
  }
}

if (!Array.isArray(sources) || sources.length !== 2 || !Array.isArray(destinations) || destinations.length !== 2) {
  throw new Error('Waypoint arrays did not preserve the two input coordinates.');
}

for (const waypoint of [...sources, ...destinations]) {
  if (!Number.isFinite(waypoint?.distance) || waypoint.distance > 150) {
    throw new Error('A smoke-test coordinate snapped farther than the 150 m limit.');
  }
}

const declaredVersion = table.response.headers.get('x-osrm-data-version') || '';
const declaredFingerprint = table.response.headers.get('x-osrm-build-fingerprint') || '';
const declaredCoverage = table.response.headers.get('x-osrm-coverage') || '';
const graphVersion = String(table.json?.data_version || '');
if (!declaredVersion || !graphVersion || declaredVersion !== graphVersion) {
  throw new Error(`Gateway/graph data-version mismatch: ${declaredVersion || 'none'} / ${graphVersion || 'none'}.`);
}
if (expectedVersion && declaredVersion !== expectedVersion) {
  throw new Error(`Expected gateway data version ${expectedVersion}, received ${declaredVersion || 'none'}.`);
}
if (expectedVersion && graphVersion !== expectedVersion) {
  throw new Error(`Expected graph data version ${expectedVersion}, received ${graphVersion || 'none'}.`);
}
if (!declaredCoverage || declaredCoverage !== expectedCoverage) {
  throw new Error(`Expected coverage ${expectedCoverage}, received ${declaredCoverage || 'none'}.`);
}
if (declaredFingerprint !== expectedFingerprint) {
  throw new Error(`Expected build fingerprint ${expectedFingerprint}, received ${declaredFingerprint || 'none'}.`);
}

const cachedTable = await request(tablePath);
if (cachedTable.json?.code !== 'Ok'
  || cachedTable.response.headers.get('x-osrm-cache') !== 'HIT'
  || cachedTable.response.headers.get('x-osrm-build-fingerprint') !== expectedFingerprint) {
  throw new Error('Repeated Table request did not produce a valid gateway cache HIT.');
}

const verifiedCoverageProbes = [];
for (const probe of coverageProbes) {
  await new Promise((resolve) => setTimeout(resolve, 60));
  const probePath = `/table/v1/${profile}/${probe.coordinates}`
    + '?annotations=duration,distance&radiuses=1000;1000';
  const result = await request(probePath);
  const probeDurations = result.json?.durations;
  const probeDistances = result.json?.distances;
  const probeWaypoints = [
    ...(Array.isArray(result.json?.sources) ? result.json.sources : []),
    ...(Array.isArray(result.json?.destinations) ? result.json.destinations : []),
  ];

  if (result.json?.code !== 'Ok') {
    throw new Error(`${probe.name} coverage response code was ${String(result.json?.code)}.`);
  }
  for (const [name, matrix] of [['durations', probeDurations], ['distances', probeDistances]]) {
    if (!Array.isArray(matrix) || matrix.length !== 2
      || matrix.some((row) => !Array.isArray(row) || row.length !== 2)
      || matrix.some((row) => row.some((value) => !Number.isFinite(value)))) {
      throw new Error(`${probe.name} ${name} was not a finite 2x2 matrix.`);
    }
  }
  if (probeWaypoints.length !== 4
    || probeWaypoints.some((waypoint) => !Number.isFinite(waypoint?.distance) || waypoint.distance > 1000)) {
    throw new Error(`${probe.name} did not preserve four waypoints within the coverage-probe snap limit.`);
  }
  if (result.response.headers.get('x-osrm-coverage') !== expectedCoverage
    || result.response.headers.get('x-osrm-build-fingerprint') !== expectedFingerprint
    || result.response.headers.get('x-osrm-data-version') !== declaredVersion
    || String(result.json?.data_version || '') !== graphVersion) {
    throw new Error(`${probe.name} returned inconsistent coverage or graph metadata.`);
  }
  verifiedCoverageProbes.push(probe.name);
}

console.log(JSON.stringify({
  ok: true,
  profile,
  coverage: declaredCoverage,
  buildFingerprint: declaredFingerprint,
  verifiedCoverageProbes,
  declaredDataVersion: declaredVersion || null,
  graphDataVersion: graphVersion || null,
  firstCacheResult: table.response.headers.get('x-osrm-cache'),
  repeatedCacheResult: cachedTable.response.headers.get('x-osrm-cache'),
  requestMilliseconds: Math.round(performance.now() - startedAt),
  offDiagonalDurationSeconds: [durations[0][1], durations[1][0]],
  offDiagonalDistanceMeters: [distances[0][1], distances[1][0]],
}, null, 2));
