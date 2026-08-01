/**
 * New-construction detection.
 *
 * A door is treated as a new build when the structure was finished this calendar
 * year or last one. Sale history is deliberately NOT consulted: Precision pulls
 * are built from recently-sold homes, so almost every record carries a sale date
 * and price. Gating on that hid the badge on exactly the brand-new builds reps
 * care about. Year built is the signal the field actually uses.
 *
 * This is a derived display rule, so it applies to every route already in the
 * system as well as newly generated ones — nothing is stored per property.
 */

export function getYearBuilt(property) {
    const year = Number(property?.year_built ?? property?.yearBuilt);
    return Number.isInteger(year) && year > 1700 ? year : null;
}

export function isNewConstruction(property, now = new Date()) {
    const yearBuilt = getYearBuilt(property);
    if (yearBuilt === null) return false;
    // Built this year or last year. Permits and assessor year-built values lag,
    // so a one-year window catches homes finished late in the prior year.
    return yearBuilt >= now.getFullYear() - 1;
}