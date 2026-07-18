import assert from 'node:assert/strict';
import test from 'node:test';

import { hasCanvasAccess, isCanvasPlan } from '../src/lib/canvasAccess.js';

test('Canvas access fails closed for missing, unpaid, or wrong-plan accounts', () => {
  assert.equal(hasCanvasAccess(null), false);
  assert.equal(hasCanvasAccess({ subscription_tier: 'canvas', subscription_status: 'active' }), false);
  assert.equal(hasCanvasAccess({ subscription_tier: 'precision', subscription_status: 'active', subscription_paid_confirmed: true }), false);
  assert.equal(hasCanvasAccess({ subscription_tier: 'canvas', subscription_status: 'past_due', subscription_paid_confirmed: true }), false);
});

test('Canvas access accepts confirmed active Canvas accounts and card-backed Canvas trials', () => {
  assert.equal(hasCanvasAccess({
    subscription_tier: 'canvas',
    subscription_status: 'active',
    subscription_paid_confirmed: true,
  }), true);
  assert.equal(hasCanvasAccess({
    subscription_tier: 'canvas',
    subscription_status: 'trialing',
    stripe_card_on_file_confirmed: true,
  }), true);
  assert.equal(hasCanvasAccess({
    subscription_tier: 'canvas',
    subscription_status: 'trialing',
  }), false);
});

test('only the platform account role retains break-glass Canvas access', () => {
  assert.equal(hasCanvasAccess({ is_owner: true }), false);
  assert.equal(hasCanvasAccess({ app_role: 'admin' }), false);
  assert.equal(hasCanvasAccess({ role: 'admin' }), true);
  assert.equal(isCanvasPlan({ subscription_tier: 'canvas' }), true);
  assert.equal(isCanvasPlan({ subscription_tier: 'growth' }), false);
});
