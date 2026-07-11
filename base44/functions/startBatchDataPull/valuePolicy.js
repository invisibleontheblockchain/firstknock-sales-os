export const DEFAULT_PRECISION_MIN_HOME_VALUE = 100000;

export function optionalPositiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

export function normalizePrecisionHomeValueRange(minimumValue, maximumValue) {
    const requestedMinimum = optionalPositiveNumber(minimumValue);
    const minimum = Math.max(
        DEFAULT_PRECISION_MIN_HOME_VALUE,
        requestedMinimum ?? DEFAULT_PRECISION_MIN_HOME_VALUE
    );
    const maximum = optionalPositiveNumber(maximumValue);

    return {
        minimum,
        maximum,
        valid: maximum === null || maximum >= minimum
    };
}

export function maxRecallSearchRecordCeiling(requestedProperties) {
    const requested = Math.min(Math.max(Math.trunc(Number(requestedProperties) || 1), 1), 1000);
    const maxReviewedPerSource = Math.min(5000, Math.max(100, requested * 50));
    const countProbeRecords = requested > 100 ? 2 : 0;
    return {
        dateSources: 2,
        maxReviewedPerSource,
        countProbeRecords,
        totalRecordCeiling: (maxReviewedPerSource * 2) + countProbeRecords
    };
}

export function priorRouteMayShareCurrentSaleEvent(routedDate, currentSaleWindowMinDate) {
    const routed = String(routedDate || '').slice(0, 10);
    const minimum = String(currentSaleWindowMinDate || '').slice(0, 10);
    return !minimum || !routed || routed >= minimum;
}
