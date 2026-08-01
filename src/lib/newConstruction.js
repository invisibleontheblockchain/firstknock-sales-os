/**
 * New-construction detection.
 *
 * A door is treated as a new build when the structure is a year old or newer AND
 * the record carries no prior ownership transfer. The transfer check matters:
 * a 2025 house that has already changed hands is a resale, not a new build, so
 * year alone would mislabel it.
 */

// Field aliases mirror the ones the property cards already resolve, so a record
// coming from Neon, a CSV import or BatchData is judged the same way.
const SALE_DATE_FIELDS = [
    'sold_date', 'soldDate', 'lastSoldDate', 'last_sold_date', 'saleDate', 'sale_date'
];
const SALE_PRICE_FIELDS = [
    'sale_price', 'last_sale_price', 'lastSoldPrice', 'last_sold_price', 'sale_amount', 'saleAmount'
];

export function getYearBuilt(property) {
    const year = Number(property?.year_built ?? property?.yearBuilt);
    return Number.isInteger(year) && year > 1700 ? year : null;
}

function hasOwnershipTransfer(property) {
    if (!property) return false;
    // Any recorded transfer date or price means the home has sold before.
    return SALE_DATE_FIELDS.some(field => Boolean(property[field]))
        || SALE_PRICE_FIELDS.some(field => Number(property[field]) > 0);
}

export function isNewConstruction(property, now = new Date()) {
    const yearBuilt = getYearBuilt(property);
    if (yearBuilt === null) return false;
    // Built this year or last year. Permits and assessor year-built values lag,
    // so a one-year window catches homes finished late in the prior year.
    if (yearBuilt < now.getFullYear() - 1) return false;
    return !hasOwnershipTransfer(property);
}