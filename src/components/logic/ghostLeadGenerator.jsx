export const generateGhostLeads = (properties) => {
    if (!properties || properties.length === 0) return [];

    // Group by street
    const streetGroups = properties.reduce((acc, prop) => {
        const street = prop.street_name;
        if (!acc[street]) acc[street] = [];
        acc[street].push(prop);
        return acc;
    }, {});

    const ghostProperties = [];

    Object.keys(streetGroups).forEach(street => {
        const props = streetGroups[street];
        // Sort by house number
        props.sort((a, b) => a.house_number - b.house_number);

        // Separate odd and even
        const odds = props.filter(p => p.house_number % 2 !== 0);
        const evens = props.filter(p => p.house_number % 2 === 0);

        const interpolate = (list) => {
            for (let i = 0; i < list.length - 1; i++) {
                const current = list[i];
                const next = list[i + 1];
                const diff = next.house_number - current.house_number;

                // If gap is typical (e.g., 10 to 14, missing 12)
                if (diff > 2 && diff < 20) {
                    for (let n = current.house_number + 2; n < next.house_number; n += 2) {
                        // Create Ghost Record
                        const ratio = (n - current.house_number) / diff;
                        const lat = current.lat + (next.lat - current.lat) * ratio;
                        const lng = current.lng + (next.lng - current.lng) * ratio;

                        ghostProperties.push({
                            id: `ghost_${street.replace(/\s/g, '')}_${n}`,
                            address_hash: `ghost_${street.replace(/\s/g, '')}_${n}`,
                            house_number: n,
                            street_name: street,
                            full_address: `${n} ${street} (Ghost)`,
                            lat: lat,
                            lng: lng,
                            original_status: 'GHOST', 
                            effective_status: 'ELIGIBLE', // Treat as eligible/unlisted
                            is_ghost: true
                        });
                    }
                }
            }
        };

        interpolate(odds);
        interpolate(evens);
    });

    return ghostProperties;
};