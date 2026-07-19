import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Canvas development fallback requests complete residential and access evidence without polluting road-only cache', async () => {
  const source = readFileSync(new URL('../src/components/logic/overpassRoadNetwork.jsx', import.meta.url), 'utf8');
  const previousStorage = globalThis.sessionStorage;
  const previousFetch = globalThis.fetch;
  const stored = new Map();
  const queries = [];
  globalThis.sessionStorage = {
    getItem: (key) => stored.get(key) || null,
    setItem: (key, value) => stored.set(key, value),
    removeItem: (key) => stored.delete(key),
  };
  globalThis.fetch = async (_url, request) => {
    queries.push(new URLSearchParams(String(request.body)).get('data') || '');
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ elements: [{ type: 'node', id: queries.length, lat: 33, lon: -112 }] }),
    };
  };
  try {
    const loader = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#residential-evidence`);
    const polygon = [
      { lat: 33, lng: -112 },
      { lat: 33.01, lng: -112 },
      { lat: 33, lng: -111.99 },
    ];
    const evidence = await loader.fetchOverpassRoadNetwork(polygon, { includeResidentialEvidence: true });
    const roadOnly = await loader.fetchOverpassRoadNetwork(polygon);

    assert.equal(queries.length, 2, 'residential evidence and road-only requests must use different cache identities');
    assert.equal(evidence._canvas.residential_evidence, true);
    assert.equal(roadOnly._canvas.residential_evidence, false);
    for (const selector of [
      'nwr["building"]',
      'nwr["addr:housenumber"]',
      'nwr["addr:unit"]',
      'node["entrance"]',
      'relation["type"="associatedStreet"]',
      'nwr["landuse"]',
      'nwr["shop"]',
      'nwr["amenity"]',
      'nwr["barrier"]',
      'nwr["access"]',
      'nwr["foot"]',
    ]) assert.match(queries[0], new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(queries[1], /nwr\["building"\]|nwr\["shop"\]|node\["entrance"\]/);
  } finally {
    globalThis.sessionStorage = previousStorage;
    globalThis.fetch = previousFetch;
  }
});
