import os
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Optional, Dict, Any

from models.xgboost_scorer import score_properties
from routing.cluster_hdbscan import cluster_properties
from routing.ortools_vrptw import optimize_routes

# Phase 3 imports
from mlops.drift_monitor import DriftMonitor, compute_feature_psi
from mlops.experiment_tracker import ExperimentTracker
from mlops.pipeline import evaluate_retrain_triggers, RetrainPipeline
from models.market_regime import MarketRegimeDetector
from models.ab_testing import ThompsonSamplingMAB
from routing.fatigue_model import FatigueTracker
from routing.route_adaptation import RouteAdaptationEngine, TriggerType

import numpy as np

app = FastAPI(title="FirstKnock Algorithm II Intelligence Layer", version="2.0")

# ---------------------------------------------------------------------------
# Singletons (stateful services persist across requests)
# ---------------------------------------------------------------------------
drift_monitor = DriftMonitor()
experiment_tracker = ExperimentTracker()
regime_detector = MarketRegimeDetector()
mab = ThompsonSamplingMAB()

# Bootstrap default weight arms for the MAB
mab.add_arm("baseline", {"ownership": 0.35, "pqi": 0.20, "heat": 0.25, "distress": 0.20})
mab.add_arm("distress_heavy", {"ownership": 0.25, "pqi": 0.15, "heat": 0.20, "distress": 0.40})
mab.add_arm("heat_heavy", {"ownership": 0.20, "pqi": 0.15, "heat": 0.45, "distress": 0.20})

# ---------------------------------------------------------------------------
# Request / Response Models
# ---------------------------------------------------------------------------

class PropertyData(BaseModel):
    id: str
    lat: float
    lng: float
    # Features for propensity
    ownership_duration_months: Optional[float] = None
    unrealized_gain_pct: Optional[float] = None
    current_ltv_ratio: Optional[float] = None
    property_type_encoded: Optional[str] = "SFR"
    dom_current: Optional[float] = None
    assessment_gap_ratio: Optional[float] = None
    size_zscore_msa: Optional[float] = None
    property_age_years: Optional[float] = None
    bed_bath_ratio: Optional[float] = None
    owner_occupied_flag: Optional[int] = 1
    gross_rent_yield: Optional[float] = None
    price_tier_quintile: Optional[int] = None
    zip_absorption_rate: Optional[float] = None
    absentee_owner_flag: Optional[int] = 0

class OptimizationRequest(BaseModel):
    properties: List[PropertyData]
    depot_lat: float
    depot_lng: float
    max_route_duration_minutes: int = 540  # 9 hours default

class MarketObservation(BaseModel):
    absorption_rate: float
    median_dom: float
    list_to_sale_ratio: float
    price_momentum_index: float

class MarketRegimeRequest(BaseModel):
    observations: List[MarketObservation]
    current_month: int = 6

class ABOutcomeRequest(BaseModel):
    arm_id: str
    event_type: str  # knocked, answered, interested, appointment_set, no_answer, rejected
    use_dts: bool = False
    selection_probability: Optional[float] = None

class RouteDeltaRequest(BaseModel):
    rep_id: str
    trigger_event: str  # conversion, no_answer_cluster, traffic, early_completion
    current_position: Dict[str, float]  # {lat, lng}
    completed_stops: List[Dict[str, Any]]
    remaining_stops: List[Dict[str, Any]]
    extra: Optional[Dict[str, Any]] = None

class DriftCheckRequest(BaseModel):
    current_features: Dict[str, List[float]]
    conversion_outcomes: Optional[List[float]] = None

# ===========================================================================
# Phase 2 Endpoints (unchanged)
# ===========================================================================

@app.get("/health")
def health_check():
    return {"status": "ok", "version": "2.0", "phase": "3-continuous-learning"}

@app.post("/propensity/score")
def get_propensity_scores(properties: List[PropertyData]):
    """Step 1: XGBoost scoring."""
    try:
        prop_dicts = [p.dict() for p in properties]
        scored = score_properties(prop_dicts)
        return {"data": scored}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/territory/cluster")
def generate_clusters(properties: List[PropertyData]):
    """Step 2: HDBSCAN Clustering."""
    try:
        prop_dicts = [p.dict() for p in properties]
        clusters = cluster_properties(prop_dicts)
        return {"data": clusters}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/routing/optimize")
def optimize_daily_routes(request: OptimizationRequest):
    """Step 3: VRPTW Optimization with OR-Tools."""
    try:
        prop_dicts = [p.dict() for p in request.properties]
        scored_props = score_properties(prop_dicts)
        clustered_props = cluster_properties(scored_props)
        routed = optimize_routes(
            properties=clustered_props,
            depot={"lat": request.depot_lat, "lng": request.depot_lng},
            max_duration_min=request.max_route_duration_minutes
        )
        return {"data": routed}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ===========================================================================
# Phase 3 Endpoints
# ===========================================================================

# --- MLOps: Drift Monitoring ---

@app.post("/mlops/drift-report")
def get_drift_report(request: DriftCheckRequest):
    """
    Check for feature drift (PSI) and concept drift (ADWIN/Page-Hinkley).
    """
    try:
        current_data = {k: np.array(v) for k, v in request.current_features.items()}

        # Feed conversion outcomes to concept detectors
        if request.conversion_outcomes:
            for outcome in request.conversion_outcomes:
                drift_monitor.log_conversion_outcome(outcome)

        report = drift_monitor.evaluate(current_data)

        # Check retrain triggers
        metrics = {
            "max_psi": max(report.feature_psi.values()) if report.feature_psi else 0.0,
            "adwin_alert": 1.0 if report.adwin_alert else 0.0,
        }
        triggers = evaluate_retrain_triggers(metrics)

        return {
            "drift_report": report.to_dict(),
            "retrain_triggers": [
                {"priority": t.priority.value, "reason": t.reason}
                for t in triggers
            ],
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/mlops/set-reference")
def set_drift_reference(features: Dict[str, List[float]]):
    """Set the reference distributions for PSI monitoring."""
    try:
        ref = {k: np.array(v) for k, v in features.items()}
        drift_monitor.set_reference(ref)
        return {"status": "reference_set", "features": list(features.keys())}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# --- Market Regime Detection ---

@app.post("/market/regime")
def detect_market_regime(request: MarketRegimeRequest):
    """Predict market regime (hot/neutral/cold) from observation sequence."""
    try:
        obs_array = np.array([
            [o.absorption_rate, o.median_dom, o.list_to_sale_ratio, o.price_momentum_index]
            for o in request.observations
        ])
        result = regime_detector.predict(obs_array, current_month=request.current_month)
        return {"data": result.to_dict()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# --- A/B Testing (Thompson Sampling MAB) ---

@app.post("/ab/select-arm")
def select_ab_arm():
    """Select the next weight configuration via Thompson Sampling."""
    try:
        explore = mab.should_explore()
        arm = mab.select_arm(force_exploration=explore)
        return {"data": arm.to_dict(), "forced_exploration": explore}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/ab/log-outcome")
def log_ab_outcome(request: ABOutcomeRequest):
    """Log a field rep event and update the arm's Beta posterior."""
    try:
        mab.log_outcome(
            arm_id=request.arm_id,
            event_type=request.event_type,
            use_dts=request.use_dts,
            selection_probability=request.selection_probability,
        )
        status = mab.get_status()
        return {"data": status.get(request.arm_id, {})}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/ab/status")
def get_ab_status():
    """Return the current state of all MAB arms."""
    return {"data": mab.get_status()}

# --- Route Delta (Real-Time Adaptation) ---

@app.post("/api/v1/route/delta")
def compute_route_delta(request: RouteDeltaRequest):
    """
    Real-time route adaptation.  Response SLA: < 2 seconds.
    """
    try:
        trigger_map = {
            "conversion": TriggerType.CONVERSION,
            "no_answer_cluster": TriggerType.NO_ANSWER_CLUSTER,
            "traffic": TriggerType.TRAFFIC,
            "early_completion": TriggerType.EARLY_COMPLETION,
        }
        trigger = trigger_map.get(request.trigger_event)
        if not trigger:
            raise HTTPException(status_code=400, detail=f"Unknown trigger: {request.trigger_event}")

        engine = RouteAdaptationEngine(all_properties=request.remaining_stops)
        delta = engine.handle_event(
            trigger=trigger,
            current_position=request.current_position,
            completed_stops=request.completed_stops,
            remaining_stops=request.remaining_stops,
            extra=request.extra,
        )
        return {"data": delta.to_dict()}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# --- Fatigue State ---

@app.post("/fatigue/simulate")
def simulate_fatigue(
    steps: List[Dict[str, Any]],
    temperature_celsius: float = 22.0,
    shift_start_hour: float = 9.0,
):
    """
    Simulate fatigue over a series of steps and return the trajectory.
    Each step: {minutes, walking, rejection, is_break}
    """
    try:
        tracker = FatigueTracker(temperature_celsius, shift_start_hour)
        trajectory = []
        for s in steps:
            state = tracker.step(
                minutes=s.get("minutes", 5),
                walking=s.get("walking", True),
                rejection=s.get("rejection", False),
                is_break=s.get("is_break", False),
            )
            trajectory.append(state.to_dict())
        return {"data": trajectory}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# uvicorn main:app --reload --port 8000
