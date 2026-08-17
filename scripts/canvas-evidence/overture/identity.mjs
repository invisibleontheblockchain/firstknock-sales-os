import { createHash } from 'node:crypto';

const text = (value) => String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function levels(properties) {
  const values = Array.isArray(properties?.address_levels) ? properties.address_levels : [];
  return values.map((level) => text(level?.value)).filter(Boolean);
}

export function normalizeOvertureAddress(properties = {}) {
  const addressLevels = levels(properties);
  const country = text(properties.country || 'US').toUpperCase();
  const number = text(properties.number);
  const street = text(properties.street);
  const unit = text(properties.unit);
  const locality = text(properties.postal_city || addressLevels.at(-1));
  const region = text(properties.region || addressLevels.at(-2));
  const postcode = text(properties.postcode);
  const normalizedAddress = [number, street, unit, locality, region, postcode, country.toLowerCase()].filter(Boolean).join('|');
  if (!number || !street) throw new TypeError('Overture address requires number and street for a stable FirstKnock identity.');
  const identity = { version: 1, country, number, street, unit, locality, region, postcode };
  const digest = hash(identity);
  return {
    identity,
    normalized_address: normalizedAddress,
    display_address: [properties.number, properties.street, properties.unit, properties.postal_city || addressLevels.at(-1), properties.postcode].filter(Boolean).join(', '),
    property_key: `fk-property-key-v1:${digest}`,
    fk_property_id: `FKP1_${digest}`,
  };
}

export function sanitizeSourceFeatureId(value, fallback) {
  const candidate = String(value || fallback || '').trim().replace(/[^A-Za-z0-9._:/-]+/g, '_').slice(0, 256);
  if (!candidate || !/^[A-Za-z0-9]/.test(candidate)) throw new TypeError('Source feature ID is invalid.');
  return candidate;
}