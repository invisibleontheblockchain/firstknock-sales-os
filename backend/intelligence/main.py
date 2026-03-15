import os
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Optional, Dict, Any

from models.xgboost_scorer import score_properties
from routing.cluster_hdbscan import cluster_properties
from routing.ortools_vrptw import optimize_routes

app = FastAPI(title="FirstKnock Algorithm II Intelligence Layer", version="1.0")

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

@app.get("/health")
def health_check():
    return {"status": "ok"}

@app.post("/propensity/score")
def get_propensity_scores(properties: List[PropertyData]):
    """
    Step 1: XGBoost scoring.
    """
    try:
        # Convert to dict format
        prop_dicts = [p.dict() for p in properties]
        scored = score_properties(prop_dicts)
        return {"data": scored}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/territory/cluster")
def generate_clusters(properties: List[PropertyData]):
    """
    Step 2: HDBSCAN Clustering.
    Assumes properties have already been scored.
    """
    try:
        prop_dicts = [p.dict() for p in properties]
        clusters = cluster_properties(prop_dicts)
        return {"data": clusters}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/routing/optimize")
def optimize_daily_routes(request: OptimizationRequest):
    """
    Step 3: VRPTW Optimization with OR-Tools.
    Runs clustering then routes the highest density cluster.
    """
    try:
        prop_dicts = [p.dict() for p in request.properties]
        
        # In a real pipeline, we'd run XGBoost -> HDBSCAN -> OR-Tools
        # For this endpoint we assume scoping is done or we run the full chain.
        # 1. Feature -> Score
        scored_props = score_properties(prop_dicts)
        
        # 2. Score -> Cluster
        clustered_props = cluster_properties(scored_props)
        
        # 3. Cluster -> Route (We'll just route Cluster 0 for testing, or all if small)
        routed = optimize_routes(
            properties=clustered_props,
            depot={"lat": request.depot_lat, "lng": request.depot_lng},
            max_duration_min=request.max_route_duration_minutes
        )
        return {"data": routed}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# uvicorn main:app --reload --port 8000
