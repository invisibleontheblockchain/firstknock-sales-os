// @ts-check

/**
 * Precision credit packs — a one-off purchase, priced and described here.
 *
 * A pack is not a plan change. The $99 subscription is what unlocks Precision
 * and it renews on its own terms; a pack is a single payment that tops up the
 * rollover balance and never appears on a renewal. Keeping the arithmetic in
 * one pure module means the price the rep is shown and the price sent to
 * Checkout are derived the same way, and can be tested without a browser.
 */

export const CREDIT_BLOCK_PROPERTIES = 1000;
export const CREDIT_BLOCK_PRICE_CENTS = 4900;
export const MIN_CREDIT_PACK_BLOCKS = 1;
export const MAX_CREDIT_PACK_BLOCKS = 49;

export const MIN_CREDIT_PACK_PROPERTIES = MIN_CREDIT_PACK_BLOCKS * CREDIT_BLOCK_PROPERTIES;
export const MAX_CREDIT_PACK_PROPERTIES = MAX_CREDIT_PACK_BLOCKS * CREDIT_BLOCK_PROPERTIES;

/**
 * Clamps a slider position to a whole number of purchasable blocks. The slider
 * steps in thousands, but a dragged value is still untrusted input.
 */
export function blocksForProperties(properties) {
  const blocks = Math.round(Number(properties) / CREDIT_BLOCK_PROPERTIES);
  if (!Number.isFinite(blocks)) return MIN_CREDIT_PACK_BLOCKS;
  return Math.min(MAX_CREDIT_PACK_BLOCKS, Math.max(MIN_CREDIT_PACK_BLOCKS, blocks));
}

export function creditPackPriceCents(blocks) {
  return blocksForProperties(blocks * CREDIT_BLOCK_PROPERTIES) * CREDIT_BLOCK_PRICE_CENTS;
}

/**
 * Everything the card needs to describe one pack, derived from the slider.
 * `properties` is what the rep is buying; `newLimit` answers the question they
 * actually have, which is what their ceiling becomes after the purchase.
 */
export function describeCreditPack(sliderProperties, currentLimit = 0) {
  const blocks = blocksForProperties(sliderProperties);
  const properties = blocks * CREDIT_BLOCK_PROPERTIES;
  const priceCents = blocks * CREDIT_BLOCK_PRICE_CENTS;
  return {
    blocks,
    properties,
    priceCents,
    priceLabel: `$${(priceCents / 100).toFixed(2)}`,
    propertiesLabel: properties.toLocaleString(),
    perThousandLabel: `$${(CREDIT_BLOCK_PRICE_CENTS / 100).toFixed(0)} per 1,000`,
    newLimit: Math.max(0, Math.floor(Number(currentLimit) || 0)) + properties
  };
}
