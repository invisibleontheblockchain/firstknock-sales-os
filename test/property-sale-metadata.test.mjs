import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { resolvePropertySaleMetadata } from '../src/components/logic/propertySaleMetadata.js';

test('sale metadata resolves canonical route-card fields', () => {
  assert.deepEqual(resolvePropertySaleMetadata({
    sold_date: '2025-09-15T00:00:00.000Z',
    price: 825000,
  }), {
    soldDate: '2025-09-15T00:00:00.000Z',
    amount: 825000,
  });
});

test('sale metadata recognizes common direct aliases and skips empty canonical values', () => {
  assert.deepEqual(resolvePropertySaleMetadata({
    sold_date: '',
    price: 0,
    lastSaleDate: '2025-11-03',
    lastSalePrice: '$725,000',
  }), {
    soldDate: '2025-11-03',
    amount: 725000,
  });
});

test('sale metadata recognizes nested provider sale and intel aliases', () => {
  assert.deepEqual(resolvePropertySaleMetadata({
    intel: {
      lastSoldDate: '2026-03-12',
    },
    sale: {
      lastSale: {
        salePrice: 610000,
      },
    },
  }), {
    soldDate: '2026-03-12',
    amount: 610000,
  });
});

test('sale metadata safely resolves minimized raw payload metadata', () => {
  assert.deepEqual(resolvePropertySaleMetadata({
    raw_payload: JSON.stringify({
      sale: {
        date: '2026-01-08',
        amount: '540000',
      },
    }),
  }), {
    soldDate: '2026-01-08',
    amount: 540000,
  });
});

test('sale metadata returns nulls when every candidate is empty or invalid', () => {
  assert.deepEqual(resolvePropertySaleMetadata({
    sold_date: 'not-a-date',
    price: 0,
    sale: { amount: '' },
  }), {
    soldDate: null,
    amount: null,
  });
});

test('Knock and Checklist cards share the sale metadata resolver', () => {
  for (const file of [
    'src/components/rep/PropertyCard.jsx',
    'src/components/routes/RouteChecklist.jsx',
  ]) {
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /resolvePropertySaleMetadata\(prop(?:erty)?\)/);
  }
});
