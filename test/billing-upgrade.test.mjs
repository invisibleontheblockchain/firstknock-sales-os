import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

import { getBillingState, shouldShowTrialActivation } from '../src/lib/billingState.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');
const readSource = (path) => readFileSync(resolve(rootDir, path), 'utf8');

function makeStripeClass(api) {
  return class FakeStripe {
    constructor() {
      return api;
    }
  };
}

function loadBackendHandler(path, { base44, stripeApi }) {
  const transpiled = ts.transpileModule(readSource(path), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022
    },
    fileName: path,
    reportDiagnostics: true
  });
  const errors = (transpiled.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, [], `${path} contains TypeScript syntax errors`);

  let handler;
  const executable = transpiled.outputText.replace(/^import .*;\s*$/gm, '');
  vm.runInNewContext(executable, {
    console,
    createClientFromRequest: () => base44,
    Deno: {
      env: { get: () => 'test_secret' },
      serve: (registeredHandler) => { handler = registeredHandler; }
    },
    Request,
    Response,
    Stripe: makeStripeClass(stripeApi)
  }, { filename: path });
  assert.equal(typeof handler, 'function', `${path} did not register a Deno handler`);
  return handler;
}

function makeTrial({ id = 'sub_trial', amount = 9900, tier = 'precision', customer = 'cus_1' } = {}) {
  return {
    id,
    status: 'trialing',
    customer,
    trial_end: Math.floor(Date.now() / 1000) + 86400,
    metadata: { base44_user_id: 'user_1', subscription_tier: tier },
    items: {
      data: [{
        id: `si_${id}`,
        quantity: 1,
        price: {
          id: `price_${amount}`,
          unit_amount: amount,
          currency: 'usd',
          metadata: {},
          recurring: { interval: 'month', interval_count: 1 }
        }
      }]
    },
    latest_invoice: { status: 'paid', amount_paid: 0 }
  };
}

function makeBase44(user, { updateMe, getUser, updateUser, teamMembers = [] } = {}) {
  return {
    auth: {
      me: async () => user,
      updateMe: updateMe || (async () => {})
    },
    asServiceRole: {
      entities: {
        User: {
          get: getUser || (async () => user),
          update: updateUser || (async () => {})
        },
        InviteCode: {
          filter: async () => [],
          create: async () => {},
          update: async () => {}
        },
        TeamMember: {
          filter: async () => teamMembers
        }
      }
    }
  };
}

test('billing states separate checkout, trial activation, and payment recovery', () => {
  assert.deepEqual(getBillingState({ subscription_status: 'canceled' }), {
    status: 'canceled',
    isTrialing: false,
    isActive: false,
    needsPaymentRecovery: false,
    hasSubscription: false,
    currentPlanId: null
  });
  assert.equal(getBillingState({ subscription_status: 'past_due' }).needsPaymentRecovery, true);
  assert.equal(getBillingState({ subscription_status: 'past_due' }).hasSubscription, true);
  assert.equal(shouldShowTrialActivation({ subscription_status: 'trialing', subscription_tier: 'precision' }, 'precision'), true);
  assert.equal(shouldShowTrialActivation({ subscription_status: 'trialing', subscription_tier: 'precision' }, 'canvas'), false);
  assert.equal(shouldShowTrialActivation({ subscription_status: 'trialing', subscription_tier: 'canvas' }, 'precision'), true);
  assert.equal(shouldShowTrialActivation({ subscription_status: 'trialing', subscription_tier: 'canvas' }, 'canvas'), true);
  assert.equal(shouldShowTrialActivation({ subscription_status: 'active', subscription_tier: 'precision' }, 'precision'), false);
});

test('activating a $99 trial ends the same subscription and never opens Checkout', async () => {
  const user = { id: 'user_1', email: 'test@example.com', stripe_customer_id: 'cus_1', subscription_id: 'sub_trial' };
  const trial = makeTrial();
  const subscriptionUpdates = [];
  let checkoutCreates = 0;
  const stripeApi = {
    subscriptions: {
      retrieve: async () => trial,
      list: async () => ({ data: [trial] }),
      update: async (id, params) => {
        subscriptionUpdates.push({ id, params });
        return {
          ...trial,
          status: 'active',
          trial_end: null,
          latest_invoice: { status: 'paid', amount_paid: 9900 }
        };
      }
    },
    prices: { create: async () => { throw new Error('price should be reused'); } },
    billingPortal: { sessions: { create: async () => { throw new Error('portal should not open'); } } },
    checkout: { sessions: { create: async () => { checkoutCreates += 1; } } }
  };
  const handler = loadBackendHandler('base44/functions/createCheckoutSession/entry.ts', {
    base44: makeBase44(user),
    stripeApi
  });
  const response = await handler(new Request('https://app.example.com/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://app.example.com' },
    body: JSON.stringify({ action: 'activate_trial', planId: 'precision', quantity: 1 })
  }));
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.subscription_id, 'sub_trial');
  assert.equal(result.paid, true);
  assert.equal(checkoutCreates, 0);
  assert.equal(subscriptionUpdates.length, 1);
  assert.equal(subscriptionUpdates[0].id, 'sub_trial');
  assert.equal(subscriptionUpdates[0].params.trial_end, 'now');
  assert.equal(subscriptionUpdates[0].params.payment_behavior, 'pending_if_incomplete');
});

test('a Canvas trial switches in place to the server-controlled $99 monthly price', async () => {
  const user = { id: 'user_1', email: 'test@example.com', stripe_customer_id: 'cus_1', subscription_id: 'sub_canvas' };
  const trial = makeTrial({ id: 'sub_canvas', amount: 1900, tier: 'canvas' });
  let createdPriceParams;
  let activationParams;
  const stripeApi = {
    subscriptions: {
      retrieve: async () => trial,
      list: async () => ({ data: [trial] }),
      update: async (_id, params) => {
        activationParams = params;
        return {
          ...trial,
          status: 'active',
          trial_end: null,
          items: {
            data: [{ ...trial.items.data[0], price: { ...trial.items.data[0].price, id: 'price_precision', unit_amount: 9900 } }]
          },
          latest_invoice: { status: 'paid', amount_paid: 9900 }
        };
      }
    },
    prices: {
      create: async (params) => {
        createdPriceParams = params;
        return { id: 'price_precision' };
      }
    },
    billingPortal: { sessions: { create: async () => { throw new Error('portal should not open'); } } },
    checkout: { sessions: { create: async () => { throw new Error('Checkout should not open'); } } }
  };
  const handler = loadBackendHandler('base44/functions/createCheckoutSession/entry.ts', {
    base44: makeBase44(user),
    stripeApi
  });
  const response = await handler(new Request('https://app.example.com/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'activate_trial', planId: 'precision', quantity: 1 })
  }));

  assert.equal(response.status, 200);
  assert.equal(createdPriceParams.unit_amount, 9900);
  assert.equal(createdPriceParams.recurring.interval, 'month');
  assert.equal(activationParams.items[0].id, trial.items.data[0].id);
  assert.equal(activationParams.items[0].price, 'price_precision');
  assert.equal(activationParams.trial_end, 'now');
});

test('trial reconciliation stores the selected Stripe subscription before charging', async () => {
  const user = { id: 'user_1', email: 'test@example.com', stripe_customer_id: 'cus_1', subscription_id: 'sub_stale' };
  const stale = { ...makeTrial({ id: 'sub_stale' }), status: 'canceled' };
  const liveTrial = makeTrial({ id: 'sub_live' });
  const sequence = [];
  const stripeApi = {
    subscriptions: {
      retrieve: async (id) => id === 'sub_stale' ? stale : liveTrial,
      list: async () => ({ data: [liveTrial] }),
      update: async (id, params) => {
        sequence.push(`charge:${id}`);
        return { ...liveTrial, status: 'active', trial_end: null, latest_invoice: { status: 'paid', amount_paid: 9900 }, updateParams: params };
      }
    },
    prices: { create: async () => { throw new Error('price should be reused'); } },
    billingPortal: { sessions: { create: async () => { throw new Error('portal should not open'); } } },
    checkout: { sessions: { create: async () => { throw new Error('Checkout should not open'); } } }
  };
  const base44 = makeBase44(user, {
    updateMe: async (updates) => sequence.push(`reconcile:${updates.subscription_id}`)
  });
  const handler = loadBackendHandler('base44/functions/createCheckoutSession/entry.ts', { base44, stripeApi });
  const response = await handler(new Request('https://app.example.com/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'activate_trial', planId: 'precision', quantity: 1 })
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(sequence, ['reconcile:sub_live', 'charge:sub_live']);
});

test('a stale local trial is reconciled so pay-now checkout can be shown again', async () => {
  const user = { id: 'user_1', stripe_customer_id: 'cus_1', subscription_id: 'sub_stale', subscription_status: 'trialing' };
  const canceled = { ...makeTrial({ id: 'sub_stale' }), status: 'canceled' };
  const userUpdates = [];
  const stripeApi = {
    subscriptions: {
      retrieve: async () => canceled,
      list: async () => ({ data: [canceled] })
    }
  };
  const handler = loadBackendHandler('base44/functions/createCheckoutSession/entry.ts', {
    base44: makeBase44(user, { updateMe: async (updates) => userUpdates.push(updates) }),
    stripeApi
  });
  const response = await handler(new Request('https://app.example.com/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'activate_trial', planId: 'precision' })
  }));
  const result = await response.json();

  assert.equal(response.status, 409);
  assert.equal(result.billing_reconciled, true);
  assert.equal(userUpdates[0].subscription_status, 'canceled');
  assert.equal(userUpdates[0].subscription_paid_confirmed, false);
});

test('trial activation repairs a missing local Stripe customer id from the subscription', async () => {
  const user = { id: 'user_1', subscription_id: 'sub_trial' };
  const trial = makeTrial();
  const userUpdates = [];
  const stripeApi = {
    subscriptions: {
      retrieve: async () => trial,
      list: async () => ({ data: [trial] }),
      update: async () => ({
        ...trial,
        status: 'active',
        trial_end: null,
        latest_invoice: { status: 'paid', amount_paid: 9900 }
      })
    },
    prices: { create: async () => { throw new Error('price should be reused'); } },
    billingPortal: { sessions: { create: async () => { throw new Error('portal should not open'); } } }
  };
  const handler = loadBackendHandler('base44/functions/createCheckoutSession/entry.ts', {
    base44: makeBase44(user, { updateMe: async (updates) => userUpdates.push(updates) }),
    stripeApi
  });
  const response = await handler(new Request('https://app.example.com/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'activate_trial', planId: 'precision' })
  }));

  assert.equal(response.status, 200);
  assert.equal(userUpdates[0].stripe_customer_id, 'cus_1');
});

test('multiple active trials are rejected before either one is charged', async () => {
  const user = { id: 'user_1', stripe_customer_id: 'cus_1', subscription_id: 'sub_one' };
  const first = makeTrial({ id: 'sub_one' });
  const second = makeTrial({ id: 'sub_two' });
  let updates = 0;
  const stripeApi = {
    subscriptions: {
      retrieve: async () => first,
      list: async () => ({ data: [first, second] }),
      update: async () => { updates += 1; }
    }
  };
  const handler = loadBackendHandler('base44/functions/createCheckoutSession/entry.ts', {
    base44: makeBase44(user),
    stripeApi
  });
  const response = await handler(new Request('https://app.example.com/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'activate_trial', planId: 'precision', quantity: 1 })
  }));

  assert.equal(response.status, 409);
  assert.equal(updates, 0);
  assert.match((await response.json()).error, /More than one active Stripe subscription/);
});

test('competing trial choices share one Stripe activation attempt', async () => {
  const user = { id: 'user_1', email: 'test@example.com', stripe_customer_id: 'cus_1', subscription_id: 'sub_trial' };
  const trial = {
    ...makeTrial({ amount: 1900, tier: 'canvas' }),
    latest_invoice: { id: 'in_trial', status: 'paid', amount_paid: 0 }
  };
  const activationCalls = [];
  const stripeApi = {
    subscriptions: {
      retrieve: async () => trial,
      list: async () => ({ data: [trial] }),
      update: async (_id, params, options) => {
        activationCalls.push({ params, options });
        return trial;
      }
    },
    prices: { create: async () => ({ id: 'price_precision' }) },
    billingPortal: { sessions: { create: async () => ({ url: 'https://billing.example.com/recover' }) } },
    checkout: { sessions: { create: async () => { throw new Error('Checkout should not open'); } } }
  };
  const base44 = makeBase44(user, {
    teamMembers: [
      { role: 'rep', status: 'active' },
      { role: 'rep', status: 'active' }
    ]
  });
  const handler = loadBackendHandler('base44/functions/createCheckoutSession/entry.ts', { base44, stripeApi });

  for (const planId of ['canvas', 'precision']) {
    const response = await handler(new Request('https://app.example.com/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'activate_trial', planId, quantity: 99 })
    }));
    assert.equal(response.status, 200);
  }

  assert.equal(activationCalls.length, 2);
  assert.equal(activationCalls[0].params.items[0].quantity, 2);
  assert.equal(activationCalls[1].params.items[0].quantity, 99);
  assert.equal(
    activationCalls[0].options.idempotencyKey,
    activationCalls[1].options.idempotencyKey,
    'different choices in the same trial state must compete for one Stripe update'
  );
  assert.match(activationCalls[0].options.idempotencyKey, /in_trial$/);
});

test('an existing pending trial update returns its payment URL without invoicing again', async () => {
  const user = { id: 'user_1', stripe_customer_id: 'cus_1', subscription_id: 'sub_trial' };
  const trial = {
    ...makeTrial(),
    pending_update: { expires_at: Math.floor(Date.now() / 1000) + 3600 },
    latest_invoice: {
      id: 'in_pending',
      status: 'open',
      amount_paid: 0,
      hosted_invoice_url: 'https://invoice.example.com/pay'
    }
  };
  let updates = 0;
  const stripeApi = {
    subscriptions: {
      retrieve: async () => trial,
      list: async () => ({ data: [trial] }),
      update: async () => { updates += 1; }
    }
  };
  const handler = loadBackendHandler('base44/functions/createCheckoutSession/entry.ts', {
    base44: makeBase44(user),
    stripeApi
  });
  const response = await handler(new Request('https://app.example.com/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'activate_trial', planId: 'precision' })
  }));
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.url, 'https://invoice.example.com/pay');
  assert.equal(updates, 0);
});

test('normal Checkout uses server pricing, preserves Precision seat purchases, and uses one generation key', async () => {
  const user = { id: 'user_1', email: 'test@example.com', stripe_customer_id: 'cus_1' };
  const checkoutCalls = [];
  const stripeApi = {
    subscriptions: { list: async () => ({ data: [] }) },
    checkout: {
      sessions: {
        list: async () => ({ data: [] }),
        expire: async () => {},
        create: async (params, options) => {
          checkoutCalls.push({ params, options });
          return { url: `https://checkout.example.com/${checkoutCalls.length}` };
        }
      }
    }
  };
  const base44 = makeBase44(user, {
    teamMembers: [
      { role: 'rep', status: 'active' },
      { role: 'rep', status: 'active' },
      { role: 'rep', status: 'inactive' }
    ]
  });
  const handler = loadBackendHandler('base44/functions/createCheckoutSession/entry.ts', { base44, stripeApi });

  for (const planId of ['canvas', 'precision']) {
    const response = await handler(new Request('https://app.example.com/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planId,
        quantity: 99,
        amountCents: 1,
        priceId: 'price_untrusted',
        successUrl: 'https://app.example.com/Billing?success=true',
        cancelUrl: 'https://app.example.com/Billing?canceled=true'
      })
    }));
    assert.equal(response.status, 200);
  }

  assert.equal(checkoutCalls[0].params.line_items[0].price_data.unit_amount, 1900);
  assert.equal(checkoutCalls[0].params.line_items[0].quantity, 2);
  assert.equal(checkoutCalls[1].params.line_items[0].price_data.unit_amount, 9900);
  assert.equal(checkoutCalls[1].params.line_items[0].quantity, 99);
  assert.equal(checkoutCalls[0].options.idempotencyKey, checkoutCalls[1].options.idempotencyKey);
});

test('Checkout reuses the matching session and expires other open subscription choices', async () => {
  const user = { id: 'user_1', email: 'test@example.com', stripe_customer_id: 'cus_1' };
  const matching = {
    id: 'cs_match',
    status: 'open',
    mode: 'subscription',
    url: 'https://checkout.example.com/match',
    client_reference_id: user.id,
    metadata: {
      base44_user_id: user.id,
      subscription_tier: 'precision',
      checkout_intent: 'pay',
      quantity: '1'
    }
  };
  const obsolete = {
    ...matching,
    id: 'cs_old',
    url: 'https://checkout.example.com/old',
    metadata: { ...matching.metadata, subscription_tier: 'canvas' }
  };
  const expired = [];
  let creates = 0;
  const stripeApi = {
    subscriptions: { list: async () => ({ data: [] }) },
    checkout: {
      sessions: {
        list: async () => ({ data: [matching, obsolete] }),
        expire: async (id) => expired.push(id),
        create: async () => { creates += 1; }
      }
    }
  };
  const handler = loadBackendHandler('base44/functions/createCheckoutSession/entry.ts', {
    base44: makeBase44(user),
    stripeApi
  });
  const response = await handler(new Request('https://app.example.com/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      planId: 'precision',
      successUrl: 'https://app.example.com/Billing?success=true',
      cancelUrl: 'https://app.example.com/Billing?canceled=true'
    })
  }));
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.url, matching.url);
  assert.deepEqual(expired, ['cs_old']);
  assert.equal(creates, 0);
});

test('webhook rejects $0 trial invoices and accepts a positive active invoice', async () => {
  for (const scenario of [
    { status: 'trialing', amountPaid: 0, expectedPaid: false },
    { status: 'active', amountPaid: 9900, expectedPaid: true }
  ]) {
    const subscription = {
      ...makeTrial(),
      status: scenario.status,
      trial_end: scenario.status === 'active' ? null : Math.floor(Date.now() / 1000) + 86400
    };
    const invoice = { subscription: subscription.id, status: 'paid', amount_paid: scenario.amountPaid };
    const userUpdates = [];
    const base44 = makeBase44({ id: 'user_1', subscription_id: subscription.id }, {
      updateUser: async (_id, updates) => userUpdates.push(updates)
    });
    const stripeApi = {
      webhooks: { constructEventAsync: async () => ({ type: 'invoice.paid', id: 'evt_1', data: { object: invoice } }) },
      subscriptions: { retrieve: async () => subscription }
    };
    const handler = loadBackendHandler('base44/functions/stripeWebhook/entry.ts', { base44, stripeApi });
    const response = await handler(new Request('https://app.example.com/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_test' },
      body: '{}'
    }));

    assert.equal(response.status, 200);
    assert.equal(userUpdates.length, 1);
    assert.equal(userUpdates[0].subscription_paid_confirmed, scenario.expectedPaid);
  }
});

test('subscription update webhooks read current Stripe state instead of stale event state', async () => {
  const liveSubscription = {
    ...makeTrial(),
    status: 'active',
    trial_end: null,
    current_period_end: Math.floor(Date.now() / 1000) + 2592000,
    latest_invoice: { status: 'paid', amount_paid: 9900 }
  };
  const userUpdates = [];
  const base44 = makeBase44({ id: 'user_1', subscription_id: liveSubscription.id }, {
    updateUser: async (_id, updates) => userUpdates.push(updates)
  });
  const stripeApi = {
    webhooks: {
      constructEventAsync: async () => ({
        type: 'customer.subscription.updated',
        id: 'evt_stale',
        data: { object: { ...liveSubscription, status: 'trialing', latest_invoice: null } }
      })
    },
    subscriptions: { retrieve: async () => liveSubscription },
    invoices: { retrieve: async () => liveSubscription.latest_invoice }
  };
  const handler = loadBackendHandler('base44/functions/stripeWebhook/entry.ts', { base44, stripeApi });
  const response = await handler(new Request('https://app.example.com/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 'sig_test' },
    body: '{}'
  }));

  assert.equal(response.status, 200);
  assert.equal(userUpdates[0].subscription_status, 'active');
  assert.equal(userUpdates[0].subscription_paid_confirmed, true);
});

test('webhook processing failures return 500 so Stripe retries', async () => {
  const subscription = { ...makeTrial(), status: 'active', trial_end: null };
  const stripeApi = {
    webhooks: {
      constructEventAsync: async () => ({
        type: 'invoice.paid',
        id: 'evt_retry',
        data: { object: { subscription: subscription.id, status: 'paid', amount_paid: 9900 } }
      })
    },
    subscriptions: { retrieve: async () => subscription }
  };
  const base44 = makeBase44({ id: 'user_1', subscription_id: subscription.id }, {
    getUser: async () => { throw new Error('temporary Base44 outage'); }
  });
  const handler = loadBackendHandler('base44/functions/stripeWebhook/entry.ts', { base44, stripeApi });
  const response = await handler(new Request('https://app.example.com/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 'sig_test' },
    body: '{}'
  }));

  assert.equal(response.status, 500);
});

test('UI and backend wiring keep the $99 activation and neutral Stripe return path', () => {
  const billingSource = readSource('src/pages/Billing.jsx');
  const checkoutSource = readSource('base44/functions/createCheckoutSession/entry.ts');
  const webhookSource = readSource('base44/functions/stripeWebhook/entry.ts');
  const activationStart = billingSource.indexOf('const handleActivateTrial');
  const activationEnd = billingSource.indexOf('// Handle return from Stripe checkout');
  assert.notEqual(activationStart, -1);
  assert.notEqual(activationEnd, -1);
  const activationSource = billingSource.slice(activationStart, activationEnd);

  assert.match(activationSource, /invoke\('createCheckoutSession',\s*\{\s*action: 'activate_trial'/);
  assert.match(activationSource, /billing_return=true/);
  assert.match(billingSource, /shouldShowTrialActivation\(user, plan\.id\)/);
  assert.match(billingSource, /id: 'precision',[\s\S]*?price: 99,/);
  assert.match(checkoutSource, /precision:\s*\{[\s\S]*?amountCents: 9900/);
  assert.match(checkoutSource, /trial_end: 'now'/);
  assert.match(checkoutSource, /payment_behavior: 'pending_if_incomplete'/);
  assert.match(checkoutSource, /checkout\.sessions\.list\(\{/);
  assert.match(checkoutSource, /checkout\.sessions\.expire\(session\.id\)/);
  assert.match(checkoutSource, /const checkoutIdempotencyKey = `firstknock-checkout-/);
  assert.match(webhookSource, /Number\(invoice\?\.amount_paid \|\| 0\) > 0/);
});
