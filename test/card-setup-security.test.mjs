import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');

function load(path, { base44, stripeApi }) {
  const source = readFileSync(resolve(rootDir, path), 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: path,
    reportDiagnostics: true
  });
  assert.deepEqual(
    (transpiled.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error),
    []
  );
  let handler;
  class Stripe {
    constructor() {
      return stripeApi;
    }
  }
  vm.runInNewContext(transpiled.outputText.replace(/^import .*;\s*$/gm, ''), {
    console,
    createClientFromRequest: () => base44,
    Stripe,
    Deno: {
      env: {
        get: (name) => ({
          STRIPE_SECRET_KEY: 'sk_test',
          STRIPE_WEBHOOK_SECRET: 'whsec_test',
          BASE44_APP_ID: 'app_test'
        })[name]
      },
      serve: (registeredHandler) => { handler = registeredHandler; }
    },
    Request,
    Response,
    URL,
    Date
  }, { filename: path });
  return handler;
}

test('card gate uses Stripe setup mode with no subscription or charge', async () => {
  const user = { id: 'user_1', email: 'user@example.com', full_name: 'User One' };
  const userUpdates = [];
  let checkoutConfig;
  const base44 = {
    auth: { me: async () => user },
    asServiceRole: {
      entities: {
        User: {
          get: async () => user,
          update: async (_id, updates) => userUpdates.push(updates)
        }
      }
    }
  };
  const stripeApi = {
    subscriptions: { search: async () => ({ data: [] }) },
    customers: {
      search: async () => ({ data: [] }),
      create: async () => ({ id: 'cus_setup', metadata: { base44_user_id: user.id } })
    },
    checkout: {
      sessions: {
        list: async () => ({ data: [] }),
        expire: async () => {},
        create: async (config) => {
          checkoutConfig = config;
          return { url: 'https://checkout.stripe.test/setup' };
        }
      }
    }
  };
  const handler = load('base44/functions/createCardSetupSession/entry.ts', { base44, stripeApi });
  const response = await handler(new Request('https://firstknock.online/api/setup-card', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      successUrl: 'https://firstknock.online/Home?card_setup=success',
      cancelUrl: 'https://evil.example.com/steal'
    })
  }));
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.url, 'https://checkout.stripe.test/setup');
  assert.equal(checkoutConfig.mode, 'setup');
  assert.equal(checkoutConfig.customer, 'cus_setup');
  assert.equal(checkoutConfig.metadata.base44_user_id, user.id);
  assert.equal(checkoutConfig.metadata.checkout_intent, 'knock_card_gate');
  assert.equal(checkoutConfig.line_items, undefined);
  assert.equal(checkoutConfig.subscription_data, undefined);
  assert.equal(checkoutConfig.cancel_url, 'https://firstknock.online/Home?card_setup=canceled');
  assert.equal(userUpdates.length, 1);
  assert.equal(userUpdates[0].stripe_customer_id, 'cus_setup');
});

test('setup Checkout completion caches a card only after Stripe confirms attachment', async () => {
  const updates = [];
  const base44 = {
    asServiceRole: {
      entities: {
        User: { update: async (_id, value) => updates.push(value) },
        InviteCode: {
          filter: async () => [],
          create: async () => {},
          update: async () => {}
        }
      }
    }
  };
  const session = {
    id: 'cs_setup',
    mode: 'setup',
    customer: 'cus_setup',
    metadata: {
      base44_user_id: 'user_1',
      checkout_intent: 'knock_card_gate'
    }
  };
  const stripeApi = {
    webhooks: {
      constructEventAsync: async () => ({
        type: 'checkout.session.completed',
        id: 'evt_setup',
        data: { object: session }
      })
    },
    customers: {
      retrieve: async () => ({
        id: 'cus_setup',
        metadata: { base44_user_id: 'user_1' }
      })
    },
    paymentMethods: {
      list: async () => ({ data: [{ id: 'pm_card' }] })
    }
  };
  const handler = load('base44/functions/stripeWebhook/entry.ts', { base44, stripeApi });
  const response = await handler(new Request('https://firstknock.online/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 'sig_test' },
    body: '{}'
  }));

  assert.equal(response.status, 200);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].stripe_customer_id, 'cus_setup');
  assert.equal(updates[0].stripe_card_on_file_confirmed, true);
  assert.ok(updates[0].stripe_card_confirmed_at);
});
