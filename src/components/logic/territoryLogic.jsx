/**
 * Territory Management Configuration
 * All properties stay ELIGIBLE in master data - we track results in logs
 */
export const COOLDOWN_CONFIG = {
    STREET_COOLDOWN_DAYS: 30,      // Don't revisit a street for X days after no-answer
    PROPERTY_COOLDOWN_DAYS: 14,    // Individual property cooldown for no-answer
    CALLBACK_DEFAULT_DAYS: 30,     // Default callback period
};

const calendarDateKey = (value) => {
    if (!value) return null;
    if (typeof value === 'string') {
        const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})/);
        if (match) return match[1];
    }
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
};

/**
 * Earliest defensible boundary for the property's current ownership event.
 * An exact observed sale date is strongest. Lean BatchData Search rows instead
 * carry the accepted provider predicate's minimum date, which still proves an
 * interaction before that date belongs to an older ownership event.
 */
export const getCurrentSaleEventBoundary = (property) => {
    if (property?.provider_exact_sale_date_observed !== false) {
        const exactSaleDate = calendarDateKey(property?.sold_date);
        if (exactSaleDate) return exactSaleDate;
    }
    const recentSaleSources = Array.isArray(property?.provider_recent_sale_sources)
        ? property.provider_recent_sale_sources.filter(source => source === 'intel' || source === 'sale')
        : [];
    if (recentSaleSources.length === 0) return null;
    return calendarDateKey(property?.provider_recent_sale_min_date);
};

export const interactionPredatesCurrentSaleEvidence = (log, property) => {
    const saleBoundary = getCurrentSaleEventBoundary(property);
    const interactionDate = calendarDateKey(log?.created_date || log?.updated_date);
    return !!saleBoundary && !!interactionDate && interactionDate < saleBoundary;
};

/**
 * Determine the effective status of a property based on its logs
 * Master data stays ELIGIBLE - this determines routing/display priority
 */
export const determineEffectiveStatus = (masterProp, logs) => {
    // Check CSV Property Cooldown
    if (masterProp.next_eligible_date) {
        const nextEligible = new Date(masterProp.next_eligible_date);
        if (new Date() < nextEligible) {
            return 'COOLDOWN';
        }
    }

    // A provider-confirmed new ownership event reopens only interactions that
    // can be proven to predate it. Same-day or undated interactions remain in
    // force because their ordering cannot be established safely.
    const currentOwnershipLogs = Array.isArray(logs)
        ? logs.filter(log => !interactionPredatesCurrentSaleEvidence(log, masterProp))
        : [];

    // If no current-ownership interaction logs, check master status first
    if (currentOwnershipLogs.length === 0) {
        // Only exclude if it's a hard rejection. 'SOLD' in master data usually means MLS sold (Owner Occupied), 
        // which is a valid target, not "We sold it".
        if (['HARD_NO', 'DO_NOT_KNOCK'].includes(masterProp.original_status)) {
            return masterProp.original_status;
        }
        // UNVERIFIED = legacy CSV data not yet confirmed by RentCast — still routable
        if (masterProp.original_status === 'UNVERIFIED') {
            return 'UNVERIFIED';
        }
        return 'ELIGIBLE';
    }

    // Sort logs by timestamp desc
    const sortedLogs = [...currentOwnershipLogs].sort((a, b) => new Date(b.created_date).getTime() - new Date(a.created_date).getTime());
    const latestLog = sortedLogs[0];

    // HARD_NO and SOLD exclude the current ownership event; proven pre-sale
    // interactions were removed above before this latest-status decision.
    if (latestLog.parsed_status === 'HARD_NO' || latestLog.parsed_status === 'SOLD') {
        return latestLog.parsed_status;
    }

    // NO_ANSWER is still a completed knock decision for checklist/knock progress.
    // Re-adding it to Todo should happen only when the decision is cleared.
    if (latestLog.parsed_status === 'NO_ANSWER') {
        return 'NO_ANSWER';
    }

    // CALLBACK - check if callback date has passed
    if (latestLog.parsed_status === 'CALLBACK') {
        if (latestLog.next_eligible_date) {
            const callbackDate = new Date(latestLog.next_eligible_date);
            if (new Date() >= callbackDate) {
                return 'ELIGIBLE';
            }
        }
        return 'CALLBACK';
    }

    return latestLog.parsed_status;
};

/**
 * Check if a STREET is on cooldown based on recent no-answer visits
 * Returns { onCooldown: boolean, daysRemaining: number, lastVisit: Date }
 */
export const getStreetCooldownStatus = (streetName, streetLogs, cooldownDays = COOLDOWN_CONFIG.STREET_COOLDOWN_DAYS) => {
    if (!streetName || !streetLogs || streetLogs.length === 0) {
        return { onCooldown: false, daysRemaining: 0, lastVisit: null };
    }

    // Find most recent NO_ANSWER log on this street
    const noAnswerLogs = streetLogs.filter(log => log.parsed_status === 'NO_ANSWER');

    if (noAnswerLogs.length === 0) {
        return { onCooldown: false, daysRemaining: 0, lastVisit: null };
    }

    const sortedLogs = [...noAnswerLogs].sort((a, b) =>
        new Date(b.created_date).getTime() - new Date(a.created_date).getTime()
    );

    const lastVisit = new Date(sortedLogs[0].created_date);
    const now = new Date();
    const daysSince = (now.getTime() - lastVisit.getTime()) / (1000 * 60 * 60 * 24);
    const daysRemaining = Math.max(0, Math.ceil(cooldownDays - daysSince));

    return {
        onCooldown: daysSince < cooldownDays,
        daysRemaining,
        lastVisit
    };
};

/**
 * Filter properties by street cooldown status
 * Returns only properties on streets that are NOT on cooldown
 */
export const filterByStreetCooldown = (properties, allLogs, cooldownDays = COOLDOWN_CONFIG.STREET_COOLDOWN_DAYS, options = {}) => {
    const safeProperties = Array.isArray(properties) ? properties : [];
    const safeLogs = Array.isArray(allLogs) ? allLogs : [];
    const safeCooldownDays = Number(cooldownDays);
    const bypassHashes = options?.bypassHashes instanceof Set
        ? options.bypassHashes
        : new Set(Array.isArray(options?.bypassHashes) ? options.bypassHashes : []);

    // "Off" means off for both interaction-based and CSV-provided cooldowns.
    if (!Number.isFinite(safeCooldownDays) || safeCooldownDays <= 0) {
        return {
            eligible: [...safeProperties],
            onCooldown: [],
            eventBoundaryBypasses: [],
            cooldownStreets: [],
            streetCooldownInfo: []
        };
    }

    const normalizePart = (value) => String(value || '')
        .toUpperCase()
        .trim()
        .replace(/[^A-Z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ');
    const suffixAliases = {
        STREET: 'ST', AVENUE: 'AVE', BOULEVARD: 'BLVD', DRIVE: 'DR', ROAD: 'RD',
        LANE: 'LN', COURT: 'CT', PLACE: 'PL', CIRCLE: 'CIR', TRAIL: 'TRL',
        PARKWAY: 'PKWY', HIGHWAY: 'HWY'
    };
    const normalizeStreet = (value) => {
        const tokens = normalizePart(value).split(' ').filter(Boolean);
        if (tokens.length > 0 && suffixAliases[tokens[tokens.length - 1]]) {
            tokens[tokens.length - 1] = suffixAliases[tokens[tokens.length - 1]];
        }
        return tokens.join(' ');
    };
    const streetParts = (property) => [
        normalizeStreet(property?.street_name),
        normalizePart(property?.city),
        normalizePart(property?.state),
        String(property?.zip_code || property?.zip || '').trim().slice(0, 5)
    ];
    const streetKey = (property) => streetParts(property).join('|');
    const streetLabel = (property) => streetParts(property).filter(Boolean).join(', ');

    const propertyByHash = new Map();
    const labelByStreetKey = new Map();
    const streetLastNoAnswer = new Map();
    const streetCsvCooldowns = new Map();
    const now = new Date();

    safeProperties.forEach(prop => {
        if (!prop.street_name) return;
        const key = streetKey(prop);
        labelByStreetKey.set(key, streetLabel(prop));
        [prop.address_hash, prop.legacy_hash, prop.id]
            .filter(Boolean)
            .forEach(hash => propertyByHash.set(hash, prop));

        // Check CSV-based Street Cooldown
        if (prop.street_next_eligible_date) {
            const csvEligibleDate = new Date(prop.street_next_eligible_date);
            if (!Number.isNaN(csvEligibleDate.getTime()) && csvEligibleDate > now) {
                const existingDate = streetCsvCooldowns.get(key);
                if (!existingDate || csvEligibleDate > existingDate) streetCsvCooldowns.set(key, csvEligibleDate);
            }
        }
    });

    // Hash indexing makes this O(properties + logs), rather than repeatedly scanning
    // every property for every log and every street.
    safeLogs.forEach(log => {
        if (log?.parsed_status !== 'NO_ANSWER') return;
        const linkedProperty = propertyByHash.get(log.address_hash);
        if (!linkedProperty) return;
        const logDate = new Date(log.created_date);
        if (Number.isNaN(logDate.getTime())) return;
        const key = streetKey(linkedProperty);
        const existingDate = streetLastNoAnswer.get(key);
        if (!existingDate || logDate > existingDate) streetLastNoAnswer.set(key, logDate);
    });

    const cooldownStreets = new Set();
    const activeLogCooldownStreets = new Set();

    // Log-based cooldowns
    streetLastNoAnswer.forEach((lastDate, key) => {
        const daysSince = (now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSince < safeCooldownDays) {
            cooldownStreets.add(key);
            activeLogCooldownStreets.add(key);
        }
    });

    // CSV-based cooldowns
    streetCsvCooldowns.forEach((_eligibleDate, key) => cooldownStreets.add(key));

    const bypassesStreetCooldown = (property) => {
        const hash = property?.address_hash || property?.id;
        if (hash && bypassHashes.has(hash)) return true;
        return ['CALLBACK', 'QUALIFIED'].includes(String(property?.effective_status || '').toUpperCase());
    };
    const logCooldownPredatesSale = (property) => {
        const key = streetKey(property);
        const lastNoAnswer = activeLogCooldownStreets.has(key) ? streetLastNoAnswer.get(key) : null;
        const saleBoundary = getCurrentSaleEventBoundary(property);
        const logDate = calendarDateKey(lastNoAnswer);
        return !!saleBoundary && !!logDate && logDate < saleBoundary;
    };
    const isOnCooldown = (property) => {
        if (bypassesStreetCooldown(property)) return false;
        const key = streetKey(property);
        const csvCooldownApplies = streetCsvCooldowns.has(key);
        const logCooldownApplies = activeLogCooldownStreets.has(key) && !logCooldownPredatesSale(property);
        return csvCooldownApplies || logCooldownApplies;
    };
    const eventBoundaryBypasses = safeProperties.filter(property => {
        if (bypassesStreetCooldown(property)) return false;
        const key = streetKey(property);
        return activeLogCooldownStreets.has(key)
            && !streetCsvCooldowns.has(key)
            && logCooldownPredatesSale(property);
    });

    return {
        eligible: safeProperties.filter(p => !isOnCooldown(p)),
        onCooldown: safeProperties.filter(isOnCooldown),
        eventBoundaryBypasses,
        cooldownStreets: Array.from(cooldownStreets).map(key => labelByStreetKey.get(key) || key),
        streetCooldownInfo: [
            ...Array.from(streetLastNoAnswer.entries()).map(([key, date]) => {
                const daysSince = (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24);
                return {
                    street: labelByStreetKey.get(key) || key,
                    streetKey: key,
                    lastVisit: date,
                    daysRemaining: Math.max(0, Math.ceil(safeCooldownDays - daysSince)),
                    onCooldown: daysSince < safeCooldownDays,
                    source: 'LOGS'
                };
            }),
            ...Array.from(streetCsvCooldowns.entries()).map(([key, date]) => {
                const daysRemaining = Math.max(0, Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
                return {
                    street: labelByStreetKey.get(key) || key,
                    streetKey: key,
                    lastVisit: null,
                    daysRemaining: daysRemaining,
                    onCooldown: true,
                    source: 'CSV_DATA'
                };
            })
        ]
    };
};

/**
 * STREET SWEEP: Get all properties on the same streets as the input properties
 * When you visit a street, you hit EVERY house on that street
 */
export const expandToFullStreetSweep = (selectedProperties, allProperties) => {
    if (!selectedProperties || selectedProperties.length === 0) return [];

    // Get unique street names from selected properties
    const targetStreets = new Set(
        selectedProperties
            .map(p => p.street_name)
            .filter(Boolean)
    );

    // Get ALL properties on those streets (excluding HARD_NO and DO_NOT_KNOCK)
    const fullSweep = allProperties.filter(p =>
        p.street_name && targetStreets.has(p.street_name) &&
        !['HARD_NO', 'DO_NOT_KNOCK'].includes(p.original_status)
    );

    return fullSweep;
};

/**
 * Generate a sweep route for properties
 * STREET SWEEP MODE: When visiting a street, include ALL houses on that street
 */
export const generateSweepRoute = (properties) => {
    // Group by street
    const streetGroups = properties.reduce((acc, prop) => {
        const street = prop.street_name;
        if (!acc[street]) acc[street] = [];
        acc[street].push(prop);
        return acc;
    }, {});

    let routePoints = [];

    const streets = Object.keys(streetGroups).sort();

    streets.forEach(street => {
        const props = streetGroups[street];
        // Sort by house number
        props.sort((a, b) => a.house_number - b.house_number);

        // Separate odd and even
        const odds = props.filter(p => p.house_number % 2 !== 0);
        const evens = props.filter(p => p.house_number % 2 === 0);

        // Sweep Logic: Up one side (Odds Ascending), Down other side (Evens Descending)
        const sortedOdds = odds.sort((a, b) => a.house_number - b.house_number);
        const sortedEvens = evens.sort((a, b) => b.house_number - a.house_number);

        const sweep = [...sortedOdds, ...sortedEvens];

        const points = sweep.map(p => [p.lat, p.lng]);
        routePoints = [...routePoints, ...points];
    });

    return routePoints;
};

const normalizeStreet = (name) => {
    if (!name) return 'Unknown';
    let s = String(name).toLowerCase().trim();
    // Strip common trailing street suffixes
    s = s.replace(/\b(dr|drive|st|street|ln|lane|rd|road|ave|avenue|ct|court|blvd|boulevard|ci|circle|way|pl|place|sq|square|tr|trail|pkwy|parkway)\.?$/i, '').trim();
    // Strip standalone directionals at start or end
    s = s.replace(/^(n|s|e|w|north|south|east|west)\b\s*/i, '');
    s = s.replace(/\s*\b(n|s|e|w|north|south|east|west)$/i, '');
    return s.replace(/[^a-z0-9]/g, '') || 'Unknown'; // remove all punctuation/spaces for robust grouping
};

const extractHouseNum = (str) => {
    if (!str) return 0;
    const match = String(str).match(/\d+/);
    return match ? parseInt(match[0], 10) : 0;
};

/**
 * Order properties for optimal street sweep walking pattern
 * Returns properties ordered: street by street, odd side then even side
 */
export const orderForStreetSweep = (properties) => {
    if (!properties || properties.length === 0) return [];

    // Group by street
    const streetGroups = {};
    let unknownCounter = 0;

    properties.forEach(prop => {
        let street = normalizeStreet(prop.street_name);
        
        // If we still don't know the street, isolate it so it doesn't zigzag across the map with other unknowns
        if (street === 'Unknown') {
            street = `Unknown_${unknownCounter++}`;
        }
        
        if (!streetGroups[street]) streetGroups[street] = [];
        streetGroups[street].push(prop);
    });

    const orderedProperties = [];

    // 1. Calculate Street Centroids for sorting
    const streetCentroids = Object.entries(streetGroups).map(([name, props]) => {
        const avgLat = props.reduce((sum, p) => sum + (p.lat||0), 0) / props.length;
        const avgLng = props.reduce((sum, p) => sum + (p.lng||0), 0) / props.length;
        return { name, lat: avgLat, lng: avgLng, props };
    });

    // 2. Sort Streets by Nearest Neighbor (to prevent jumping across map)
    const sortedStreets = [];
    if (streetCentroids.length > 0) {
        // Find the street of the first property provided (serves as the anchor)
        const anchorName = normalizeStreet(properties[0].street_name);
        let currentIdx = streetCentroids.findIndex(s => s.name === anchorName);
        if (currentIdx === -1) currentIdx = 0;

        const unvisited = [...streetCentroids];
        let current = unvisited.splice(currentIdx, 1)[0];
        sortedStreets.push(current);

        while (unvisited.length > 0) {
            let nearestIdx = -1;
            let minDist = Infinity;
            unvisited.forEach((s, i) => {
                const dSq = Math.pow(s.lat - current.lat, 2) + Math.pow(s.lng - current.lng, 2);
                if (dSq < minDist) {
                    minDist = dSq;
                    nearestIdx = i;
                }
            });
            current = unvisited.splice(nearestIdx, 1)[0];
            sortedStreets.push(current);
        }

        // 2b. Apply 2-Opt on the street centroid sequence to eliminate remaining crossovers
        // This is cheap — runs on ~10-30 street centroids, not thousands of houses
        let improved = true;
        let iterations = 0;
        const maxIter = 50;
        const distSq = (a, b) => Math.pow(a.lat - b.lat, 2) + Math.pow(a.lng - b.lng, 2);

        while (improved && iterations < maxIter) {
            improved = false;
            iterations++;
            for (let i = 0; i < sortedStreets.length - 2; i++) {
                for (let j = i + 2; j < sortedStreets.length - 1; j++) {
                    const a = sortedStreets[i], b = sortedStreets[i + 1];
                    const c = sortedStreets[j], d = sortedStreets[j + 1];
                    const currentDist = distSq(a, b) + distSq(c, d);
                    const newDist = distSq(a, c) + distSq(b, d);
                    if (newDist < currentDist) {
                        // Reverse segment from i+1 to j
                        const segment = sortedStreets.slice(i + 1, j + 1).reverse();
                        sortedStreets.splice(i + 1, segment.length, ...segment);
                        improved = true;
                    }
                }
            }
        }
    }

    // 3. Process each street in order
    sortedStreets.forEach(streetObj => {
        const streetProps = streetObj.props;
        const originalName = streetProps[0]?.street_name || 'Unknown';
        
        // Sort by robust integer house number
        streetProps.sort((a, b) => extractHouseNum(a.house_number) - extractHouseNum(b.house_number));

        // Separate odd and even using robust integer extract
        const odds = streetProps.filter(p => extractHouseNum(p.house_number) % 2 !== 0);
        const evens = streetProps.filter(p => extractHouseNum(p.house_number) % 2 === 0);

        // Walk up odd side (ascending), then back down even side (descending)
        // This creates a U-shape loop for the street block
        odds.forEach(p => orderedProperties.push({ ...p, _sweepSide: 'odd', _streetName: originalName, _normalizedStreet: streetObj.name }));
        evens.reverse().forEach(p => orderedProperties.push({ ...p, _sweepSide: 'even', _streetName: originalName, _normalizedStreet: streetObj.name }));
    });

    return orderedProperties;
};

/**
 * Get summary of results for a property (for display)
 * Returns the latest result text and status
 */
export const isPointInPolygon = (point, vs) => {
    if (!vs || vs.length < 3) return true;
    const x = Number(point?.lng), y = Number(point?.lat);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const boundaryToleranceDegrees = 5e-6;
    let inside = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
        const xi = Number(vs[i].lng), yi = Number(vs[i].lat);
        const xj = Number(vs[j].lng), yj = Number(vs[j].lat);
        if (![xi, yi, xj, yj].every(Number.isFinite)) continue;
        const dx = xj - xi;
        const dy = yj - yi;
        const lengthSquared = (dx * dx) + (dy * dy);
        if (lengthSquared > 0) {
            const projection = Math.max(0, Math.min(1, (((x - xi) * dx) + ((y - yi) * dy)) / lengthSquared));
            const projectedLng = xi + (projection * dx);
            const projectedLat = yi + (projection * dy);
            if (Math.hypot(x - projectedLng, y - projectedLat) <= boundaryToleranceDegrees) return true;
        }
        const intersect = ((yi > y) !== (yj > y))
            && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
};

export const getPropertyResultSummary = (logs) => {
    if (!logs || logs.length === 0) {
        return { hasResult: false, latestResult: null, resultText: null, status: 'ELIGIBLE' };
    }

    const sortedLogs = [...logs].sort((a, b) => new Date(b.created_date).getTime() - new Date(a.created_date).getTime());
    const latest = sortedLogs[0];

    return {
        hasResult: true,
        latestResult: latest,
        resultText: latest.raw_input_text,
        status: latest.parsed_status,
        date: latest.created_date
    };
};
