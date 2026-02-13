// Eligibility scoring engine - computes a 0-100 score per property based on industry
// Factors: property age, value, size, lot size, interaction history, recency of sale

const INDUSTRY_WEIGHTS = {
    solar: {
        property_age: 0.15,    // Older homes = more likely need solar
        property_value: 0.20,  // Higher value = can afford
        sqft: 0.10,            // Bigger home = more energy usage
        lot_size: 0.20,        // Bigger lot = more roof/yard space
        interaction: 0.20,     // Positive interactions = warmer lead
        recency: 0.15,         // Recently sold = new homeowner open to upgrades
    },
    roofing: {
        property_age: 0.30,    // Old roof = needs replacement
        property_value: 0.15,
        sqft: 0.10,
        lot_size: 0.10,
        interaction: 0.20,
        recency: 0.15,
    },
    hvac: {
        property_age: 0.30,    // Old HVAC system
        property_value: 0.15,
        sqft: 0.15,            // Bigger home = more HVAC needs
        lot_size: 0.05,
        interaction: 0.20,
        recency: 0.15,
    },
    windows: {
        property_age: 0.35,
        property_value: 0.15,
        sqft: 0.10,
        lot_size: 0.05,
        interaction: 0.20,
        recency: 0.15,
    },
    pest_control: {
        property_age: 0.10,
        property_value: 0.10,
        sqft: 0.10,
        lot_size: 0.30,        // Bigger yard = more pests
        interaction: 0.25,
        recency: 0.15,
    },
    landscaping: {
        property_age: 0.05,
        property_value: 0.20,
        sqft: 0.05,
        lot_size: 0.35,
        interaction: 0.20,
        recency: 0.15,
    },
    security: {
        property_age: 0.10,
        property_value: 0.25,
        sqft: 0.15,
        lot_size: 0.10,
        interaction: 0.20,
        recency: 0.20,
    },
    insurance: {
        property_age: 0.15,
        property_value: 0.30,
        sqft: 0.15,
        lot_size: 0.05,
        interaction: 0.20,
        recency: 0.15,
    },
    telecom: {
        property_age: 0.05,
        property_value: 0.10,
        sqft: 0.10,
        lot_size: 0.05,
        interaction: 0.30,
        recency: 0.40,
    },
    other: {
        property_age: 0.15,
        property_value: 0.15,
        sqft: 0.10,
        lot_size: 0.10,
        interaction: 0.25,
        recency: 0.25,
    },
};

export function scoreProperty(property, interactions = [], industry = 'solar') {
    const weights = INDUSTRY_WEIGHTS[industry] || INDUSTRY_WEIGHTS.other;
    const currentYear = new Date().getFullYear();

    // Property age score (0-100): older = higher for most industries
    const age = property.year_built ? currentYear - property.year_built : 20;
    const ageScore = Math.min(100, (age / 50) * 100);

    // Property value score (0-100): higher value = higher score
    const price = property.price || 0;
    const valueScore = Math.min(100, (price / 500000) * 100);

    // Sqft score (0-100)
    const sqft = property.sqft || 0;
    const sqftScore = Math.min(100, (sqft / 3000) * 100);

    // Lot size score (0-100)
    const lot = property.lot_size || 0;
    const lotScore = Math.min(100, (lot / 20000) * 100);

    // Interaction score: CALLBACK/QUALIFIED = high, NO_ANSWER = medium, nothing = low
    let interactionScore = 20; // baseline
    if (interactions.length > 0) {
        const hasCallback = interactions.some(i => i.parsed_status === 'CALLBACK');
        const hasQualified = interactions.some(i => ['SOLD', 'QUALIFIED'].includes(i.parsed_status));
        const hasNoAnswer = interactions.some(i => i.parsed_status === 'NO_ANSWER');
        const hasHardNo = interactions.some(i => i.parsed_status === 'HARD_NO');

        if (hasHardNo) interactionScore = 0;
        else if (hasQualified) interactionScore = 95;
        else if (hasCallback) interactionScore = 85;
        else if (hasNoAnswer) interactionScore = 40;
        else interactionScore = 30;
    }

    // Recency score: recently sold = new homeowner = open to services
    let recencyScore = 30;
    if (property.sold_date) {
        const soldDate = new Date(property.sold_date);
        const monthsAgo = (Date.now() - soldDate.getTime()) / (1000 * 60 * 60 * 24 * 30);
        if (monthsAgo <= 6) recencyScore = 95;
        else if (monthsAgo <= 12) recencyScore = 80;
        else if (monthsAgo <= 24) recencyScore = 60;
        else if (monthsAgo <= 60) recencyScore = 40;
        else recencyScore = 20;
    }

    const totalScore = Math.round(
        ageScore * weights.property_age +
        valueScore * weights.property_value +
        sqftScore * weights.sqft +
        lotScore * weights.lot_size +
        interactionScore * weights.interaction +
        recencyScore * weights.recency
    );

    return {
        total: Math.min(100, Math.max(0, totalScore)),
        factors: {
            property_age: Math.round(ageScore),
            property_value: Math.round(valueScore),
            lot_size: Math.round(lotScore),
            interaction_history: Math.round(interactionScore),
            recency: Math.round(recencyScore),
        }
    };
}

export function getIndustryLabel(key) {
    const labels = {
        solar: 'Solar',
        roofing: 'Roofing',
        hvac: 'HVAC',
        windows: 'Windows & Doors',
        pest_control: 'Pest Control',
        landscaping: 'Landscaping',
        security: 'Home Security',
        insurance: 'Insurance',
        telecom: 'Telecom / Internet',
        other: 'Other',
    };
    return labels[key] || key;
}

export const INDUSTRIES = Object.keys(INDUSTRY_WEIGHTS);