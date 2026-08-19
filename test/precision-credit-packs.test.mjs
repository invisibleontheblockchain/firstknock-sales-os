/**
 * CREDIT PACKS — extra Precision usage is bought as a one-off pack, not as a
 * recurring line on the $99 subscription. These cover the two things that
 * decide how much money changes hands: how a slider position becomes a
 * purchasable number of blocks, and what that costs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    blocksForProperties,
    describeCreditPack,
    MAX_CREDIT_PACK_PROPERTIES,
    MIN_CREDIT_PACK_PROPERTIES
} from '../src/lib/precisionCreditPacks.js';
import {
    creditPackPriceCents,
    creditPackProperties,
    normalizeCreditPackBlocks,
    normalizeExtraCreditBlocks,
    PRECISION_CREDIT_PACK_INTENT
} from '../base44/shared/precisionCredits.js';

test('PACK-01 a pack cannot be zero, unlike the recurring add-on it replaces', () => {
    // 0 is how the legacy monthly add-on says "remove me" — as a purchase it is
    // meaningless, and charging $0 must never reach Stripe.
    assert.equal(normalizeExtraCreditBlocks(0), 0);
    assert.equal(normalizeCreditPackBlocks(0), null);
    assert.equal(normalizeCreditPackBlocks(1), 1);
});

test('PACK-02 the server rejects block counts outside the purchasable range', () => {
    assert.equal(normalizeCreditPackBlocks(49), 49);
    assert.equal(normalizeCreditPackBlocks(50), null);
    assert.equal(normalizeCreditPackBlocks(-1), null);
    assert.equal(normalizeCreditPackBlocks(2.5), null);
    assert.equal(normalizeCreditPackBlocks('3'), 3);
    assert.equal(normalizeCreditPackBlocks(undefined), null);
});

test('PACK-03 price is $49 per 1,000 properties, charged once', () => {
    assert.equal(creditPackProperties(1), 1000);
    assert.equal(creditPackPriceCents(1), 4900);
    assert.equal(creditPackProperties(10), 10000);
    assert.equal(creditPackPriceCents(10), 49000);
    assert.equal(creditPackPriceCents(49), 240100);
});

test('PACK-04 a dragged slider value is clamped to whole purchasable blocks', () => {
    assert.equal(blocksForProperties(1000), 1);
    assert.equal(blocksForProperties(5000), 5);
    // Untrusted input: below the floor, above the ceiling, and off-step.
    assert.equal(blocksForProperties(0), 1);
    assert.equal(blocksForProperties(-4000), 1);
    assert.equal(blocksForProperties(999999), 49);
    assert.equal(blocksForProperties(2400), 2);
    assert.equal(blocksForProperties(2600), 3);
    assert.equal(blocksForProperties(Number.NaN), 1);
});

test('PACK-05 the card quotes the same price the server will charge', () => {
    for (const blocks of [1, 7, 20, 49]) {
        const pack = describeCreditPack(blocks * 1000, 1000);
        assert.equal(pack.blocks, blocks);
        assert.equal(pack.priceCents, creditPackPriceCents(blocks));
        assert.equal(pack.properties, creditPackProperties(blocks));
    }
});

test('PACK-06 the card tells the rep what their ceiling becomes', () => {
    const pack = describeCreditPack(5000, 1000);
    assert.equal(pack.propertiesLabel, '5,000');
    assert.equal(pack.priceLabel, '$245.00');
    assert.equal(pack.newLimit, 6000);
    // A missing or junk current limit must not produce NaN in the copy.
    assert.equal(describeCreditPack(1000, undefined).newLimit, 1000);
    assert.equal(describeCreditPack(1000, 'nope').newLimit, 1000);
});

test('PACK-07 slider bounds match what the server will accept', () => {
    assert.equal(normalizeCreditPackBlocks(blocksForProperties(MIN_CREDIT_PACK_PROPERTIES)), 1);
    assert.equal(normalizeCreditPackBlocks(blocksForProperties(MAX_CREDIT_PACK_PROPERTIES)), 49);
});

test('PACK-08 the pack intent is a distinct string the webhook can branch on', () => {
    // The webhook routes on this exact value; a rename here without one there
    // would silently drop credit grants on the floor.
    assert.equal(PRECISION_CREDIT_PACK_INTENT, 'precision_credit_pack');
});
