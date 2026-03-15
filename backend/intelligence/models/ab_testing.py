"""
A/B Testing Framework — Algorithm II Phase 3
=============================================
Multi-arm Thompson Sampling for weight configuration selection, with
Deconfounded Thompson Sampling (DTS) for market shock correction.

Strategy Doc §3.1 — Bayesian Updating Framework
"""

import numpy as np
from dataclasses import dataclass, field
from typing import Dict, List, Optional
import logging

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Field Rep Feedback Event Weights (§3.1)
# ---------------------------------------------------------------------------

EVENT_WEIGHTS = {
    "knocked":          {"alpha": 0.0, "beta": 0.0},    # Impression only
    "answered":         {"alpha": 0.1, "beta": 0.0},    # Soft positive
    "interested":       {"alpha": 0.5, "beta": 0.0},    # Strong positive
    "appointment_set":  {"alpha": 1.0, "beta": 0.0},    # Full conversion
    "no_answer":        {"alpha": 0.0, "beta": 0.2},    # Soft negative
    "rejected":         {"alpha": 0.0, "beta": 0.5},    # Negative signal
}


@dataclass
class Arm:
    """A single arm in the Thompson Sampling MAB."""
    arm_id: str
    weight_config: Dict[str, float]
    alpha: float = 3.0   # Beta prior α (default: Beta(3, 17) ≈ 15% conversion)
    beta: float = 17.0   # Beta prior β
    total_selections: int = 0

    @property
    def expected_rate(self) -> float:
        """Posterior mean conversion rate."""
        return self.alpha / (self.alpha + self.beta)

    def sample(self) -> float:
        """Draw a sample from the Beta(α, β) posterior."""
        return float(np.random.beta(self.alpha, self.beta))

    def update(self, alpha_delta: float, beta_delta: float):
        """Bayesian update of the posterior."""
        self.alpha += alpha_delta
        self.beta += beta_delta

    def to_dict(self) -> dict:
        return {
            "arm_id": self.arm_id,
            "weight_config": self.weight_config,
            "alpha": round(self.alpha, 4),
            "beta": round(self.beta, 4),
            "expected_rate": round(self.expected_rate, 6),
            "total_selections": self.total_selections,
        }


class ThompsonSamplingMAB:
    """
    Multi-arm bandit using Thompson Sampling for weight configuration
    selection, with Deconfounded Thompson Sampling (DTS) support.
    """

    def __init__(self, min_exploration_pct: float = 0.10):
        """
        Parameters
        ----------
        min_exploration_pct : minimum fraction of routes dedicated to
                             exploration (default 10% per strategy doc)
        """
        self.arms: Dict[str, Arm] = {}
        self.min_exploration_pct = min_exploration_pct
        self._selection_history: List[dict] = []

    def add_arm(self, arm_id: str, weight_config: Dict[str, float],
                prior_alpha: float = 3.0, prior_beta: float = 17.0):
        """Register a new weight configuration arm."""
        self.arms[arm_id] = Arm(
            arm_id=arm_id,
            weight_config=weight_config,
            alpha=prior_alpha,
            beta=prior_beta,
        )

    def select_arm(self, force_exploration: bool = False) -> Arm:
        """
        Select an arm using Thompson Sampling.

        If force_exploration is True, select the least-sampled arm instead
        (used to meet the 10% exploration floor).
        """
        if not self.arms:
            raise ValueError("No arms registered")

        if force_exploration:
            # Pick the arm with fewest selections
            arm = min(self.arms.values(), key=lambda a: a.total_selections)
        else:
            # Thompson Sampling: sample from each arm's posterior, pick max
            best_arm = None
            best_sample = -1.0
            for arm in self.arms.values():
                s = arm.sample()
                if s > best_sample:
                    best_sample = s
                    best_arm = arm
            arm = best_arm

        arm.total_selections += 1

        self._selection_history.append({
            "arm_id": arm.arm_id,
            "selection_total": arm.total_selections,
        })

        return arm

    def log_outcome(
        self,
        arm_id: str,
        event_type: str,
        use_dts: bool = False,
        selection_probability: Optional[float] = None,
    ):
        """
        Log a field rep feedback event and update the arm's posterior.

        Parameters
        ----------
        arm_id   : which arm to update
        event_type : one of "knocked", "answered", "interested",
                     "appointment_set", "no_answer", "rejected"
        use_dts  : if True, apply Deconfounded Thompson Sampling IPW correction
        selection_probability : P(arm selected | context) — required if use_dts=True
        """
        if arm_id not in self.arms:
            logger.warning(f"Unknown arm: {arm_id}")
            return

        weights = EVENT_WEIGHTS.get(event_type)
        if weights is None:
            logger.warning(f"Unknown event type: {event_type}")
            return

        alpha_delta = weights["alpha"]
        beta_delta = weights["beta"]

        # Deconfounded Thompson Sampling IPW correction (§3.1)
        if use_dts and selection_probability and selection_probability > 0:
            ipw = 1.0 / selection_probability
            alpha_delta *= ipw
            beta_delta *= ipw

        self.arms[arm_id].update(alpha_delta, beta_delta)

    def should_explore(self) -> bool:
        """Check if we're below the exploration floor."""
        if not self._selection_history:
            return True

        total = sum(a.total_selections for a in self.arms.values())
        if total == 0:
            return True

        # Check if any arm is below minimum exploration budget
        min_expected = total * self.min_exploration_pct / len(self.arms)
        return any(a.total_selections < min_expected for a in self.arms.values())

    def get_status(self) -> Dict[str, dict]:
        """Return the current state of all arms."""
        return {arm_id: arm.to_dict() for arm_id, arm in self.arms.items()}

    def get_best_arm(self) -> Optional[Arm]:
        """Return the arm with the highest posterior mean."""
        if not self.arms:
            return None
        return max(self.arms.values(), key=lambda a: a.expected_rate)
