"""
Tests for Algorithm II Phase 3 — A/B Testing (Thompson Sampling MAB)
"""

from models.ab_testing import ThompsonSamplingMAB, Arm, EVENT_WEIGHTS


def test_arm_prior():
    """Arms should initialise with Beta(3, 17) prior ≈ 15% conversion."""
    arm = Arm(arm_id="test", weight_config={}, alpha=3.0, beta=17.0)
    assert abs(arm.expected_rate - 0.15) < 0.01, f"Expected ~0.15, got {arm.expected_rate}"


def test_arm_sample_in_range():
    """Sampled value should be in [0, 1]."""
    arm = Arm(arm_id="test", weight_config={})
    for _ in range(100):
        s = arm.sample()
        assert 0.0 <= s <= 1.0


def test_mab_select_arm():
    """MAB should select one of the registered arms."""
    mab = ThompsonSamplingMAB()
    mab.add_arm("a", {"w1": 0.5, "w2": 0.5})
    mab.add_arm("b", {"w1": 0.3, "w2": 0.7})

    arm = mab.select_arm()
    assert arm.arm_id in ("a", "b")


def test_mab_log_outcome_updates_posterior():
    """Logging an appointment_set should increase alpha."""
    mab = ThompsonSamplingMAB()
    mab.add_arm("test_arm", {"w1": 0.5})

    alpha_before = mab.arms["test_arm"].alpha
    mab.log_outcome("test_arm", "appointment_set")
    alpha_after = mab.arms["test_arm"].alpha

    assert alpha_after == alpha_before + EVENT_WEIGHTS["appointment_set"]["alpha"]


def test_mab_log_rejection_updates_beta():
    """Logging a rejection should increase beta."""
    mab = ThompsonSamplingMAB()
    mab.add_arm("test_arm", {"w1": 0.5})

    beta_before = mab.arms["test_arm"].beta
    mab.log_outcome("test_arm", "rejected")
    beta_after = mab.arms["test_arm"].beta

    assert beta_after == beta_before + EVENT_WEIGHTS["rejected"]["beta"]


def test_dts_ipw_correction():
    """DTS should multiply updates by 1/P(selection)."""
    mab = ThompsonSamplingMAB()
    mab.add_arm("test_arm", {"w1": 0.5})

    alpha_before = mab.arms["test_arm"].alpha
    # selection_probability = 0.5 → IPW = 2.0 → alpha += 1.0 * 2.0 = 2.0
    mab.log_outcome("test_arm", "appointment_set", use_dts=True, selection_probability=0.5)
    alpha_after = mab.arms["test_arm"].alpha

    expected_delta = EVENT_WEIGHTS["appointment_set"]["alpha"] * (1.0 / 0.5)
    assert abs(alpha_after - alpha_before - expected_delta) < 0.001


def test_exploration_floor():
    """should_explore should return True when an arm is under-sampled."""
    mab = ThompsonSamplingMAB(min_exploration_pct=0.10)
    mab.add_arm("a", {})
    mab.add_arm("b", {})

    # Select arm a many times, never b
    for _ in range(20):
        mab.arms["a"].total_selections += 1

    assert mab.should_explore(), "Should explore since arm b has 0 selections"


def test_get_best_arm():
    """get_best_arm should return the arm with highest expected rate."""
    mab = ThompsonSamplingMAB()
    mab.add_arm("low", {}, prior_alpha=2, prior_beta=18)   # ~10%
    mab.add_arm("high", {}, prior_alpha=10, prior_beta=10) # ~50%

    best = mab.get_best_arm()
    assert best.arm_id == "high"
