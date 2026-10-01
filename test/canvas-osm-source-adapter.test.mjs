import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dedupeAddressEvidence,
  legalAccessOf,
  occupancyOf,
  placeUseOf,
  landUseOf,
  pedestrianAccessOf,
  roadClassOf,
} from '../scripts/canvas-evidence/osm-source-adapter.mjs';

// These are the tag readings that decide whether a real street becomes knockable
// work. Getting one wrong sends reps to the wrong doors, so each rule is pinned
// against the OSM tagging it is meant to read.

test('road class passes through only values the contract accepts', () => {
  assert.equal(roadClassOf({ highway: 'residential' }), 'residential');
  assert.equal(roadClassOf({ highway: 'living_street' }), 'living_street');
  // Anything outside the enum degrades to unknown rather than being coerced
  // into a plausible-looking neighbour.
  assert.equal(roadClassOf({ highway: 'raceway' }), 'unknown');
  assert.equal(roadClassOf({}), 'unknown');
});

test('legal access is read separately from opportunity, and an unsigned gate stays unknown', () => {
  assert.equal(legalAccessOf({}), 'public');
  assert.equal(legalAccessOf({ access: 'private' }), 'denied');
  assert.equal(legalAccessOf({ foot: 'no' }), 'denied');
  assert.equal(legalAccessOf({ foot: 'designated' }), 'permitted');
  assert.equal(legalAccessOf({ access: 'permissive' }), 'permitted');
  // "customers" is neither an invitation nor a refusal for a door knocker.
  assert.equal(legalAccessOf({ access: 'customers' }), 'unknown');
  // An explicit foot permission beats a restrictive generic access tag.
  assert.equal(legalAccessOf({ access: 'private', foot: 'yes' }), 'permitted');
});

test('occupancy is claimed only where OSM states it', () => {
  assert.equal(occupancyOf({ building: 'house' }), 'residential');
  assert.equal(occupancyOf({ building: 'apartments' }), 'residential');
  assert.equal(occupancyOf({ building: 'warehouse' }), 'commercial');
  assert.equal(occupancyOf({ building: 'mixed_use' }), 'mixed');
  assert.equal(occupancyOf({ shop: 'bakery' }), 'commercial');
  // A bare building=yes says nothing about who lives there. Guessing here is
  // exactly how a commercial strip becomes a fake residential territory.
  assert.equal(occupancyOf({ building: 'yes' }), 'unknown');
  assert.equal(occupancyOf({}), 'unknown');
});

test('unmapped place and land use are dropped rather than coerced', () => {
  assert.equal(placeUseOf({ shop: 'bakery' }), 'shop');
  assert.equal(placeUseOf({ amenity: 'school' }), 'school');
  assert.equal(placeUseOf({ amenity: 'bench' }), null, 'an unmapped amenity contributes nothing');
  assert.equal(landUseOf({ landuse: 'residential' }), 'residential');
  assert.equal(landUseOf({ landuse: 'farmland' }), 'farmland');
  assert.equal(landUseOf({ landuse: 'brownfield' }), null, 'an unmapped land use contributes nothing');
});

test('pedestrian access uses the contract enum, not OSM wording', () => {
  assert.equal(pedestrianAccessOf({ foot: 'yes' }), 'allowed');
  assert.equal(pedestrianAccessOf({ foot: 'no' }), 'denied');
  assert.equal(pedestrianAccessOf({ barrier: 'gate' }), 'unknown');
});

test('one physical address is owned by exactly one blockface', () => {
  const address = (id, key, method, road, distance, occupancy = 'unknown', units = []) => ({
    evidence_id: id,
    kind: 'address',
    attributes: { address_key: key, unit_keys: units, occupancy },
    associations: [{
      method,
      road_identity: { source_namespace: 'osm-way', source_feature_id: road, segment_index: 0, from_millionths: 0, to_millionths: 1000 },
      ...(distance === undefined ? {} : { distance_m: distance }),
    }],
    provenance: [],
  });

  // OSM routinely carries the same address twice: an address node inside a
  // building that repeats the tags. Emitting both double-counts the door, and
  // when the two land on different streets it breaks exclusive ownership.
  const deduped = dedupeAddressEvidence([
    address('node/1', '100-oak', 'nearest_road', 'way/1', 12),
    address('way/2/addr', '100-oak', 'address_street', 'way/2', undefined, 'residential', ['A']),
    address('node/3', '102-oak', 'nearest_road', 'way/1', 8),
  ]);

  const addresses = deduped.filter((record) => record.kind === 'address');
  assert.equal(addresses.length, 2, 'the duplicated address collapses to one');

  const oak100 = addresses.find((record) => record.attributes.address_key === '100-oak');
  assert.equal(oak100.associations[0].method, 'address_street', 'a named-street match outranks proximity');
  assert.equal(oak100.attributes.occupancy, 'residential', 'a stated occupancy beats an unknown one');
  assert.deepEqual(oak100.attributes.unit_keys, ['A'], 'units are unioned across duplicates');
});

test('the closer road wins when neither duplicate names a street', () => {
  const near = {
    evidence_id: 'node/1',
    kind: 'address',
    attributes: { address_key: '200-elm', unit_keys: [], occupancy: 'unknown' },
    associations: [{ method: 'nearest_road', road_identity: { source_namespace: 'osm-way', source_feature_id: 'way/near', segment_index: 0, from_millionths: 0, to_millionths: 1000 }, distance_m: 5 }],
    provenance: [],
  };
  const far = {
    ...near,
    evidence_id: 'node/2',
    associations: [{ ...near.associations[0], road_identity: { ...near.associations[0].road_identity, source_feature_id: 'way/far' }, distance_m: 40 }],
  };

  const [winner] = dedupeAddressEvidence([far, near]).filter((record) => record.kind === 'address');
  assert.equal(winner.associations[0].road_identity.source_feature_id, 'way/near');
});

test('non-address evidence passes through untouched', () => {
  const barrier = { evidence_id: 'node/9', kind: 'barrier', attributes: { barrier_type: 'gate', pedestrian_access: 'unknown' }, associations: [], provenance: [] };
  const result = dedupeAddressEvidence([barrier]);
  assert.deepEqual(result, [barrier]);
});
