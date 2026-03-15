"""
MLOps Retrain Pipeline — Algorithm II Phase 3
==============================================
Metaflow-based DAG for orchestrating model retraining when drift is detected.

Strategy Doc §3.4 — Retraining Trigger Conditions (Table 9)
    P0 — AUC-ROC < 0.72 on rolling 7-day validation → immediate full retrain
    P1 — PSI > 0.25 on any top-5 feature → retrain within 24 h
    P1 — ADWIN concept drift alert → retrain within 48 h
    P2 — Lift@10 < 2.0× for 3 consecutive days → investigate + retrain
    P2 — HMM regime transition → conditional weight recalibration only
    P3 — Monthly scheduled maintenance → full retrain + hyperparameter sweep

This module defines the pipeline steps; actual execution is via Metaflow CLI
or cron trigger.
"""

import logging
from typing import Dict, Any, Optional
from dataclasses import dataclass
from enum import Enum

logger = logging.getLogger(__name__)


class TriggerPriority(Enum):
    P0_CRITICAL = "P0"      # Immediate full retrain
    P1_HIGH = "P1"          # Retrain within 24-48 h
    P2_MEDIUM = "P2"        # Investigate + retrain
    P3_MAINTENANCE = "P3"   # Monthly scheduled


@dataclass
class RetrainTrigger:
    priority: TriggerPriority
    reason: str
    metric_name: Optional[str] = None
    metric_value: Optional[float] = None
    threshold: Optional[float] = None


# ---------------------------------------------------------------------------
# Trigger evaluation
# ---------------------------------------------------------------------------

RETRAIN_CONDITIONS = [
    {
        "name": "auc_roc_degradation",
        "priority": TriggerPriority.P0_CRITICAL,
        "metric": "auc_roc",
        "threshold": 0.72,
        "direction": "below",
        "reason": "AUC-ROC dropped below 0.72 on rolling 7-day validation",
    },
    {
        "name": "psi_feature_drift",
        "priority": TriggerPriority.P1_HIGH,
        "metric": "max_psi",
        "threshold": 0.25,
        "direction": "above",
        "reason": "PSI > 0.25 detected on top-5 feature",
    },
    {
        "name": "adwin_concept_drift",
        "priority": TriggerPriority.P1_HIGH,
        "metric": "adwin_alert",
        "threshold": 0.5,
        "direction": "above",
        "reason": "ADWIN concept drift alert — conversion rate shift > 2σ",
    },
    {
        "name": "lift_degradation",
        "priority": TriggerPriority.P2_MEDIUM,
        "metric": "lift_top_decile",
        "threshold": 2.0,
        "direction": "below",
        "reason": "Lift at top decile < 2.0× for 3 consecutive days",
    },
    {
        "name": "hmm_regime_change",
        "priority": TriggerPriority.P2_MEDIUM,
        "metric": "regime_changed",
        "threshold": 0.5,
        "direction": "above",
        "reason": "HMM market regime transition detected",
    },
]


def evaluate_retrain_triggers(metrics: Dict[str, float]) -> list:
    """
    Evaluate current metrics against all retrain trigger conditions.

    Parameters
    ----------
    metrics : dict with keys like 'auc_roc', 'max_psi', 'adwin_alert',
              'lift_top_decile', 'regime_changed'

    Returns
    -------
    list of RetrainTrigger objects for all fired conditions, sorted by priority.
    """
    fired: list = []

    for cond in RETRAIN_CONDITIONS:
        val = metrics.get(cond["metric"])
        if val is None:
            continue

        should_fire = False
        if cond["direction"] == "below" and val < cond["threshold"]:
            should_fire = True
        elif cond["direction"] == "above" and val > cond["threshold"]:
            should_fire = True

        if should_fire:
            fired.append(RetrainTrigger(
                priority=cond["priority"],
                reason=cond["reason"],
                metric_name=cond["metric"],
                metric_value=val,
                threshold=cond["threshold"],
            ))

    # Sort by priority (P0 first)
    priority_order = {
        TriggerPriority.P0_CRITICAL: 0,
        TriggerPriority.P1_HIGH: 1,
        TriggerPriority.P2_MEDIUM: 2,
        TriggerPriority.P3_MAINTENANCE: 3,
    }
    fired.sort(key=lambda t: priority_order.get(t.priority, 99))
    return fired


# ---------------------------------------------------------------------------
# Pipeline Steps (Metaflow-compatible structure)
# ---------------------------------------------------------------------------

class RetrainPipeline:
    """
    Defines the retrain pipeline DAG.

    Steps: start → ingest → feature_engineer → train → validate →
           promote_or_reject → end

    Each step is a method that can be decorated with @step when running
    under Metaflow.  For non-Metaflow execution, call run() directly.
    """

    def __init__(self):
        self.results: Dict[str, Any] = {}

    def start(self, trigger: RetrainTrigger):
        """Record the retrain trigger and initialise the run."""
        self.results["trigger"] = {
            "priority": trigger.priority.value,
            "reason": trigger.reason,
        }
        logger.info(f"[Pipeline] Start — triggered by: {trigger.reason}")

    def ingest(self, data_source: str = "supabase"):
        """Pull latest property data for retraining."""
        logger.info(f"[Pipeline] Ingest from {data_source}")
        self.results["ingest"] = {"source": data_source, "status": "complete"}

    def feature_engineer(self):
        """Run feature engineering on ingested data."""
        logger.info("[Pipeline] Feature engineering")
        self.results["features"] = {"status": "complete"}

    def train(self, params: Optional[Dict[str, Any]] = None):
        """Train the XGBoost model with given or default hyperparameters."""
        default_params = {
            "n_estimators": 500,
            "max_depth": 5,
            "learning_rate": 0.05,
            "subsample": 0.8,
            "colsample_bytree": 0.8,
            "scale_pos_weight": 20,
        }
        used_params = params or default_params
        logger.info(f"[Pipeline] Training with params: {used_params}")
        self.results["train"] = {"params": used_params, "status": "complete"}

    def validate(self, metrics: Dict[str, float]):
        """Record validation metrics."""
        self.results["validate"] = metrics
        logger.info(f"[Pipeline] Validation metrics: {metrics}")

    def promote_or_reject(self, promote: bool):
        """Promote or reject the candidate model."""
        action = "promoted" if promote else "rejected"
        self.results["decision"] = action
        logger.info(f"[Pipeline] Model {action}")

    def run(self, trigger: RetrainTrigger, metrics: Optional[Dict[str, float]] = None):
        """Execute the full pipeline synchronously."""
        self.start(trigger)
        self.ingest()
        self.feature_engineer()
        self.train()
        validation_metrics = metrics or {
            "auc_roc": 0.0,
            "pr_auc": 0.0,
            "brier_score": 1.0,
            "lift_top_decile": 0.0,
        }
        self.validate(validation_metrics)
        promote = validation_metrics.get("auc_roc", 0) >= 0.75
        self.promote_or_reject(promote)
        return self.results
