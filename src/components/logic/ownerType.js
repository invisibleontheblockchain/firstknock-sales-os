const BUSINESS_OWNER_SUFFIX = /\b(?:L\.?\s*L\.?\s*C\.?|P\.?\s*L\.?\s*L\.?\s*C\.?|L\.?\s*L\.?\s*P\.?|L\.?\s*P\.?|P\.?\s*C\.?|INC(?:ORPORATED)?|CORP(?:ORATION)?|LTD|LIMITED|COMPANY)\b/i;

function optionalBoolean(value) {
    if (value === true || value === false) return value;
    if (value === 1 || value === '1') return true;
    if (value === 0 || value === '0') return false;

    const normalized = String(value ?? '').trim().toLowerCase();
    if (['true', 'yes', 'y'].includes(normalized)) return true;
    if (['false', 'no', 'n'].includes(normalized)) return false;
    return null;
}

export function getOwnerName(property) {
    return property?.owner_full_name
        || property?.owner_name
        || property?.ownerFullName
        || property?.owner?.fullName
        || property?.owner?.name
        || property?.owner?.ownerName
        || property?.owner?.names?.[0]?.full
        || property?.owner?.names?.[0]?.name
        || property?.owner?.names?.[0]
        || '';
}

export function looksLikeBusinessOwnerName(ownerName) {
    return BUSINESS_OWNER_SUFFIX.test(String(ownerName || '').replace(/[,;]+/g, ' '));
}

export function isBusinessOwnedProperty(property) {
    const explicitValues = [
        property?.corporate_owned,
        property?.corporateOwned,
        property?.quickLists?.corporateOwned,
        property?.quick_lists?.corporate_owned,
        property?.owner?.corporateOwned,
    ];

    if (explicitValues.some((value) => optionalBoolean(value) === true)) return true;

    // Provider coverage can be incomplete on older records. A constrained legal-
    // entity suffix fallback still catches obvious LLC/corporation owner names
    // without treating family trusts or ordinary surnames as businesses.
    if (looksLikeBusinessOwnerName(getOwnerName(property))) return true;

    return false;
}

export function filterBusinessOwnedProperties(properties, excludeBusinessOwned = false) {
    const list = Array.isArray(properties) ? properties : [];
    if (!excludeBusinessOwned) return list;
    return list.filter((property) => !isBusinessOwnedProperty(property));
}
