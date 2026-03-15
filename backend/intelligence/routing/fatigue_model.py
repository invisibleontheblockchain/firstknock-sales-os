"""
Biomathematical Fatigue Constraints — Algorithm II Phase 3
==========================================================
Tracks rep energy depletion E(t) over a shift, applies circadian rhythm
adjustments, and triggers mandatory breaks when fatigue reaches critical
levels.

Strategy Doc §5.5 — Rep Fatigue Modeling (Table 14)

Energy ODE:
    dE/dt = −α·walking_speed − β·temp_factor − γ·rejections + δ·break_recovery

Performance Degradation:
    rate_adjusted = rate_base × (1 − max(0, (Emax − E)/Emax)^1.5)
"""

import math
from dataclasses import dataclass, field
from typing import List, Optional, Dict, Tuple
from enum import Enum


# ---------------------------------------------------------------------------
# Constants (§5.5)
# ---------------------------------------------------------------------------

ALPHA = 0.02       # base depletion rate per minute of walking
BETA_COEFF = 0.005 # heat stress factor (/°C above 25)
GAMMA = 0.01       # psychological fatigue per consecutive rejection
DELTA = 0.15       # recovery rate per minute of break

E_MAX = 1.0        # normalised energy ceiling
E_CRITICAL = 0.30  # mandatory break threshold
ROUTE_REDUCTION = 0.20  # reduce remaining route by this fraction at critical

# ---------------------------------------------------------------------------
# Circadian Rhythm Adjustments (§5.5)
# ---------------------------------------------------------------------------
# Peak:  10:00-12:00, 15:00-17:00  → +10%
# Trough: 13:00-14:30              → −15%
# ---------------------------------------------------------------------------

def circadian_factor(hour: float) -> float:
    """
    Return a multiplicative adjustment to expected conversion rate based
    on time of day.

    Parameters
    ----------
    hour : float — current time as fractional 24-h clock (e.g. 13.5 = 1:30 PM)
    """
    if 10.0 <= hour < 12.0 or 15.0 <= hour < 17.0:
        return 1.10
    elif 13.0 <= hour < 14.5:
        return 0.85
    else:
        return 1.0


# ---------------------------------------------------------------------------
# Shift Structure Recommendation (Table 14)
# ---------------------------------------------------------------------------

class ShiftPeriod(Enum):
    MORNING = "hours_1_2"          # High-propensity, dense, 12-15 stops/hr
    MID_MORNING = "hours_3_4"      # Moderate, standard, 10-12 stops/hr
    LUNCH = "hour_4_5"             # 30-min break
    EARLY_AFTERNOON = "hours_5_6"  # High-propensity (second best), 10-12
    LATE_AFTERNOON = "hours_7_8"   # Medium-propensity, reduced pace, 8-10
    SHORT_BREAK = "hour_8_5"       # 10-min break if E < 40%
    END_OF_SHIFT = "hour_9"        # Nearest-to-depot high-propensity, 6-8


SHIFT_STOPS_PER_HOUR = {
    ShiftPeriod.MORNING: 13,
    ShiftPeriod.MID_MORNING: 11,
    ShiftPeriod.EARLY_AFTERNOON: 11,
    ShiftPeriod.LATE_AFTERNOON: 9,
    ShiftPeriod.END_OF_SHIFT: 7,
}


@dataclass
class FatigueState:
    """Snapshot of a rep's fatigue state at a point in time."""
    energy: float = E_MAX
    minutes_elapsed: float = 0.0
    consecutive_rejections: int = 0
    breaks_taken: int = 0
    mandatory_break_triggered: bool = False
    performance_factor: float = 1.0
    circadian_factor: float = 1.0

    def to_dict(self) -> dict:
        return {
            "energy": round(self.energy, 4),
            "minutes_elapsed": round(self.minutes_elapsed, 1),
            "consecutive_rejections": self.consecutive_rejections,
            "breaks_taken": self.breaks_taken,
            "mandatory_break_triggered": self.mandatory_break_triggered,
            "performance_factor": round(self.performance_factor, 4),
            "circadian_factor": round(self.circadian_factor, 4),
        }


class FatigueTracker:
    """
    Tracks cumulative fatigue state across a shift for a single rep.
    Call step() for each time interval to update the energy ODE.
    """

    def __init__(self, temperature_celsius: float = 22.0, shift_start_hour: float = 9.0):
        """
        Parameters
        ----------
        temperature_celsius : current environmental temperature
        shift_start_hour    : 24-h clock start time (default 9:00 AM)
        """
        self.temperature = temperature_celsius
        self.shift_start_hour = shift_start_hour
        self.state = FatigueState()
        self._temp_factor = BETA_COEFF * max(0.0, temperature_celsius - 25.0)

    def step(
        self,
        minutes: float,
        walking: bool = True,
        rejection: bool = False,
        is_break: bool = False,
    ) -> FatigueState:
        """
        Advance the fatigue ODE by `minutes`.

        Parameters
        ----------
        minutes   : duration of this step
        walking   : True if rep is walking between stops
        rejection : True if the stop was a rejection / no-answer
        is_break  : True if rep is on break (recovery)
        """
        dt = minutes

        # Energy delta components
        depletion = 0.0
        if walking:
            depletion += ALPHA * dt
        depletion += self._temp_factor * dt

        if rejection:
            self.state.consecutive_rejections += 1
            depletion += GAMMA * self.state.consecutive_rejections * dt
        else:
            self.state.consecutive_rejections = 0

        recovery = 0.0
        if is_break:
            recovery = DELTA * dt
            self.state.breaks_taken += 1

        # ODE step
        self.state.energy = max(0.0, min(E_MAX, self.state.energy - depletion + recovery))
        self.state.minutes_elapsed += minutes

        # Check mandatory break trigger
        if self.state.energy < E_CRITICAL * E_MAX and not is_break:
            self.state.mandatory_break_triggered = True

        # Performance degradation (cubic)
        fatigue_ratio = max(0.0, (E_MAX - self.state.energy) / E_MAX)
        self.state.performance_factor = 1.0 - fatigue_ratio ** 1.5

        # Circadian factor
        current_hour = self.shift_start_hour + (self.state.minutes_elapsed / 60.0)
        self.state.circadian_factor = circadian_factor(current_hour)

        return self.state

    def take_break(self, minutes: float = 30.0) -> FatigueState:
        """
        Simulate a break.  Resets the mandatory break flag.
        """
        self.state.mandatory_break_triggered = False
        return self.step(minutes=minutes, walking=False, is_break=True)

    def get_adjusted_conversion_rate(self, base_rate: float) -> float:
        """
        Return the fatigue- and circadian-adjusted conversion rate.
        """
        return base_rate * self.state.performance_factor * self.state.circadian_factor

    def recommend_stop_ordering(
        self,
        stops: List[Dict],
        propensity_key: str = "propensity_score",
    ) -> List[Dict]:
        """
        Re-order stops to front-load high-propensity properties during
        peak performance windows (morning / E > 80%).

        This is a simple heuristic:
        - First 40% of stops  → top propensity scores (morning peak)
        - Next 30% of stops   → medium scores
        - Last 30% of stops   → remaining scores (afternoon, higher fatigue)
        """
        if not stops:
            return stops

        sorted_stops = sorted(stops, key=lambda s: s.get(propensity_key, 0), reverse=True)

        n = len(sorted_stops)
        morning_cut = int(n * 0.40)
        mid_cut = int(n * 0.70)

        # Return in priority segments
        return sorted_stops[:morning_cut] + sorted_stops[morning_cut:mid_cut] + sorted_stops[mid_cut:]

    def should_reduce_route(self) -> Tuple[bool, float]:
        """
        Returns whether the remaining route should be reduced and by what fraction.
        """
        if self.state.mandatory_break_triggered:
            return True, ROUTE_REDUCTION
        return False, 0.0
