/**
 * Territory Management Configuration
 * All properties stay ELIGIBLE in master data - we track results in logs
 */
export const COOLDOWN_CONFIG = {
    STREET_COOLDOWN_DAYS: 30,      // Don't revisit a street for X days after no-answer
    PROPERTY_COOLDOWN_DAYS: 14,    // Individual property cooldown for no-answer
    CALLBACK_DEFAULT_DAYS: 30,     // Default callback period
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

    // If no interaction logs, property is ELIGIBLE (not visited yet)
    if (!logs || logs.length === 0) {
        return 'ELIGIBLE';
    }

    // Sort logs by timestamp desc
    const sortedLogs = [...logs].sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
    const latestLog = sortedLogs[0];

    // HARD_NO and SOLD are permanent exclusions from routing
    if (latestLog.parsed_status === 'HARD_NO' || latestLog.parsed_status === 'SOLD') {
        return latestLog.parsed_status;
    }

    // Check cooldown for NO_ANSWER
    if (latestLog.parsed_status === 'NO_ANSWER') {
        const cooldownDate = new Date(latestLog.next_eligible_date);
        if (cooldownDate && new Date() < cooldownDate) {
            return 'COOLDOWN'; // Still cooling down
        } else {
            return 'ELIGIBLE'; // Cooldown expired
        }
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
        new Date(b.created_date) - new Date(a.created_date)
    );

    const lastVisit = new Date(sortedLogs[0].created_date);
    const now = new Date();
    const daysSince = (now - lastVisit) / (1000 * 60 * 60 * 24);
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
export const filterByStreetCooldown = (properties, allLogs, cooldownDays = COOLDOWN_CONFIG.STREET_COOLDOWN_DAYS) => {
    // Build a map of street -> last no-answer date
    const streetLastNoAnswer = {};
    const streetCsvCooldowns = {};
    const now = new Date();

    properties.forEach(prop => {
        if (!prop.street_name) return;

        // Check CSV-based Street Cooldown
        if (prop.street_next_eligible_date) {
            const csvEligibleDate = new Date(prop.street_next_eligible_date);
            if (csvEligibleDate > now) {
                streetCsvCooldowns[prop.street_name] = csvEligibleDate;
            }
        }

        // Find logs for properties on this street
        const streetLogs = allLogs.filter(log => {
            const logProp = properties.find(p => p.address_hash === log.address_hash);
            // Fallback to matching logs by street name if prop link missing, or use linked prop
            if (logProp) return logProp.street_name === prop.street_name;
            return false;
        });

        const noAnswerLogs = streetLogs.filter(l => l.parsed_status === 'NO_ANSWER');
        if (noAnswerLogs.length > 0) {
            const sorted = noAnswerLogs.sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
            const existingDate = streetLastNoAnswer[prop.street_name];
            const newDate = new Date(sorted[0].created_date);
            if (!existingDate || newDate > existingDate) {
                streetLastNoAnswer[prop.street_name] = newDate;
            }
        }
    });

    const cooldownStreets = new Set();

    // Log-based cooldowns
    Object.entries(streetLastNoAnswer).forEach(([street, lastDate]) => {
        const daysSince = (now - lastDate) / (1000 * 60 * 60 * 24);
        if (daysSince < cooldownDays) {
            cooldownStreets.add(street);
        }
    });

    // CSV-based cooldowns
    Object.entries(streetCsvCooldowns).forEach(([street, eligibleDate]) => {
        cooldownStreets.add(street);
    });

    return {
        eligible: properties.filter(p => !cooldownStreets.has(p.street_name)),
        onCooldown: properties.filter(p => cooldownStreets.has(p.street_name)),
        cooldownStreets: Array.from(cooldownStreets),
        streetCooldownInfo: [
            ...Object.entries(streetLastNoAnswer).map(([street, date]) => {
                const daysSince = (now - date) / (1000 * 60 * 60 * 24);
                return {
                    street,
                    lastVisit: date,
                    daysRemaining: Math.max(0, Math.ceil(cooldownDays - daysSince)),
                    onCooldown: daysSince < cooldownDays,
                    source: 'LOGS'
                };
            }),
            ...Object.entries(streetCsvCooldowns).map(([street, date]) => {
                const daysRemaining = Math.max(0, Math.ceil((date - now) / (1000 * 60 * 60 * 24)));
                return {
                    street,
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

    // Get ALL properties on those streets (excluding HARD_NO and SOLD)
    const fullSweep = allProperties.filter(p =>
        p.street_name && targetStreets.has(p.street_name)
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

/**
 * Order properties for optimal street sweep walking pattern
 * Returns properties ordered: street by street, odd side then even side
 */
export const orderForStreetSweep = (properties) => {
    if (!properties || properties.length === 0) return [];

    // Group by street
    const streetGroups = {};
    properties.forEach(prop => {
        const street = prop.street_name || 'Unknown';
        if (!streetGroups[street]) streetGroups[street] = [];
        streetGroups[street].push(prop);
    });

    const orderedProperties = [];

    Object.entries(streetGroups).forEach(([streetName, streetProps]) => {
        // Sort by house number
        streetProps.sort((a, b) => (a.house_number || 0) - (b.house_number || 0));

        // Separate odd and even
        const odds = streetProps.filter(p => (p.house_number || 0) % 2 === 1);
        const evens = streetProps.filter(p => (p.house_number || 0) % 2 === 0);

        // Walk up odd side (ascending), then back down even side (descending)
        odds.forEach(p => orderedProperties.push({ ...p, _sweepSide: 'odd', _streetName: streetName }));
        evens.reverse().forEach(p => orderedProperties.push({ ...p, _sweepSide: 'even', _streetName: streetName }));
    });

    return orderedProperties;
};

/**
 * Get summary of results for a property (for display)
 * Returns the latest result text and status
 */
export const getPropertyResultSummary = (logs) => {
    if (!logs || logs.length === 0) {
        return { hasResult: false, latestResult: null, resultText: null, status: 'ELIGIBLE' };
    }

    const sortedLogs = [...logs].sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
    const latest = sortedLogs[0];

    return {
        hasResult: true,
        latestResult: latest,
        resultText: latest.raw_input_text,
        status: latest.parsed_status,
        date: latest.created_date
    };
};