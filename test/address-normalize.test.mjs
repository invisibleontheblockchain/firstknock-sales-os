import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addressDedupeKey,
  canonicalStreetLine,
  normalizeAddress,
  parseStreetLine,
  splitAddressUnit,
} from '../base44/shared/addressNormalize.js';

const key = (address, locality = {}) => addressDedupeKey({ address, ...locality });

test('every common spelling of a street suffix is the same door', () => {
  const zip = { zip: '08753' };
  for (const spelling of ['123 Water Street', '123 Water St', '123 water st.', '123 WATER STR', '123 Water Strt']) {
    assert.equal(key(spelling, zip), '123 water st|08753', spelling);
  }
  assert.equal(key('5 Oak Trail'), key('5 Oak Trl'));
  assert.equal(key('5 Oak Trail'), key('5 Oak Trails'));
  assert.equal(key('9 Riverside Parkway'), key('9 Riverside Pkwy'));
  assert.equal(key('9 Riverside Parkway'), key('9 Riverside Pky'));
  assert.equal(key('2 Harbor View Terrace'), key('2 Hbr Vw Ter'));
  assert.equal(key('14 Mountain Laurel Lane'), key('14 Mtn Laurel Ln'));
  assert.equal(key('3103 East 23rd Avenue'), key('3103 E 23rd Ave'));
  assert.equal(key('40 Northeast Grove Boulevard'), key('40 NE Grv Blvd'));
  assert.equal(key('7 First Avenue'), key('7 1st Ave'));
  assert.equal(key('9 Saint Johns Court'), key('9 St Johns Ct'));
  assert.equal(key('11 Fort King Road'), key('11 Ft King Rd'));
});

test('different streets, numbers and units never collapse together', () => {
  assert.notEqual(key('123 Water St'), key('124 Water St'));
  assert.notEqual(key('123 Water St'), key('123 Water Ct'));
  assert.notEqual(key('123 Lake Dr'), key('123 Lakes Dr'));
  assert.notEqual(key('123 Hill Rd'), key('123 Hills Rd'));
  assert.notEqual(key('123 Green St'), key('123 Greene St'));
  assert.notEqual(key('123 N Water St'), key('123 Water St'));
  assert.notEqual(key('12 Oak St Apt 1'), key('12 Oak St Apt 2'));
  assert.notEqual(key('12 Oak St'), key('12 Oak St Apt 2'));
  assert.notEqual(key('12 Oak St, 2nd Floor'), key('12 Oak St, 3rd Floor'));
  assert.notEqual(key('123 Water St', { zip: '08753' }), key('123 Water St', { zip: '08754' }));
});

test('unit designators are interchangeable and street words that look like them are not', () => {
  for (const spelling of ['12 Oak St Apt 4', '12 Oak St #4', '12 Oak St Unit 4', '12 Oak St, Suite 4', '12 Oak St Ste. 4', '12 Oak St, Apt 4']) {
    assert.equal(key(spelling), '12 oak st # 4|', spelling);
  }
  assert.equal(key('12 Oak St Rear'), '12 oak st # rear|');
  assert.equal(key('12 Oak St Lot 7'), key('12 Oak St #7'));
  // "Key West" and "Space Center" are street names, not unit designators.
  assert.equal(key('123 Key West Ave'), '123 ky w ave|');
  assert.equal(key('123 Space Center Blvd'), '123 space ctr blvd|');
  assert.deepEqual(splitAddressUnit('4015 BAYSHORE BOULEVARD #12B'), { street: '4015 bayshore blvd', unit: '12b' });
  assert.deepEqual(splitAddressUnit('12 Oak St Unit 4B'), { street: '12 oak st', unit: '4b' });
});

test('a full address in one column matches the bare street line in another', () => {
  const bare = key('123 Water St', { zip: '08753' });
  assert.equal(key('123 Water St, Toms River, NJ 08753', { zip: '08753' }), bare);
  assert.equal(key('123 Water Street, Toms River, NJ 08753-1234'), bare);
  assert.equal(key('123 Water Street, Toms River, NJ 08753', { zip: '08754' }), '123 water st|08754');
  assert.equal(key('123 Water St Toms River NJ 08753', { city: 'Toms River', state: 'NJ', zip: '08753' }), bare);
  assert.equal(key('123 Water St Toms River NJ 08753', { city: 'Toms River', state: 'NJ' }), bare);
  assert.equal(key('123 WATER STREET TOMS RIVER NJ', { city: 'Toms River', state: 'NJ', zip: '08753' }), bare);
  assert.equal(key('123 Water St, Apt 2, Toms River, NJ 08753', { zip: '08753' }), '123 water st # 2|08753');
  assert.equal(key('123 Water St Apt 2 Toms River NJ 08753', { city: 'Toms River', state: 'NJ' }), '123 water st # 2|08753');
  // The ZIP found in the address keys a record whose sheet had no ZIP column,
  // and the state code in front of it goes with it.
  assert.deepEqual(canonicalStreetLine('123 Water St Toms River NJ 08753'), { line: '123 water st toms riv', zip: '08753' });
  assert.deepEqual(canonicalStreetLine('9 Elm St, Tampa, FL 33605'), { line: '9 elm st', zip: '33605' });
  assert.deepEqual(canonicalStreetLine('9 Elm St, Tampa, FL'), { line: '9 elm st', zip: '' });
  assert.deepEqual(canonicalStreetLine('9 Elm St, Apt 2, Key West, FL 33040'), { line: '9 elm st # 2', zip: '33040' });
});

test('locality is stripped only when it is unmistakable', () => {
  // Without the record's own ZIP, a number after a road word is a road number.
  assert.equal(key('100 County Road 12345'), '100 county rd 12345|');
  assert.equal(key('100 County Road 12345', { zip: '75001' }), '100 county rd 12345|75001');
  assert.equal(key('100 County Road 75001', { zip: '75001' }), '100 county rd|75001');
  // NE is Nebraska and a directional: the state alone is not stripped.
  assert.equal(key('123 Water St NE', { state: 'NE' }), '123 water st ne|');
  assert.equal(key('123 Water St NE Omaha NE 68102', { city: 'Omaha', state: 'NE', zip: '68102' }), '123 water st ne|68102');
  // A street named after the town keeps its name.
  assert.equal(key('123 Toms River', { city: 'Toms River', state: 'NJ' }), '123 toms riv|');
  assert.equal(key('123 Toms River Rd Toms River NJ', { city: 'Toms River', state: 'NJ' }), '123 toms riv rd|');
  assert.deepEqual(parseStreetLine('123 Oak St Springfield IL 62701', { city: 'Springfield', state: 'Illinois', zip: '62701' }), { street: '123 oak st', unit: '', zip: '62701' });
  assert.deepEqual(parseStreetLine('123 Oak St Springfield IL 62701'), { street: '123 oak st springfield', unit: '', zip: '62701' });
});

test('search normalization keeps the whole string and standardizes it', () => {
  assert.equal(normalizeAddress('123 Oak Road'), '123 oak rd');
  assert.equal(normalizeAddress('123 Oak Street, Toms River, NJ 08753'), '123 oak st toms riv nj 08753');
  assert.equal(normalizeAddress('12 Oak St Apt 4'), '12 oak st # 4');
  assert.ok(normalizeAddress('123 Water Street Toms River').includes(normalizeAddress('water st')));
  assert.equal(addressDedupeKey({ address: '123 Oak Street', zip: '29678-1234' }), addressDedupeKey({ address: '123 oak st', zip: '29678' }));
  assert.equal(addressDedupeKey({}), '|');
});
