"""
HMM Market Regime Detection — Algorithm II Phase 3
===================================================
3-state Hidden Markov Model (hot / neutral / cold) for market regime
inference, with conditional weight adjustment rules and seasonal factors.

Strategy Doc §3.2 — Market Condition Sensitivity (Table 7)
"""

import numpy as np
import logging
from typing import Dict, List, Tuple, Optional
from dataclasses import dataclass
from enum import Enum

logger = logging.getLogger(__name__)

try:
    from hmmlearn.hmm import GaussianHMM
    HMM_AVAILABLE = True
except ImportError:
    HMM_AVAILABLE = False
    logger.warning("hmmlearn not installed — HMM regime detection will use rule-based fallback")


# ---------------------------------------------------------------------------
# Market Regimes
# ---------------------------------------------------------------------------

class MarketRegime(Enum):
    HOT = "hot"
    NEUTRAL = "neutral"
    COLD = "cold"
    TRANSITIONING = "transitioning"


# ---------------------------------------------------------------------------
# Conditional Weight Adjustments (Table 7)
# ---------------------------------------------------------------------------

WEIGHT_ADJUSTMENTS: Dict[MarketRegime, Dict[str, float]] = {
    MarketRegime.HOT: {
        "absorption_rate_delta": +0.20,
        "distress_signals": -0.15,
        "price_momentum_index": +0.25,
        "life_event_score": 0.0,
    },
    MarketRegime.NEUTRAL: {
        # Baseline — no adjustments
        "absorption_rate_delta": 0.0,
        "distress_signals": 0.0,
        "price_momentum_index": 0.0,
        "life_event_score": 0.0,
    },
    MarketRegime.COLD: {
        "absorption_rate_delta": 0.0,
        "distress_signals": +0.30,
        "price_momentum_index": -0.20,
        "life_event_score": +0.20,
    },
}

# ---------------------------------------------------------------------------
# Seasonal Adjustment Factors (§3.2)
# ---------------------------------------------------------------------------
# Monthly SAF values — peak in Apr-Jun (spring), trough in Dec-Jan.
# These are national medians; in production, override per-MSA.
# ---------------------------------------------------------------------------

DEFAULT_SAF: Dict[int, float] = {
    1: 0.70,   # January
    2: 0.80,   # February
    3: 1.00,   # March
    4: 1.25,   # April
    5: 1.35,   # May
    6: 1.40,   # June
    7: 1.30,   # July
    8: 1.20,   # August
    9: 1.05,   # September
    10: 0.95,  # October
    11: 0.80,  # November
    12: 0.65,  # December
}


# ---------------------------------------------------------------------------
# Rule-based fallback thresholds (Table 7)
# ---------------------------------------------------------------------------

REGIME_THRESHOLDS = {
    "hot": {
        "absorption_rate_min": 20.0,
        "median_dom_max": 21.0,
        "list_to_sale_ratio_min": 1.02,
    },
    "cold": {
        "absorption_rate_max": 15.0,
        "median_dom_min": 45.0,
        "list_to_sale_ratio_max": 0.97,
    },
}


@dataclass
class RegimeResult:
    """Result from regime detection."""
    regime: MarketRegime
    confidence: float                          # 0-1, from HMM posterior
    weight_adjustments: Dict[str, float]       # feature → adjustment multiplier
    seasonal_factor: float                     # SAF for current month
    state_probabilities: Dict[str, float]      # {hot: p, neutral: p, cold: p}

    def to_dict(self) -> dict:
        return {
            "regime": self.regime.value,
            "confidence": round(self.confidence, 4),
            "weight_adjustments": self.weight_adjustments,
            "seasonal_factor": round(self.seasonal_factor, 4),
            "state_probabilities": {k: round(v, 4) for k, v in self.state_probabilities.items()},
        }


class MarketRegimeDetector:
    """
    Detects market regime using a 3-state Gaussian HMM over observable
    market indicators, with rule-based fallback.
    """

    # HMM state → regime mapping (learned order may vary; we fix it in init)
    STATE_MAP = {0: MarketRegime.HOT, 1: MarketRegime.NEUTRAL, 2: MarketRegime.COLD}

    def __init__(self, n_states: int = 3, random_state: int = 42):
        self.n_states = n_states
        self.model: Optional[object] = None  # GaussianHMM or None
        self.is_trained = False

        if HMM_AVAILABLE:
            self.model = GaussianHMM(
                n_components=n_states,
                covariance_type="full",
                n_iter=200,
                random_state=random_state,
            )

    def fit(self, observations: np.ndarray):
        """
        Train the HMM on historical market observation sequences.

        Parameters
        ----------
        observations : np.ndarray of shape (T, 4)
            Columns: [absorption_rate, median_dom, list_to_sale_ratio, price_momentum_index]
        """
        if not HMM_AVAILABLE or self.model is None:
            logger.warning("HMM not available; skipping fit")
            return

        self.model.fit(observations)
        self.is_trained = True
        logger.info(f"HMM trained on {len(observations)} time steps")

        # Fix the state mapping by sorting means of absorption_rate (col 0) desc
        means = self.model.means_[:, 0]
        sorted_indices = np.argsort(-means)
        self.STATE_MAP = {
            sorted_indices[0]: MarketRegime.HOT,
            sorted_indices[1]: MarketRegime.NEUTRAL,
            sorted_indices[2]: MarketRegime.COLD,
        }

    def predict(
        self,
        observations: np.ndarray,
        current_month: int = 6,
    ) -> RegimeResult:
        """
        Predict the current market regime from a sequence of recent observations.

        Parameters
        ----------
        observations  : np.ndarray of shape (T, 4) — recent market window
        current_month : 1-12 for seasonal adjustment
        """
        saf = DEFAULT_SAF.get(current_month, 1.0)

        if self.is_trained and HMM_AVAILABLE and self.model is not None:
            return self._predict_hmm(observations, saf)
        else:
            return self._predict_rules(observations, saf)

    def _predict_hmm(self, observations: np.ndarray, saf: float) -> RegimeResult:
        """HMM-based prediction with Viterbi decoding."""
        # Viterbi to get the most likely current state
        _log_prob, state_sequence = self.model.decode(observations, algorithm="viterbi")
        current_state = state_sequence[-1]
        regime = self.STATE_MAP.get(current_state, MarketRegime.NEUTRAL)

        # Posterior probabilities for the last time step
        posteriors = self.model.predict_proba(observations)[-1]
        state_probs = {}
        for idx, r in self.STATE_MAP.items():
            state_probs[r.value] = float(posteriors[idx])

        confidence = float(posteriors[current_state])

        # Transitioning if no clear winner
        if confidence < 0.50:
            regime = MarketRegime.TRANSITIONING
            # Ensemble weights across regimes weighted by posterior
            adjustments = self._ensemble_weights(state_probs)
        else:
            adjustments = WEIGHT_ADJUSTMENTS.get(regime, WEIGHT_ADJUSTMENTS[MarketRegime.NEUTRAL]).copy()

        return RegimeResult(
            regime=regime,
            confidence=confidence,
            weight_adjustments=adjustments,
            seasonal_factor=saf,
            state_probabilities=state_probs,
        )

    def _predict_rules(self, observations: np.ndarray, saf: float) -> RegimeResult:
        """Rule-based fallback using Table 7 thresholds on the latest observation."""
        latest = observations[-1] if len(observations.shape) > 1 else observations
        absorption_rate = float(latest[0])
        median_dom = float(latest[1])
        list_to_sale = float(latest[2])

        hot = REGIME_THRESHOLDS["hot"]
        cold = REGIME_THRESHOLDS["cold"]

        if (absorption_rate > hot["absorption_rate_min"] and
                median_dom < hot["median_dom_max"] and
                list_to_sale > hot["list_to_sale_ratio_min"]):
            regime = MarketRegime.HOT
            confidence = 0.85
        elif (absorption_rate < cold["absorption_rate_max"] and
              median_dom > cold["median_dom_min"] and
              list_to_sale < cold["list_to_sale_ratio_max"]):
            regime = MarketRegime.COLD
            confidence = 0.85
        else:
            regime = MarketRegime.NEUTRAL
            confidence = 0.70

        adjustments = WEIGHT_ADJUSTMENTS.get(regime, WEIGHT_ADJUSTMENTS[MarketRegime.NEUTRAL]).copy()
        state_probs = {r.value: (confidence if r == regime else (1 - confidence) / 2)
                       for r in [MarketRegime.HOT, MarketRegime.NEUTRAL, MarketRegime.COLD]}

        return RegimeResult(
            regime=regime,
            confidence=confidence,
            weight_adjustments=adjustments,
            seasonal_factor=saf,
            state_probabilities=state_probs,
        )

    @staticmethod
    def _ensemble_weights(state_probs: Dict[str, float]) -> Dict[str, float]:
        """Blend weight adjustments across regimes proportional to posterior probabilities."""
        blended: Dict[str, float] = {}
        for regime in [MarketRegime.HOT, MarketRegime.NEUTRAL, MarketRegime.COLD]:
            prob = state_probs.get(regime.value, 0.0)
            adjustments = WEIGHT_ADJUSTMENTS[regime]
            for feat, adj in adjustments.items():
                blended[feat] = blended.get(feat, 0.0) + prob * adj
        return blended
