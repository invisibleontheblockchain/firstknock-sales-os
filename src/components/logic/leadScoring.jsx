/**
 * Lead Scoring Engine v2
 * Research-validated propensity scoring for door-to-door field sales.
 * All parameters from FirstKnock Optimization Research Report (March 2026).
 * 
 * Computes a 0–1 propensity score per property from four sub-scores:
 *   1. Ownership Duration Decay  (§1.1)
 *   2. Property Quality Index    (§1.2)
 *   3. Neighborhood Heat Score   (§1.3)
 *   4. Distress Composite Score  (§1.4)
 * Combined via sigmoid normalization (§1.5).
 */

import { latLngToCell, gridDisk } from 'h3-js';

// ─── §1.1 Ownership Duration Decay ───────────────────────────────────────
// Derived: 0.5 = e^(-6λ) → λ = ln(2)/6 ≈ 0.1155
const OWNERSHIP_LAMBDA = 0.1155;
const NEW_OWNER_SHIELD_YEARS = 1.5;
const NEW_OWNER_SHIELD_SCORE = 0.02;
const NULL_DATE_PRIOR = 0.3;

export function ownershipDurationScore(soldDate) {
    if (!soldDate) return NULL_DATE_PRIOR;
    const yearsOwned = (Date.now() - new Date(soldDate).getTime()) / (1000 * 60 * 60 * 24 * 365.25);
    if (yearsOwned < NEW_OWNER_SHIELD_YEARS) return NEW_OWNER_SHIELD_SCORE;
    return 1 - Math.exp(-OWNERSHIP_LAMBDA * yearsOwned);
}

// ─── §1.2 Property Quality Index (PQI) ──────────────────────────────────
// Weights by property type (Table 3)
const PQI_WEIGHTS = {
    sfr:   { price: 0.50, sqft: 0.30, lot: 0.20 },
    condo: { price: 0.60, sqft: 0.40, lot: 0.00 },
    multi: { price: 0.40, sqft: 0.20, lot: 0.40 },
};

function classifyPropertyType(typeStr) {
    if (!typeStr) return 'sfr';
    const t = typeStr.toLowerCase();
    if (t.includes('condo') || t.includes('town')) return 'condo';
    if (t.includes('multi')) return 'multi';
    return 'sfr';
}

/**
 * Compute PQI for a batch of properties.
 * Requires batch context to calculate percentiles for normalization.
 */
export function computePQIBatch(properties) {
    // Collect raw values for percentile calculation
    const prices = [];
    const sqfts = [];
    const lots = [];

    properties.forEach(p => {
        if (p.price > 0) prices.push(Math.log(p.price));
        if (p.sqft > 0) sqfts.push(p.sqft);
        if (p.lot_size > 0) lots.push(p.lot_size);
    });

    prices.sort((a, b) => a - b);
    sqfts.sort((a, b) => a - b);
    lots.sort((a, b) => a - b);

    // 99th percentile caps
    const priceCap = prices.length > 0 ? prices[Math.floor(prices.length * 0.99)] : 0;
    const sqftCap = sqfts.length > 0 ? sqfts[Math.floor(sqfts.length * 0.99)] : 0;
    const lotCap = lots.length > 0 ? lots[Math.floor(lots.length * 0.99)] : 0;

    const priceMin = prices.length > 0 ? prices[0] : 0;
    const sqftMin = sqfts.length > 0 ? sqfts[0] : 0;
    const lotMin = lots.length > 0 ? lots[0] : 0;

    const normalize = (val, min, cap) => {
        if (cap <= min) return 0.5; // all-same-value → neutral
        return Math.max(0, Math.min(1, (Math.min(val, cap) - min) / (cap - min)));
    };

    const result = new Map();

    properties.forEach(p => {
        const w = PQI_WEIGHTS[classifyPropertyType(p.property_type)];
        const normPrice = p.price > 0 ? normalize(Math.log(p.price), priceMin, priceCap) : 0.5;
        const normSqft = p.sqft > 0 ? normalize(p.sqft, sqftMin, sqftCap) : 0.5;
        const normLot = p.lot_size > 0 ? normalize(p.lot_size, lotMin, lotCap) : 0.5;

        const pqi = w.price * normPrice + w.sqft * normSqft + w.lot * normLot;
        result.set(p.address_hash || p.id, pqi);
    });

    return result;
}

// ─── §1.3 Neighborhood Heat Score ────────────────────────────────────────
const HEAT_DECAY_ALPHA = 0.005;  // per day, half-life ~138 days
const CONTAGION_BOOST = 1.16;
const CONTAGION_RADIUS_MILES = 0.10;
const CONTAGION_DURATION_DAYS = 365;

// Fast Haversine distance in miles
function distMiles(lat1, lng1, lat2, lng2) {
    const R = 3959;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Compute heat scores for all properties in a batch.
 * Uses H3 res-9 spatial index for efficiency.
 * Returns Map<address_hash, heatScore>.
 */
export function computeHeatBatch(properties) {
    const now = Date.now();
    const cutoffMs = CONTAGION_DURATION_DAYS * 24 * 60 * 60 * 1000;

    // Build spatial index of recent sales
    const salesByCell = {};
    properties.forEach(p => {
        if (!p.sold_date || !p.lat || !p.lng) return;
        const ageMs = now - new Date(p.sold_date).getTime();
        if (ageMs > cutoffMs || ageMs < 0) return;
        const daysSince = ageMs / (1000 * 60 * 60 * 24);
        try {
            const cell = latLngToCell(p.lat, p.lng, 9);
            if (!salesByCell[cell]) salesByCell[cell] = [];
            salesByCell[cell].push({ lat: p.lat, lng: p.lng, daysSince });
        } catch (e) {}
    });

    const result = new Map();

    properties.forEach(p => {
        if (!p.lat || !p.lng) { result.set(p.address_hash || p.id, 0); return; }

        let rawHeat = 0;
        let hasNearbyRecent = false;

        try {
            const cell = latLngToCell(p.lat, p.lng, 9);
            const disk = gridDisk(cell, 1); // cell + 6 neighbors

            disk.forEach(c => {
                const sales = salesByCell[c];
                if (!sales) return;
                sales.forEach(s => {
                    const decay = Math.exp(-HEAT_DECAY_ALPHA * s.daysSince);
                    rawHeat += decay;
                    if (s.daysSince <= CONTAGION_DURATION_DAYS) {
                        const d = distMiles(p.lat, p.lng, s.lat, s.lng);
                        if (d <= CONTAGION_RADIUS_MILES) hasNearbyRecent = true;
                    }
                });
            });
        } catch (e) {}

        let heat = 1 - Math.exp(-rawHeat);
        if (hasNearbyRecent) heat = Math.min(1, heat * CONTAGION_BOOST);
        result.set(p.address_hash || p.id, heat);
    });

    return result;
}

// ─── §1.4 Distress Composite Score ──────────────────────────────────────
const DISTRESS_OWNERSHIP_WEIGHT = 0.40;
const DISTRESS_AGE_WEIGHT = 0.35;
const DISTRESS_PRICE_WEIGHT = 0.25;

/**
 * Compute distress composite per property.
 * Requires h3MedianPrices: Map<h3Cell, medianPrice> for price deviation.
 */
export function distressCompositeScore(property, h3MedianPrices) {
    const ownerScore = ownershipDurationScore(property.sold_date);

    // Age score: min(1, (currentYear - year_built) / 50). Null → 0.5
    let ageScore = 0.5;
    if (property.year_built) {
        const age = new Date().getFullYear() - property.year_built;
        ageScore = Math.min(1, Math.max(0, age / 50));
    }

    // Price deviation: |sale_price - h3_median| / h3_median, capped at 1.0
    let priceDevScore = 0;
    if (property.price && property.lat && property.lng) {
        try {
            const cell = latLngToCell(property.lat, property.lng, 9);
            const median = h3MedianPrices?.get(cell);
            if (median && median > 0) {
                priceDevScore = Math.min(1, Math.abs(property.price - median) / median);
            }
        } catch (e) {}
    }

    return DISTRESS_OWNERSHIP_WEIGHT * ownerScore +
           DISTRESS_AGE_WEIGHT * ageScore +
           DISTRESS_PRICE_WEIGHT * priceDevScore;
}

// ─── §1.5 Master Propensity Score ───────────────────────────────────────
// Default cold-start weights (Table 6)
// Phase 3: These are overridden by Bayesian-learned feature_weights when available
const DEFAULT_WEIGHTS = {
    ownership: 0.35,
    pqi: 0.20,
    heat: 0.25,
    distress: 0.20,
};

// Sigmoid shifted: 0.5 → 0.5, 0.0 → ~0.12, 1.0 → ~0.88
function sigmoid(x) {
    return 1 / (1 + Math.exp(-6 * (x - 0.5)));
}

// Contact frequency penalty: exponential decay on repeated no-answers, capped at 0.5
const CONTACT_PENALTY_CAP = 0.5;

function contactPenalty(logs, addressHash, legacyHash) {
    if (!logs || logs.length === 0) return 0;
    const myLogs = logs.filter(l =>
        l.address_hash === addressHash || (legacyHash && l.address_hash === legacyHash)
    );
    const noAnswerCount = myLogs.filter(l => l.parsed_status === 'NO_ANSWER').length;
    if (noAnswerCount === 0) return 0;
    // Exponential: penalty grows with repeated no-answers
    return Math.min(CONTACT_PENALTY_CAP, 1 - Math.exp(-0.3 * noAnswerCount));
}

/**
 * Compute master propensity score for all properties.
 * This is the main entry point for the lead scoring engine.
 * 
 * Phase 3: Now consumes Beta-Binomial Bayesian weights from trainLeadPredictor v3.
 * Uses learned feature_weights for sub-score channels and posterior means
 * for feature-level adjustments.
 * 
 * @param {Array} properties - All properties to score
 * @param {Array} logs - InteractionLog records for contact penalty
 * @param {Object|null} learnedWeights - Bayesian-learned weights from trainLeadPredictor, or null for cold-start
 * @returns {Map<string, { propensity: number, subscores: Object }>}
 */
export function batchScoreProperties(properties, logs = [], learnedWeights = null) {
    if (properties.length === 0) return new Map();

    const weights = learnedWeights?.feature_weights || DEFAULT_WEIGHTS;

    // Phase 3: Extract Bayesian posterior boosts per feature (if available)
    const posteriors = learnedWeights?.posteriors || null;
    const priorMean = posteriors?._global?.mean || 0.10;

    // Step 1: PQI (batch — needs percentile context)
    const pqiMap = computePQIBatch(properties);

    // Step 2: Heat (batch — needs spatial index)
    const heatMap = computeHeatBatch(properties);

    // Step 3: H3 median prices for distress (build in single pass)
    const h3Prices = {};
    properties.forEach(p => {
        if (!p.price || !p.lat || !p.lng) return;
        try {
            const cell = latLngToCell(p.lat, p.lng, 9);
            if (!h3Prices[cell]) h3Prices[cell] = [];
            h3Prices[cell].push(p.price);
        } catch (e) {}
    });
    const h3MedianPrices = new Map();
    Object.entries(h3Prices).forEach(([cell, prices]) => {
        prices.sort((a, b) => a - b);
        h3MedianPrices.set(cell, prices[Math.floor(prices.length / 2)]);
    });

    // Step 4: Score each property
    const result = new Map();

    properties.forEach(p => {
        const hash = p.address_hash || p.id;

        // Terminal statuses get zero
        if (p.effective_status === 'HARD_NO' || p.effective_status === 'DO_NOT_KNOCK') {
            result.set(hash, { propensity: 0, subscores: {} });
            return;
        }

        const ownerScore = ownershipDurationScore(p.sold_date);
        const pqi = pqiMap.get(hash) || 0.5;
        const heat = heatMap.get(hash) || 0;
        const distress = distressCompositeScore(p, h3MedianPrices);

        // Weighted combination (channel weights from Bayesian training)
        const raw = weights.ownership * ownerScore +
                    weights.pqi * pqi +
                    weights.heat * heat +
                    weights.distress * distress;

        // Phase 3: Bayesian posterior feature boost
        // If we have learned posteriors, apply a small multiplicative boost
        // based on which features this property matches
        let bayesianBoost = 0;
        if (posteriors) {
            const currentYear = new Date().getFullYear();
            const yearsOwned = p.sold_date
                ? (Date.now() - new Date(p.sold_date).getTime()) / (1000 * 60 * 60 * 24 * 365)
                : null;

            // Each feature's posterior mean relative to global prior mean
            // contributes a small additive boost (capped to prevent runaway)
            if (p.year_built && (currentYear - p.year_built) > 10 && posteriors.age_gt_10) {
                bayesianBoost += Math.max(-0.05, Math.min(0.05, (posteriors.age_gt_10.mean - priorMean) * 0.5));
            }
            if (p.price > 300000 && posteriors.price_gt_300k) {
                bayesianBoost += Math.max(-0.05, Math.min(0.05, (posteriors.price_gt_300k.mean - priorMean) * 0.5));
            }
            if (p.property_type?.toLowerCase().includes('single') && posteriors.single_family) {
                bayesianBoost += Math.max(-0.05, Math.min(0.05, (posteriors.single_family.mean - priorMean) * 0.5));
            }
            if (yearsOwned !== null && yearsOwned <= 3 && posteriors.recent_sale) {
                bayesianBoost += Math.max(-0.05, Math.min(0.05, (posteriors.recent_sale.mean - priorMean) * 0.5));
            }
            if (p.price > 750000 && posteriors.high_value) {
                bayesianBoost += Math.max(-0.05, Math.min(0.05, (posteriors.high_value.mean - priorMean) * 0.5));
            }
            if (p.lot_size > 10890 && posteriors.large_lot) {
                bayesianBoost += Math.max(-0.05, Math.min(0.05, (posteriors.large_lot.mean - priorMean) * 0.5));
            }
        }

        // Contact penalty
        const penalty = contactPenalty(logs, hash, p.legacy_hash);

        // Sigmoid normalization (with Bayesian boost)
        const propensity = sigmoid(raw + bayesianBoost - penalty);

        result.set(hash, {
            propensity,
            subscores: {
                ownership: ownerScore,
                pqi,
                heat,
                distress,
                bayesianBoost,
                contactPenalty: penalty,
                raw: raw + bayesianBoost,
            },
        });
    });

    return result;
}

// ─── Exported constants for testing/validation ──────────────────────────
export const SCORING_CONSTANTS = {
    OWNERSHIP_LAMBDA,
    NEW_OWNER_SHIELD_YEARS,
    NEW_OWNER_SHIELD_SCORE,
    NULL_DATE_PRIOR,
    HEAT_DECAY_ALPHA,
    CONTAGION_BOOST,
    CONTAGION_RADIUS_MILES,
    CONTAGION_DURATION_DAYS,
    DISTRESS_OWNERSHIP_WEIGHT,
    DISTRESS_AGE_WEIGHT,
    DISTRESS_PRICE_WEIGHT,
    DEFAULT_WEIGHTS,
    CONTACT_PENALTY_CAP,
};