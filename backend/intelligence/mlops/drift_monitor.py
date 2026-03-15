"""
MLOps Drift Detection Module — Algorithm II Phase 3
====================================================
Monitors feature drift (PSI) and concept drift (ADWIN) to trigger model
retraining when the propensity scoring model degrades.

Strategy Doc §3.4 — Retraining Trigger Conditions (Table 9)
"""

import numpy as np
from dataclasses import dataclass, field
from typing import List, Dict, Optional, Tuple
from collections import deque
import logging

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Population Stability Index (PSI) — Feature Drift
# ---------------------------------------------------------------------------
# PSI = Σ (Actual% − Expected%) × ln(Actual% / Expected%)
# Thresholds: <0.10 safe │ 0.10-0.25 monitor │ >0.25 retrain
# ---------------------------------------------------------------------------

def _psi_bucket(expected: np.ndarray, actual: np.ndarray, n_buckets: int = 10) -> float:
    """Compute PSI between two 1-D distributions using quantile buckets."""
    eps = 1e-6

    # Use expected distribution to define quantile boundaries
    breakpoints = np.quantile(expected, np.linspace(0, 1, n_buckets + 1))
    breakpoints[0] = -np.inf
    breakpoints[-1] = np.inf

    expected_counts = np.histogram(expected, bins=breakpoints)[0] / len(expected)
    actual_counts = np.histogram(actual, bins=breakpoints)[0] / len(actual)

    # Clip to avoid log(0)
    expected_counts = np.clip(expected_counts, eps, None)
    actual_counts = np.clip(actual_counts, eps, None)

    psi = np.sum((actual_counts - expected_counts) * np.log(actual_counts / expected_counts))
    return float(psi)


def compute_feature_psi(
    reference_data: Dict[str, np.ndarray],
    current_data: Dict[str, np.ndarray],
    n_buckets: int = 10,
) -> Dict[str, float]:
    """
    Compute PSI for every feature in the reference vs current window.

    Parameters
    ----------
    reference_data : dict of {feature_name: np.ndarray}  — training-time distribution
    current_data   : dict of {feature_name: np.ndarray}  — latest inference window
    n_buckets      : number of quantile buckets (default 10)

    Returns
    -------
    dict of {feature_name: psi_value}
    """
    results: Dict[str, float] = {}
    for feat in reference_data:
        if feat not in current_data:
            continue
        results[feat] = _psi_bucket(reference_data[feat], current_data[feat], n_buckets)
    return results


# ---------------------------------------------------------------------------
# ADWIN — Concept Drift (Adaptive Windowing)
# ---------------------------------------------------------------------------
# Maintains a sliding window of conversion outcomes.  When the mean in the
# recent sub-window diverges > 2σ from the historical sub-window, an alert
# fires.
# ---------------------------------------------------------------------------

class ADWINDetector:
    """
    Lightweight ADWIN-style concept drift detector.

    Maintains two sub-windows (historical and recent).  When the difference
    in means exceeds a threshold derived from Hoeffding's bound, drift is
    flagged.
    """

    def __init__(self, delta: float = 0.002, max_window: int = 5000):
        """
        Parameters
        ----------
        delta : confidence parameter (lower = more conservative)
        max_window : maximum total window size
        """
        self.delta = delta
        self.max_window = max_window
        self._window: deque = deque(maxlen=max_window)
        self.drift_detected = False

    def update(self, value: float) -> bool:
        """
        Add one observation and return True if drift is detected.
        """
        self._window.append(value)
        self.drift_detected = False

        if len(self._window) < 30:
            return False

        # Try multiple split points — pick the one that maximises divergence
        n = len(self._window)
        arr = np.array(self._window)

        for split in range(max(10, n // 4), n - max(10, n // 4)):
            hist = arr[:split]
            recent = arr[split:]

            n0 = len(hist)
            n1 = len(recent)

            m = 1.0 / (1.0 / n0 + 1.0 / n1)
            epsilon = np.sqrt((1.0 / (2.0 * m)) * np.log(4.0 / self.delta))

            if abs(np.mean(hist) - np.mean(recent)) >= epsilon:
                # Shrink window to the recent portion
                self._window = deque(recent, maxlen=self.max_window)
                self.drift_detected = True
                return True

        return False

    def reset(self):
        self._window.clear()
        self.drift_detected = False


# ---------------------------------------------------------------------------
# Page-Hinkley — Secondary Sequential Drift Detector
# ---------------------------------------------------------------------------

class PageHinkleyDetector:
    """
    Page-Hinkley test for gradual concept drift.
    Fires when the cumulative deviation from the running mean exceeds a
    threshold lambda.
    """

    def __init__(self, threshold: float = 50.0, alpha: float = 0.005, min_samples: int = 30):
        self.threshold = threshold
        self.alpha = alpha  # tolerance for acceptable deviation
        self.min_samples = min_samples
        self._sum = 0.0
        self._count = 0
        self._running_mean = 0.0
        self._cumulative_sum = 0.0
        self._min_cumulative = 0.0
        self.drift_detected = False

    def update(self, value: float) -> bool:
        self._count += 1
        self._running_mean += (value - self._running_mean) / self._count
        self._cumulative_sum += (value - self._running_mean - self.alpha)

        if self._cumulative_sum < self._min_cumulative:
            self._min_cumulative = self._cumulative_sum

        self.drift_detected = False
        if self._count >= self.min_samples:
            if (self._cumulative_sum - self._min_cumulative) > self.threshold:
                self.drift_detected = True
                return True

        return False

    def reset(self):
        self._sum = 0.0
        self._count = 0
        self._running_mean = 0.0
        self._cumulative_sum = 0.0
        self._min_cumulative = 0.0
        self.drift_detected = False


# ---------------------------------------------------------------------------
# Drift Report — Aggregate Output
# ---------------------------------------------------------------------------

@dataclass
class DriftReport:
    """Aggregate drift report returned by the monitor."""
    feature_psi: Dict[str, float] = field(default_factory=dict)
    psi_alerts: List[str] = field(default_factory=list)       # features with PSI > 0.25
    psi_warnings: List[str] = field(default_factory=list)     # features with 0.10 < PSI < 0.25
    adwin_alert: bool = False
    page_hinkley_alert: bool = False
    recommended_action: str = "none"  # "none" | "monitor" | "retrain"

    def to_dict(self) -> dict:
        return {
            "feature_psi": self.feature_psi,
            "psi_alerts": self.psi_alerts,
            "psi_warnings": self.psi_warnings,
            "adwin_alert": self.adwin_alert,
            "page_hinkley_alert": self.page_hinkley_alert,
            "recommended_action": self.recommended_action,
        }


class DriftMonitor:
    """
    Stateful drift monitor that tracks PSI, ADWIN, and Page-Hinkley.
    """

    PSI_SAFE = 0.10
    PSI_RETRAIN = 0.25

    TOP_FEATURES = [
        "ownership_duration_months",
        "current_ltv_ratio",
        "zip_absorption_rate",
        "unrealized_gain_pct",
        "assessment_gap_ratio",
    ]

    def __init__(self):
        self.adwin = ADWINDetector()
        self.page_hinkley = PageHinkleyDetector()
        self._reference: Optional[Dict[str, np.ndarray]] = None

    def set_reference(self, reference_data: Dict[str, np.ndarray]):
        """Store the training-time feature distributions as reference."""
        self._reference = reference_data

    def log_conversion_outcome(self, outcome: float):
        """Feed a single conversion observation (0 or 1) to concept drift detectors."""
        self.adwin.update(outcome)
        self.page_hinkley.update(outcome)

    def evaluate(self, current_data: Dict[str, np.ndarray]) -> DriftReport:
        """Run all drift checks and return an aggregate report."""
        report = DriftReport()

        # --- PSI Feature Drift ---
        if self._reference:
            report.feature_psi = compute_feature_psi(self._reference, current_data)
            for feat, psi_val in report.feature_psi.items():
                if psi_val > self.PSI_RETRAIN:
                    report.psi_alerts.append(feat)
                elif psi_val > self.PSI_SAFE:
                    report.psi_warnings.append(feat)

        # --- ADWIN Concept Drift ---
        report.adwin_alert = self.adwin.drift_detected

        # --- Page-Hinkley Concept Drift ---
        report.page_hinkley_alert = self.page_hinkley.drift_detected

        # --- Decision ---
        if report.psi_alerts or report.adwin_alert:
            report.recommended_action = "retrain"
        elif report.psi_warnings or report.page_hinkley_alert:
            report.recommended_action = "monitor"
        else:
            report.recommended_action = "none"

        return report
