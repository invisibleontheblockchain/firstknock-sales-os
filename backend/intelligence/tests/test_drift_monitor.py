"""
Tests for Algorithm II Phase 3 — Drift Monitoring
"""

import numpy as np
from mlops.drift_monitor import (
    compute_feature_psi,
    ADWINDetector,
    PageHinkleyDetector,
    DriftMonitor,
)


def test_psi_identical_distributions():
    """PSI of two identical distributions should be ≈ 0."""
    data = np.random.randn(1000)
    psi = compute_feature_psi({"feat1": data}, {"feat1": data})
    assert psi["feat1"] < 0.01, f"PSI should be near 0 for identical data, got {psi['feat1']}"


def test_psi_shifted_distribution():
    """PSI of a heavily shifted distribution should be > 0.25 (retrain threshold)."""
    ref = np.random.normal(0, 1, 1000)
    shifted = np.random.normal(3, 1, 1000)  # Mean shifted by 3 std devs
    psi = compute_feature_psi({"feat1": ref}, {"feat1": shifted})
    assert psi["feat1"] > 0.25, f"PSI should exceed 0.25 for shifted data, got {psi['feat1']}"


def test_adwin_no_drift():
    """ADWIN should NOT fire on stationary data."""
    detector = ADWINDetector(delta=0.002)
    for _ in range(200):
        detector.update(np.random.normal(0.15, 0.02))
    assert not detector.drift_detected, "ADWIN should not detect drift in stationary data"


def test_adwin_drift():
    """ADWIN should fire when the mean shifts abruptly."""
    detector = ADWINDetector(delta=0.01)  # slightly more sensitive for test
    # Phase 1: stable at 0.15
    for _ in range(200):
        detector.update(np.random.normal(0.15, 0.02))
    # Phase 2: jump to 0.50
    drift_found = False
    for _ in range(200):
        if detector.update(np.random.normal(0.50, 0.02)):
            drift_found = True
            break
    assert drift_found, "ADWIN should detect the mean shift from 0.15 to 0.50"


def test_page_hinkley_no_drift():
    """Page-Hinkley should NOT fire on stationary data."""
    detector = PageHinkleyDetector(threshold=50.0)
    for _ in range(200):
        detector.update(np.random.normal(0.15, 0.02))
    assert not detector.drift_detected


def test_drift_monitor_report():
    """DriftMonitor should produce a well-formed DriftReport."""
    monitor = DriftMonitor()

    ref = {"ownership_duration_months": np.random.normal(60, 10, 500)}
    monitor.set_reference(ref)

    current = {"ownership_duration_months": np.random.normal(60, 10, 500)}
    report = monitor.evaluate(current)

    assert report.recommended_action in ("none", "monitor", "retrain")
    assert "ownership_duration_months" in report.feature_psi
