import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

/**
 * Phase 3: Beta-Binomial Bayesian Lead Predictor with ADWIN Drift Detection
 * 
 * Key upgrades over Phase 2:
 * 1. Beta-Binomial posteriors per feature (conjugate prior → closed-form update)
 * 2. Graduated outcome weights (not binary success/fail)
 * 3. ADWIN-inspired drift detection that shrinks the effective window when
 *    recent conversion patterns diverge from historical
 * 4. Outputs sub-score channel weights for the frontend propensity engine
 */

// ─── Graduated Outcome Weights ─────────────────────────────────────────
// Maps parsed_status → [0,1] pseudo-observation weight.
// SOLD/QUALIFIED are positive signals; CALLBACK is partial; NO_ANSWER is neutral;
// HARD_NO is actively negative (counts as β evidence).
const OUTCOME_WEIGHTS = {
    SOLD:       1.0,
    QUALIFIED:  0.8,
    CALLBACK:   0.4,
    NO_ANSWER:  0.0,  // neutral — doesn't update alpha OR beta
    HARD_NO:   -0.3,  // negative — adds to beta (failure evidence)
    ELIGIBLE:   0.0,
    OTHER:      0.0,
};

// ─── Beta Prior (weakly informative) ───────────────────────────────────
// α₀ = 2, β₀ = 18 → prior mean = 0.10 (10% base rate assumption)
const PRIOR_ALPHA = 2;
const PRIOR_BETA = 18;

// ─── ADWIN Drift Detection Parameters ─────────────────────────────────
// ADWIN (Adaptive Windowing): splits observation window into two halves,
// checks if their means diverge beyond ε_cut. If drift detected, we
// shrink the window to the more recent half.
const ADWIN_MIN_WINDOW = 30;      // Minimum observations before checking
const ADWIN_EPSILON_CUT = 0.15;   // Mean-difference threshold for drift
const ADWIN_CONFIDENCE = 0.95;    // Unused in simplified version, kept for reference

/**
 * Simplified ADWIN drift check.
 * Takes a time-ordered array of weighted observations and returns
 * the effective window (possibly trimmed if drift detected).
 */
function adwinTrimWindow(observations) {
    if (observations.length < ADWIN_MIN_WINDOW * 2) return observations;

    // Try splits from 30% to 70% of the window
    const n = observations.length;
    let bestSplitIdx = 0;
    let maxDivergence = 0;

    for (let splitPct = 0.3; splitPct <= 0.7; splitPct += 0.05) {
        const splitIdx = Math.floor(n * splitPct);
        const oldWindow = observations.slice(0, splitIdx);
        const newWindow = observations.slice(splitIdx);

        if (oldWindow.length < ADWIN_MIN_WINDOW || newWindow.length < ADWIN_MIN_WINDOW) continue;

        const oldMean = oldWindow.reduce((s, o) => s + o.weight, 0) / oldWindow.length;
        const newMean = newWindow.reduce((s, o) => s + o.weight, 0) / newWindow.length;
        const divergence = Math.abs(newMean - oldMean);

        if (divergence > maxDivergence) {
            maxDivergence = divergence;
            bestSplitIdx = splitIdx;
        }
    }

    // If max divergence exceeds threshold, trim to the newer half
    if (maxDivergence > ADWIN_EPSILON_CUT && bestSplitIdx > 0) {
        return observations.slice(bestSplitIdx);
    }

    return observations;
}

/**
 * Beta-Binomial posterior update with graduated weights.
 * Each observation contributes its weight to alpha (if positive)
 * or |weight| to beta (if negative). Neutral observations are skipped.
 */
function betaPosteriorUpdate(observations) {
    let alpha = PRIOR_ALPHA;
    let beta = PRIOR_BETA;

    observations.forEach(obs => {
        if (obs.weight > 0) {
            alpha += obs.weight;
        } else if (obs.weight < 0) {
            beta += Math.abs(obs.weight);
        }
        // weight === 0 → skip (neutral outcome like NO_ANSWER)
    });

    const mean = alpha / (alpha + beta);
    const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
    const credibleInterval95 = 1.96 * Math.sqrt(variance); // approx 95% CI half-width

    return { alpha, beta, mean, variance, credibleInterval95 };
}

// ─── Feature Extraction ────────────────────────────────────────────────
function extractFeatures(property) {
    const features = {};

    // Feature 1: Building age > 10 years
    if (property.year_built) {
        features.age_gt_10 = (new Date().getFullYear() - property.year_built) > 10;
    }

    // Feature 2: Price > $300k
    if (property.price) {
        features.price_gt_300k = property.price > 300000;
    }

    // Feature 3: Single family
    if (property.property_type) {
        features.single_family = property.property_type.toLowerCase().includes('single');
    }

    // Feature 4: Recent sale (within 3 years)
    if (property.sold_date) {
        const yearsOwned = (Date.now() - new Date(property.sold_date).getTime()) / (1000 * 60 * 60 * 24 * 365);
        features.recent_sale = yearsOwned <= 3;
    }

    // Feature 5: High value (>$750k) — new in v3
    if (property.price) {
        features.high_value = property.price > 750000;
    }

    // Feature 6: Large lot (>0.25 acre = 10890 sqft)
    if (property.lot_size) {
        features.large_lot = property.lot_size > 10890;
    }

    return features;
}

// ─── Sub-score Channel Weight Learning ─────────────────────────────────
// We learn optimal weights for the 4 propensity sub-scores
// (ownership, pqi, heat, distress) based on which features
// correlate with positive outcomes.
function learnChannelWeights(featurePosteriors) {
    // Map features to channels:
    // - recent_sale, age_gt_10 → ownership channel
    // - price_gt_300k, high_value, large_lot → pqi channel
    // - (heat is always 0.25 default, adjusted by overall success)
    // - single_family → distress channel (SFR tend to have clearer distress signals)

    const channelSignals = {
        ownership: [],
        pqi: [],
        heat: [],
        distress: [],
    };

    if (featurePosteriors.recent_sale) channelSignals.ownership.push(featurePosteriors.recent_sale.mean);
    if (featurePosteriors.age_gt_10) channelSignals.ownership.push(featurePosteriors.age_gt_10.mean);
    if (featurePosteriors.price_gt_300k) channelSignals.pqi.push(featurePosteriors.price_gt_300k.mean);
    if (featurePosteriors.high_value) channelSignals.pqi.push(featurePosteriors.high_value.mean);
    if (featurePosteriors.large_lot) channelSignals.pqi.push(featurePosteriors.large_lot.mean);
    if (featurePosteriors.single_family) channelSignals.distress.push(featurePosteriors.single_family.mean);

    // Calculate raw channel strengths (average posterior mean of related features)
    const rawWeights = {};
    const defaultWeights = { ownership: 0.35, pqi: 0.20, heat: 0.25, distress: 0.20 };

    Object.keys(defaultWeights).forEach(channel => {
        const signals = channelSignals[channel];
        if (signals.length > 0) {
            // Signal strength = average posterior mean, scaled relative to prior mean (0.10)
            const avgSignal = signals.reduce((s, v) => s + v, 0) / signals.length;
            rawWeights[channel] = defaultWeights[channel] * (1 + (avgSignal - 0.10) * 2);
        } else {
            rawWeights[channel] = defaultWeights[channel];
        }
    });

    // Normalize to sum to 1.0
    const total = Object.values(rawWeights).reduce((s, v) => s + v, 0);
    const normalized = {};
    Object.keys(rawWeights).forEach(k => {
        normalized[k] = Math.max(0.05, rawWeights[k] / total); // floor at 5%
    });

    // Re-normalize after floor
    const total2 = Object.values(normalized).reduce((s, v) => s + v, 0);
    Object.keys(normalized).forEach(k => {
        normalized[k] = parseFloat((normalized[k] / total2).toFixed(4));
    });

    return normalized;
}

// ─── Main Handler ──────────────────────────────────────────────────────
Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();

        if (!user) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        console.log('[trainLeadPredictor v3] Starting Bayesian training...');

        // Fetch data
        const [logs, properties] = await Promise.all([
            base44.asServiceRole.entities.InteractionLog.list('-created_date', 10000),
            base44.asServiceRole.entities.MasterProperty.list('-created_date', 10000),
        ]);

        console.log(`[trainLeadPredictor v3] Loaded ${logs.length} logs, ${properties.length} properties`);

        // Build property lookup
        const propMap = new Map();
        properties.forEach(p => propMap.set(p.address_hash || p.id, p));

        // ─── Step 1: Build time-ordered observations per feature ────────
        const featureObservations = {};
        const FEATURE_NAMES = ['age_gt_10', 'price_gt_300k', 'single_family', 'recent_sale', 'high_value', 'large_lot'];
        FEATURE_NAMES.forEach(f => { featureObservations[f] = []; });

        // Also track global observations for base rate
        const globalObservations = [];

        // Sort logs by created_date ascending (oldest first) for ADWIN time ordering
        const sortedLogs = [...logs].sort((a, b) =>
            new Date(a.created_date).getTime() - new Date(b.created_date).getTime()
        );

        let matchedLogs = 0;

        sortedLogs.forEach(log => {
            const prop = propMap.get(log.address_hash);
            if (!prop) return;

            const weight = OUTCOME_WEIGHTS[log.parsed_status] ?? 0;
            const timestamp = new Date(log.created_date).getTime();
            matchedLogs++;

            // Global observation
            globalObservations.push({ weight, timestamp });

            // Feature-specific observations
            const features = extractFeatures(prop);

            FEATURE_NAMES.forEach(fname => {
                if (features[fname] === true) {
                    featureObservations[fname].push({ weight, timestamp });
                }
            });
        });

        console.log(`[trainLeadPredictor v3] Matched ${matchedLogs} logs to properties`);

        // ─── Step 2: ADWIN drift detection + Beta posterior per feature ─
        const featurePosteriors = {};
        const driftReport = {};

        FEATURE_NAMES.forEach(fname => {
            const rawObs = featureObservations[fname];
            const trimmedObs = adwinTrimWindow(rawObs);
            const driftDetected = trimmedObs.length < rawObs.length;

            driftReport[fname] = {
                totalObs: rawObs.length,
                effectiveObs: trimmedObs.length,
                driftDetected,
                trimmedPct: rawObs.length > 0 ? parseFloat(((1 - trimmedObs.length / rawObs.length) * 100).toFixed(1)) : 0,
            };

            featurePosteriors[fname] = betaPosteriorUpdate(trimmedObs);

            console.log(`[trainLeadPredictor v3] ${fname}: α=${featurePosteriors[fname].alpha.toFixed(2)}, β=${featurePosteriors[fname].beta.toFixed(2)}, mean=${featurePosteriors[fname].mean.toFixed(4)}, drift=${driftDetected}`);
        });

        // Global posterior
        const globalTrimmed = adwinTrimWindow(globalObservations);
        const globalPosterior = betaPosteriorUpdate(globalTrimmed);

        driftReport._global = {
            totalObs: globalObservations.length,
            effectiveObs: globalTrimmed.length,
            driftDetected: globalTrimmed.length < globalObservations.length,
            trimmedPct: globalObservations.length > 0
                ? parseFloat(((1 - globalTrimmed.length / globalObservations.length) * 100).toFixed(1))
                : 0,
        };

        console.log(`[trainLeadPredictor v3] Global posterior: mean=${globalPosterior.mean.toFixed(4)}, CI95=±${globalPosterior.credibleInterval95.toFixed(4)}`);

        // ─── Step 3: Learn sub-score channel weights ────────────────────
        const featureWeights = learnChannelWeights(featurePosteriors);
        console.log(`[trainLeadPredictor v3] Channel weights:`, JSON.stringify(featureWeights));

        // ─── Step 4: Build backward-compatible weight object ────────────
        // The frontend leadScoring.js reads learnedWeights.feature_weights for channel weights
        // and individual feature weights for the legacy routeOptimizer scoreProperty()
        const weights = {
            // Bayesian posteriors per feature (full state for incremental updates)
            posteriors: {},
            // Simple multiplier weights for backward compat with scoreProperty()
            age_gt_10_weight: featurePosteriors.age_gt_10.mean / Math.max(globalPosterior.mean, 0.01),
            price_gt_300k_weight: featurePosteriors.price_gt_300k.mean / Math.max(globalPosterior.mean, 0.01),
            single_family_weight: featurePosteriors.single_family.mean / Math.max(globalPosterior.mean, 0.01),
            recent_sale_weight: featurePosteriors.recent_sale.mean / Math.max(globalPosterior.mean, 0.01),
            high_value_weight: featurePosteriors.high_value.mean / Math.max(globalPosterior.mean, 0.01),
            large_lot_weight: featurePosteriors.large_lot.mean / Math.max(globalPosterior.mean, 0.01),
            // Sub-score channel weights for batchScoreProperties()
            feature_weights: featureWeights,
            // Base conversion rate (Bayesian posterior mean)
            base_conversion_rate: globalPosterior.mean,
            // Graduated outcome weights (for reference/audit)
            outcome_weights: OUTCOME_WEIGHTS,
            // Model metadata
            model_version: 'bayesian_v3',
        };

        // Store full posteriors for future incremental training
        FEATURE_NAMES.forEach(fname => {
            weights.posteriors[fname] = {
                alpha: parseFloat(featurePosteriors[fname].alpha.toFixed(4)),
                beta: parseFloat(featurePosteriors[fname].beta.toFixed(4)),
                mean: parseFloat(featurePosteriors[fname].mean.toFixed(6)),
                ci95: parseFloat(featurePosteriors[fname].credibleInterval95.toFixed(6)),
            };
        });

        weights.posteriors._global = {
            alpha: parseFloat(globalPosterior.alpha.toFixed(4)),
            beta: parseFloat(globalPosterior.beta.toFixed(4)),
            mean: parseFloat(globalPosterior.mean.toFixed(6)),
            ci95: parseFloat(globalPosterior.credibleInterval95.toFixed(6)),
        };

        // ─── Step 5: Save to entity ─────────────────────────────────────
        const existingWeights = await base44.asServiceRole.entities.LeadScoringWeights.list();
        
        const trainingStats = {
            logsAnalyzed: matchedLogs,
            totalLogs: logs.length,
            totalProperties: properties.length,
            driftReport,
            globalDriftDetected: driftReport._global.driftDetected,
            effectiveWindowSize: globalTrimmed.length,
            featureCount: FEATURE_NAMES.length,
        };

        const saveData = {
            weights,
            last_trained: new Date().toISOString(),
            accuracy: globalPosterior.mean,
            model_version: 'bayesian_v3',
            training_stats: trainingStats,
        };

        if (existingWeights.length > 0) {
            await base44.asServiceRole.entities.LeadScoringWeights.update(existingWeights[0].id, saveData);
        } else {
            await base44.asServiceRole.entities.LeadScoringWeights.create(saveData);
        }

        console.log('[trainLeadPredictor v3] Training complete!');

        return Response.json({
            success: true,
            model_version: 'bayesian_v3',
            weights: {
                feature_weights: featureWeights,
                base_conversion_rate: globalPosterior.mean,
                posteriors: weights.posteriors,
            },
            training_stats: trainingStats,
        });

    } catch (error) {
        console.error('[trainLeadPredictor v3] Error:', error.message);
        return Response.json({ error: error.message }, { status: 500 });
    }
});