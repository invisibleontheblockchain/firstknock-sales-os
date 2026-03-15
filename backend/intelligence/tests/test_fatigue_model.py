"""
Tests for Algorithm II Phase 3 — Biomathematical Fatigue Constraints
"""

from routing.fatigue_model import (
    FatigueTracker,
    circadian_factor,
    E_MAX,
    E_CRITICAL,
)


def test_energy_depletes_over_time():
    """Energy should decrease when walking."""
    tracker = FatigueTracker(temperature_celsius=22.0)
    initial = tracker.state.energy

    # Walk for 60 minutes
    for _ in range(12):
        tracker.step(minutes=5, walking=True)

    assert tracker.state.energy < initial, "Energy should deplete during walking"
    assert tracker.state.energy >= 0, "Energy should not go negative"


def test_break_recovers_energy():
    """A break should increase energy."""
    tracker = FatigueTracker()
    # Deplete first
    for _ in range(20):
        tracker.step(minutes=5, walking=True)

    energy_before_break = tracker.state.energy
    tracker.take_break(minutes=30)

    assert tracker.state.energy > energy_before_break, "Break should recover energy"


def test_mandatory_break_triggers():
    """Mandatory break should trigger when energy drops below 30%."""
    tracker = FatigueTracker(temperature_celsius=35.0)  # Hot day = faster depletion
    triggered = False

    for _ in range(200):
        tracker.step(minutes=5, walking=True, rejection=True)
        if tracker.state.mandatory_break_triggered:
            triggered = True
            break

    assert triggered, "Mandatory break should trigger at low energy"


def test_circadian_peak():
    """Circadian factor should boost at peak hours (10-12, 15-17)."""
    assert circadian_factor(10.5) == 1.10
    assert circadian_factor(15.5) == 1.10


def test_circadian_trough():
    """Circadian factor should dampen at trough (13-14:30)."""
    assert circadian_factor(13.5) == 0.85


def test_circadian_normal():
    """Circadian factor should be 1.0 at non-peak/non-trough times."""
    assert circadian_factor(9.0) == 1.0
    assert circadian_factor(18.0) == 1.0


def test_performance_degradation():
    """Performance factor should decrease as energy depletes."""
    tracker = FatigueTracker()

    # Fresh — performance near 1.0
    assert tracker.state.performance_factor >= 0.99

    # Deplete
    for _ in range(40):
        tracker.step(minutes=5, walking=True)

    assert tracker.state.performance_factor < 1.0, "Performance should degrade with fatigue"


def test_stop_ordering():
    """High-propensity stops should be front-loaded."""
    tracker = FatigueTracker()
    stops = [
        {"id": "low", "propensity_score": 200},
        {"id": "high", "propensity_score": 900},
        {"id": "med", "propensity_score": 600},
    ]
    ordered = tracker.recommend_stop_ordering(stops)
    assert ordered[0]["id"] == "high", "Highest propensity should be first"
