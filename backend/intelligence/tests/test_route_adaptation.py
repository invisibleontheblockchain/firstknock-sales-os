"""
Tests for Algorithm II Phase 3 — Route Adaptation (RL-AVNS)
"""

from routing.route_adaptation import (
    RouteAdaptationEngine,
    TriggerType,
    DeltaType,
    haversine_km,
    incremental_two_opt,
)


def _make_stops(n=10, base_lat=33.5, base_lng=-84.4):
    """Generate a line of test stops."""
    return [
        {
            "id": f"prop_{i}",
            "lat": base_lat + i * 0.001,
            "lng": base_lng + i * 0.001,
            "propensity_score": 500 + i * 30,
        }
        for i in range(n)
    ]


def test_haversine_km():
    """Haversine should return reasonable distances."""
    # Atlanta to a point ~1 km north
    d = haversine_km(33.749, -84.388, 33.758, -84.388)
    assert 0.9 < d < 1.1, f"Expected ~1 km, got {d}"


def test_conversion_promotes_nearby():
    """Conversion trigger should insert nearby high-propensity properties."""
    all_props = _make_stops(20)
    engine = RouteAdaptationEngine(all_properties=all_props)

    current_pos = {"lat": 33.501, "lng": -84.399}
    remaining = _make_stops(5, base_lat=33.510, base_lng=-84.390)

    delta = engine.handle_event(
        trigger=TriggerType.CONVERSION,
        current_position=current_pos,
        completed_stops=[],
        remaining_stops=remaining,
    )
    assert delta.delta_type == DeltaType.INSERT


def test_no_answer_cluster_skips_after_three():
    """Three consecutive no-answers should trigger skip + reroute."""
    engine = RouteAdaptationEngine()
    pos = {"lat": 33.5, "lng": -84.4}
    remaining = _make_stops(10)

    # First two: no change (below threshold)
    for _ in range(2):
        delta = engine.handle_event(
            TriggerType.NO_ANSWER_CLUSTER, pos, [], remaining
        )
        assert delta.delta_type == DeltaType.REORDER

    # Third: should trigger skip
    delta = engine.handle_event(
        TriggerType.NO_ANSWER_CLUSTER, pos, [], remaining
    )
    assert delta.delta_type == DeltaType.REMOVE


def test_traffic_reorders_route():
    """Traffic event should trigger reorder via incremental 2-Opt."""
    engine = RouteAdaptationEngine()
    pos = {"lat": 33.5, "lng": -84.4}
    remaining = _make_stops(8)

    delta = engine.handle_event(
        TriggerType.TRAFFIC, pos, [], remaining,
        extra={"extra_travel_minutes": 10}
    )
    assert delta.delta_type == DeltaType.REORDER
    assert len(delta.new_sequence) == 8


def test_early_completion_appends_stops():
    """Early completion should append nearby high-propensity stops."""
    all_props = _make_stops(20)
    engine = RouteAdaptationEngine(all_properties=all_props)
    pos = {"lat": 33.5, "lng": -84.4}

    delta = engine.handle_event(
        TriggerType.EARLY_COMPLETION, pos, [], [],
    )
    assert delta.delta_type == DeltaType.INSERT
    assert len(delta.affected_stops) > 0


def test_incremental_two_opt_short_route():
    """Incremental 2-Opt on a very short route should not crash."""
    stops = _make_stops(3)
    result = incremental_two_opt(stops, 0)
    assert len(result) == 3


def test_route_delta_to_dict():
    """RouteDelta.to_dict should produce a JSON-serialisable dictionary."""
    engine = RouteAdaptationEngine()
    pos = {"lat": 33.5, "lng": -84.4}
    remaining = _make_stops(5)

    delta = engine.handle_event(TriggerType.TRAFFIC, pos, [], remaining)
    d = delta.to_dict()
    assert "delta_type" in d
    assert "new_sequence" in d
    assert "estimated_time_delta_minutes" in d
