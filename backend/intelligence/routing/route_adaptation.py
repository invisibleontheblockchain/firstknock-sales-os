"""
RL-AVNS Route Adaptation — Algorithm II Phase 3
================================================
Dynamic re-optimization triggers and route delta computation for real-time
route adaptation as reps work in the field.

Strategy Doc §5.4 — Real-Time Route Adaptation

Triggers:
    1. Conversion event  → promote nearby (0.5 km) high-propensity properties
    2. No-answer cluster → 3 consecutive → skip + reroute to next best cluster
    3. Traffic event     → 2× estimated travel → incremental 2-Opt on remaining
    4. Early completion  → > 45 min remaining → append nearest unassigned cluster
"""

import math
import numpy as np
from typing import List, Dict, Any, Optional, Tuple
from dataclasses import dataclass
from enum import Enum
import logging

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PROMOTION_RADIUS_KM = 0.5          # §5.4: nearby radius for conversion promotion
NO_ANSWER_THRESHOLD = 3             # consecutive no-answers to trigger reroute
TRAFFIC_MULTIPLIER = 2.0            # travel time exceeds 2× estimate
EARLY_COMPLETION_MINUTES = 45       # remaining time to trigger cluster append
INCREMENTAL_RADIUS_KM = 1.0         # §5.4: 2-Opt neighborhood radius


class TriggerType(Enum):
    CONVERSION = "conversion"
    NO_ANSWER_CLUSTER = "no_answer_cluster"
    TRAFFIC = "traffic"
    EARLY_COMPLETION = "early_completion"


class DeltaType(Enum):
    INSERT = "insert"
    REMOVE = "remove"
    REORDER = "reorder"


@dataclass
class RouteDelta:
    """Change-set returned by the route adaptation engine."""
    delta_type: DeltaType
    affected_stops: List[Dict[str, Any]]
    new_sequence: List[Dict[str, Any]]
    estimated_time_delta_minutes: float
    new_total_distance_km: float

    def to_dict(self) -> dict:
        return {
            "delta_type": self.delta_type.value,
            "affected_stops": self.affected_stops,
            "new_sequence": [
                {"id": s.get("id"), "lat": s.get("lat"), "lng": s.get("lng"),
                 "propensity_score": s.get("propensity_score", 0)}
                for s in self.new_sequence
            ],
            "estimated_time_delta_minutes": round(self.estimated_time_delta_minutes, 1),
            "new_total_distance_km": round(self.new_total_distance_km, 3),
        }


# ---------------------------------------------------------------------------
# Distance helpers
# ---------------------------------------------------------------------------

def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Haversine distance in kilometres between two lat/lng pairs (degrees)."""
    R = 6371.0
    lat1_r, lng1_r = math.radians(lat1), math.radians(lng1)
    lat2_r, lng2_r = math.radians(lat2), math.radians(lng2)
    dlat = lat2_r - lat1_r
    dlng = lng2_r - lng1_r
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1_r) * math.cos(lat2_r) * math.sin(dlng / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def total_route_distance_km(stops: List[Dict]) -> float:
    """Compute the total Haversine distance of a sequence of stops."""
    total = 0.0
    for i in range(len(stops) - 1):
        total += haversine_km(
            stops[i]["lat"], stops[i]["lng"],
            stops[i + 1]["lat"], stops[i + 1]["lng"],
        )
    return total


# ---------------------------------------------------------------------------
# Incremental 2-Opt (neighbourhood-restricted)
# ---------------------------------------------------------------------------

def incremental_two_opt(
    stops: List[Dict],
    changed_index: int,
    radius_km: float = INCREMENTAL_RADIUS_KM,
) -> List[Dict]:
    """
    Run 2-Opt edge swaps restricted to a local neighbourhood around the
    changed node.  Reduces search from O(n²) to O(k²) where k ≈ 5-10.
    """
    if len(stops) < 4:
        return stops

    center = stops[changed_index]

    # Find indices within radius
    local_indices = [
        i for i, s in enumerate(stops)
        if haversine_km(center["lat"], center["lng"], s["lat"], s["lng"]) <= radius_km
    ]

    if len(local_indices) < 3:
        return stops

    improved = True
    route = list(stops)

    while improved:
        improved = False
        for a in range(len(local_indices) - 1):
            for b in range(a + 2, len(local_indices)):
                i = local_indices[a]
                j = local_indices[b]
                if j - i < 2 or i < 0 or j >= len(route):
                    continue

                # Calculate delta
                d_before = (
                    haversine_km(route[i]["lat"], route[i]["lng"],
                                 route[i + 1]["lat"], route[i + 1]["lng"])
                    + haversine_km(route[j]["lat"], route[j]["lng"],
                                   route[(j + 1) % len(route)]["lat"],
                                   route[(j + 1) % len(route)]["lng"])
                )
                d_after = (
                    haversine_km(route[i]["lat"], route[i]["lng"],
                                 route[j]["lat"], route[j]["lng"])
                    + haversine_km(route[i + 1]["lat"], route[i + 1]["lng"],
                                   route[(j + 1) % len(route)]["lat"],
                                   route[(j + 1) % len(route)]["lng"])
                )

                if d_after < d_before:
                    route[i + 1:j + 1] = reversed(route[i + 1:j + 1])
                    improved = True
                    break
            if improved:
                break

    return route


# ---------------------------------------------------------------------------
# Route Adaptation Engine
# ---------------------------------------------------------------------------

class RouteAdaptationEngine:
    """
    Processes real-time field events and produces RouteDelta change-sets.
    """

    def __init__(self, all_properties: Optional[List[Dict]] = None):
        """
        Parameters
        ----------
        all_properties : full universe of scored properties (for promotion lookups)
        """
        self._all_properties = all_properties or []
        self._consecutive_no_answers = 0

    def handle_event(
        self,
        trigger: TriggerType,
        current_position: Dict[str, float],
        completed_stops: List[Dict],
        remaining_stops: List[Dict],
        extra: Optional[Dict] = None,
    ) -> RouteDelta:
        """
        Process a field event and return the route delta.

        Parameters
        ----------
        trigger           : type of event
        current_position  : {lat, lng}
        completed_stops   : stops already visited
        remaining_stops   : stops not yet visited
        extra             : trigger-specific data (e.g. converted property ID)
        """
        extra = extra or {}

        if trigger == TriggerType.CONVERSION:
            return self._handle_conversion(current_position, remaining_stops, extra)
        elif trigger == TriggerType.NO_ANSWER_CLUSTER:
            return self._handle_no_answer(current_position, remaining_stops)
        elif trigger == TriggerType.TRAFFIC:
            return self._handle_traffic(current_position, remaining_stops, extra)
        elif trigger == TriggerType.EARLY_COMPLETION:
            return self._handle_early_completion(current_position, remaining_stops)
        else:
            return RouteDelta(
                delta_type=DeltaType.REORDER,
                affected_stops=[],
                new_sequence=remaining_stops,
                estimated_time_delta_minutes=0,
                new_total_distance_km=total_route_distance_km(remaining_stops),
            )

    def _handle_conversion(
        self,
        current_position: Dict[str, float],
        remaining_stops: List[Dict],
        extra: Dict,
    ) -> RouteDelta:
        """
        Conversion event: promote nearby high-propensity properties that
        aren't already in the route (within 0.5 km).
        """
        self._consecutive_no_answers = 0  # reset no-answer counter

        remaining_ids = {s.get("id") for s in remaining_stops}
        promoted = []

        for prop in self._all_properties:
            if prop.get("id") in remaining_ids:
                continue
            dist = haversine_km(
                current_position["lat"], current_position["lng"],
                prop["lat"], prop["lng"],
            )
            if dist <= PROMOTION_RADIUS_KM and prop.get("propensity_score", 0) > 500:
                promoted.append(prop)

        # Sort promoted by propensity descending
        promoted.sort(key=lambda p: p.get("propensity_score", 0), reverse=True)

        # Insert promoted at the front of remaining
        new_sequence = promoted + remaining_stops

        # Quick local 2-Opt around insertion point
        if promoted:
            new_sequence = incremental_two_opt(new_sequence, 0)

        return RouteDelta(
            delta_type=DeltaType.INSERT,
            affected_stops=promoted,
            new_sequence=new_sequence,
            estimated_time_delta_minutes=len(promoted) * 5.0,  # ~5 min per promoted stop
            new_total_distance_km=total_route_distance_km(new_sequence),
        )

    def _handle_no_answer(
        self,
        current_position: Dict[str, float],
        remaining_stops: List[Dict],
    ) -> RouteDelta:
        """
        No-answer cluster: after 3 consecutive no-answers, skip remaining
        stops in the current micro-cluster and reroute to the next best cluster.
        """
        self._consecutive_no_answers += 1

        if self._consecutive_no_answers < NO_ANSWER_THRESHOLD:
            # Not enough consecutive no-answers — no change
            return RouteDelta(
                delta_type=DeltaType.REORDER,
                affected_stops=[],
                new_sequence=remaining_stops,
                estimated_time_delta_minutes=0,
                new_total_distance_km=total_route_distance_km(remaining_stops),
            )

        self._consecutive_no_answers = 0

        # Remove nearby low-propensity stops (within 0.3 km — same micro-cluster)
        skipped = []
        kept = []
        for stop in remaining_stops:
            dist = haversine_km(
                current_position["lat"], current_position["lng"],
                stop["lat"], stop["lng"],
            )
            if dist < 0.3 and stop.get("propensity_score", 500) < 600:
                skipped.append(stop)
            else:
                kept.append(stop)

        # Re-sort by propensity to hit the best remaining cluster next
        kept.sort(key=lambda s: s.get("propensity_score", 0), reverse=True)

        return RouteDelta(
            delta_type=DeltaType.REMOVE,
            affected_stops=skipped,
            new_sequence=kept,
            estimated_time_delta_minutes=-len(skipped) * 3.0,
            new_total_distance_km=total_route_distance_km(kept),
        )

    def _handle_traffic(
        self,
        current_position: Dict[str, float],
        remaining_stops: List[Dict],
        extra: Dict,
    ) -> RouteDelta:
        """
        Traffic event: incremental 2-Opt on remaining stops to minimise
        the updated travel path.
        """
        self._consecutive_no_answers = 0

        if not remaining_stops:
            return RouteDelta(
                delta_type=DeltaType.REORDER,
                affected_stops=[],
                new_sequence=[],
                estimated_time_delta_minutes=0,
                new_total_distance_km=0,
            )

        optimised = incremental_two_opt(remaining_stops, 0)

        time_delta = extra.get("extra_travel_minutes", 0)

        return RouteDelta(
            delta_type=DeltaType.REORDER,
            affected_stops=[],
            new_sequence=optimised,
            estimated_time_delta_minutes=time_delta,
            new_total_distance_km=total_route_distance_km(optimised),
        )

    def _handle_early_completion(
        self,
        current_position: Dict[str, float],
        remaining_stops: List[Dict],
    ) -> RouteDelta:
        """
        Early completion: append nearest unassigned high-propensity stops.
        """
        self._consecutive_no_answers = 0

        route_ids = {s.get("id") for s in remaining_stops}
        candidates = []

        for prop in self._all_properties:
            if prop.get("id") in route_ids:
                continue
            if prop.get("propensity_score", 0) < 500:
                continue
            dist = haversine_km(
                current_position["lat"], current_position["lng"],
                prop["lat"], prop["lng"],
            )
            candidates.append((dist, prop))

        # Sort by distance, take closest high-propensity stops
        candidates.sort(key=lambda x: x[0])
        appended = [c[1] for c in candidates[:10]]  # Up to 10 bonus stops

        new_sequence = remaining_stops + appended

        return RouteDelta(
            delta_type=DeltaType.INSERT,
            affected_stops=appended,
            new_sequence=new_sequence,
            estimated_time_delta_minutes=len(appended) * 5.0,
            new_total_distance_km=total_route_distance_km(new_sequence),
        )
