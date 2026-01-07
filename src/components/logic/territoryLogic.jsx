export const determineEffectiveStatus = (masterProp, logs) => {
    if (masterProp.original_status === 'SOLD') return 'SOLD';
    if (masterProp.original_status === 'HARD_NO') return 'HARD_NO';
    if (masterProp.original_status === 'GHOST') return 'ELIGIBLE'; // Default for ghosts
    
    if (!logs || logs.length === 0) return masterProp.original_status;
    
    // Sort logs by timestamp desc if not already
    const sortedLogs = [...logs].sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
    const latestLog = sortedLogs[0];
    
    // Check cooldown for NO_ANSWER
    if (latestLog.parsed_status === 'NO_ANSWER') {
         const cooldownDate = new Date(latestLog.next_eligible_date);
         if (new Date() < cooldownDate) {
             return 'NO_ANSWER'; // Still cooling down
         } else {
             return 'ELIGIBLE'; // Cooldown expired
         }
    }
    
    return latestLog.parsed_status;
};

export const generateSweepRoute = (properties) => {
    // Group by street
    const streetGroups = properties.reduce((acc, prop) => {
        const street = prop.street_name;
        if (!acc[street]) acc[street] = [];
        acc[street].push(prop);
        return acc;
    }, {});

    let routePoints = [];

    // Simple heuristic for street order: Alphabetical for now, or just Object.keys order
    // In a real router we'd optimize street-to-street transitions.
    const streets = Object.keys(streetGroups).sort();

    streets.forEach(street => {
        const props = streetGroups[street];
        // Sort by house number
        props.sort((a, b) => a.house_number - b.house_number);

        // Separate
        const odds = props.filter(p => p.house_number % 2 !== 0);
        const evens = props.filter(p => p.house_number % 2 === 0);

        // Sweep Logic: Up one side (Odds Ascending), Down other side (Evens Descending)
        // Adjust based on street direction? 
        // Standard Sweep: Odd Asc -> Even Desc
        // This loops back to start of street roughly.
        
        const sortedOdds = odds.sort((a, b) => a.house_number - b.house_number);
        const sortedEvens = evens.sort((a, b) => b.house_number - a.house_number); // Descending

        const sweep = [...sortedOdds, ...sortedEvens];
        
        // Extract lat/lng
        const points = sweep.map(p => [p.lat, p.lng]);
        routePoints = [...routePoints, ...points];
    });

    return routePoints;
};