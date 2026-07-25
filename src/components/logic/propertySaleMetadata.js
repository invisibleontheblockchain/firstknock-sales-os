function objectValue(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value;
}

function parsedObject(value) {
    if (typeof value !== 'string') return objectValue(value);
    try {
        return objectValue(JSON.parse(value));
    } catch {
        return {};
    }
}

function firstValidDate(values) {
    for (const value of values) {
        if (value === null || value === undefined || value === '' || value === 0) continue;
        const date = value instanceof Date ? value : new Date(value);
        if (!Number.isNaN(date.getTime())) return value;
    }
    return null;
}

function positiveNumber(value) {
    if (typeof value === 'boolean' || value === null || value === undefined) return null;
    const normalized = typeof value === 'string'
        ? value.trim().replace(/[$,\s]/g, '')
        : value;
    if (normalized === '') return null;
    const number = Number(normalized);
    return Number.isFinite(number) && number > 0 ? number : null;
}

function firstPositiveNumber(values) {
    for (const value of values) {
        const number = positiveNumber(value);
        if (number !== null) return number;
    }
    return null;
}

function nestedSaleSources(source) {
    const property = objectValue(source);
    const sale = objectValue(property.sale);
    const lastSale = objectValue(property.lastSale);
    const saleLastSale = objectValue(sale.lastSale);
    const saleLastTransfer = objectValue(sale.lastTransfer);
    const transaction = objectValue(property.transaction);
    const deedSale = objectValue(objectValue(property.deed).sale);
    const intel = objectValue(property.intel);
    const listing = objectValue(property.listing);
    const valuation = objectValue(property.valuation);
    const assessment = objectValue(property.assessment);
    const assessor = objectValue(property.assessor);
    const tax = objectValue(property.tax);

    return {
        property,
        sale,
        lastSale,
        saleLastSale,
        saleLastTransfer,
        transaction,
        deedSale,
        intel,
        listing,
        valuation,
        assessment,
        assessor,
        tax,
    };
}

function dateCandidates(source) {
    const {
        property,
        sale,
        lastSale,
        saleLastSale,
        saleLastTransfer,
        transaction,
        deedSale,
        intel,
        listing,
    } = nestedSaleSources(source);

    return [
        property.sold_date,
        property.soldDate,
        property.sale_date,
        property.saleDate,
        property.last_sale_date,
        property.lastSaleDate,
        property.last_sold_date,
        property.lastSoldDate,
        intel.lastSoldDate,
        intel.lastSaleDate,
        intel.lastTransferDate,
        sale.lastSoldDate,
        sale.lastSaleDate,
        sale.saleDate,
        sale.soldDate,
        sale.recordingDate,
        sale.date,
        saleLastSale.lastSoldDate,
        saleLastSale.lastSaleDate,
        saleLastSale.saleDate,
        saleLastSale.recordingDate,
        saleLastSale.date,
        saleLastTransfer.lastTransferDate,
        saleLastTransfer.saleDate,
        saleLastTransfer.recordingDate,
        saleLastTransfer.date,
        lastSale.lastSoldDate,
        lastSale.lastSaleDate,
        lastSale.saleDate,
        lastSale.recordingDate,
        lastSale.date,
        transaction.lastSoldDate,
        transaction.lastSaleDate,
        transaction.saleDate,
        transaction.recordingDate,
        transaction.date,
        deedSale.lastSoldDate,
        deedSale.lastSaleDate,
        deedSale.saleDate,
        deedSale.recordingDate,
        deedSale.date,
        listing.soldDate,
        listing.saleDate,
    ];
}

function amountCandidates(source) {
    const {
        property,
        sale,
        lastSale,
        saleLastSale,
        saleLastTransfer,
        transaction,
        deedSale,
        intel,
        listing,
        valuation,
        assessment,
        assessor,
        tax,
    } = nestedSaleSources(source);

    return [
        property.price,
        property.estimated_value,
        property.estimatedValue,
        property.sale_price,
        property.salePrice,
        property.last_sale_price,
        property.lastSalePrice,
        property.last_sold_price,
        property.lastSoldPrice,
        property.sale_amount,
        property.saleAmount,
        property.assessed_value,
        property.assessedValue,
        property.market_value,
        property.marketValue,
        intel.estimatedValue,
        intel.estimatedMarketValue,
        intel.totalMarketValue,
        intel.propertyValue,
        intel.lastSoldPrice,
        intel.lastSalePrice,
        intel.lastTransferPrice,
        sale.amount,
        sale.price,
        sale.salePrice,
        sale.lastSoldPrice,
        sale.lastSalePrice,
        saleLastSale.amount,
        saleLastSale.price,
        saleLastSale.salePrice,
        saleLastTransfer.amount,
        saleLastTransfer.price,
        saleLastTransfer.salePrice,
        lastSale.amount,
        lastSale.price,
        lastSale.salePrice,
        lastSale.lastSoldPrice,
        lastSale.lastSalePrice,
        transaction.amount,
        transaction.price,
        transaction.salePrice,
        deedSale.amount,
        deedSale.price,
        deedSale.salePrice,
        valuation.estimatedValue,
        valuation.value,
        valuation.avm,
        valuation.avmValue,
        assessment.totalValue,
        assessment.marketValue,
        assessment.assessedValue,
        assessor.totalValue,
        assessor.marketValue,
        assessor.assessedValue,
        tax.totalValue,
        tax.marketValue,
        tax.assessedValue,
        listing.price,
        listing.listPrice,
    ];
}

/**
 * Resolve the two sale signals displayed on route cards without binding the UI
 * to one provider payload shape. Empty, zero, and invalid values are skipped so
 * a populated fallback can still win.
 */
export function resolvePropertySaleMetadata(property = {}) {
    const rawPayload = parsedObject(property?.raw_payload);
    const rawMetadata = parsedObject(property?.raw_metadata);
    return {
        soldDate: firstValidDate([
            ...dateCandidates(property),
            ...dateCandidates(rawPayload),
            ...dateCandidates(rawMetadata),
        ]),
        amount: firstPositiveNumber([
            ...amountCandidates(property),
            ...amountCandidates(rawPayload),
            ...amountCandidates(rawMetadata),
        ]),
    };
}
