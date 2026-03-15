"""
Tests for Algorithm II Phase 3 — HMM Market Regime Detection
"""

import numpy as np
from models.market_regime import (
    MarketRegimeDetector,
    MarketRegime,
    WEIGHT_ADJUSTMENTS,
    DEFAULT_SAF,
)


def test_rule_based_hot_market():
    """Rule-based fallback should identify a hot market correctly."""
    detector = MarketRegimeDetector()
    # Hot: absorption > 20, DOM < 21, list-to-sale > 1.02
    obs = np.array([[25.0, 15.0, 1.05, 5.0]])
    result = detector.predict(obs, current_month=5)
    assert result.regime == MarketRegime.HOT, f"Expected HOT, got {result.regime}"
    assert result.weight_adjustments["distress_signals"] < 0, "Distress should be dampened in hot market"


def test_rule_based_cold_market():
    """Rule-based fallback should identify a cold market correctly."""
    detector = MarketRegimeDetector()
    # Cold: absorption < 15, DOM > 45, list-to-sale < 0.97
    obs = np.array([[10.0, 60.0, 0.93, -3.0]])
    result = detector.predict(obs, current_month=12)
    assert result.regime == MarketRegime.COLD, f"Expected COLD, got {result.regime}"
    assert result.weight_adjustments["distress_signals"] > 0, "Distress should be boosted in cold market"


def test_rule_based_neutral_market():
    """Rule-based fallback should identify a neutral market."""
    detector = MarketRegimeDetector()
    obs = np.array([[18.0, 30.0, 1.00, 1.0]])
    result = detector.predict(obs, current_month=9)
    assert result.regime == MarketRegime.NEUTRAL, f"Expected NEUTRAL, got {result.regime}"


def test_seasonal_adjustment_factor():
    """SAF should peak in spring and trough in winter."""
    assert DEFAULT_SAF[5] > DEFAULT_SAF[1], "May SAF should exceed January"
    assert DEFAULT_SAF[6] > DEFAULT_SAF[12], "June SAF should exceed December"


def test_regime_result_to_dict():
    """RegimeResult.to_dict should return a serialisable dictionary."""
    detector = MarketRegimeDetector()
    obs = np.array([[18.0, 30.0, 1.00, 1.0]])
    result = detector.predict(obs)
    d = result.to_dict()
    assert "regime" in d
    assert "confidence" in d
    assert "seasonal_factor" in d
