"""
MLOps Experiment Tracker — Algorithm II Phase 3
================================================
Lightweight wrapper around MLflow for model versioning, hyperparameter
logging, and validation metric tracking.

Strategy Doc §3.4 — MLOps Pipeline Architecture
"""

import logging
from typing import Dict, Any, Optional
from dataclasses import dataclass
from datetime import datetime

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# When MLflow is available, we use it directly.  If not (e.g. unit tests,
# cold-start environments), we fall back to in-memory tracking.
# ---------------------------------------------------------------------------

try:
    import mlflow
    MLFLOW_AVAILABLE = True
except ImportError:
    MLFLOW_AVAILABLE = False
    logger.warning("mlflow not installed — using in-memory experiment tracker")


@dataclass
class TrainingResult:
    """Summary of a single training run."""
    model_version: str
    auc_roc: float
    pr_auc: float
    brier_score: float
    lift_at_top_decile: float
    params: Dict[str, Any]
    timestamp: str


class ExperimentTracker:
    """
    Tracks XGBoost propensity model training runs.

    - If MLflow is available, logs to the MLflow tracking server.
    - Otherwise, maintains an in-memory registry (sufficient for dev/test).
    """

    def __init__(self, experiment_name: str = "algorithm_ii_propensity"):
        self.experiment_name = experiment_name
        self._runs: list = []

        if MLFLOW_AVAILABLE:
            mlflow.set_experiment(experiment_name)

    def log_training_run(
        self,
        params: Dict[str, Any],
        metrics: Dict[str, float],
        model_artifact_path: Optional[str] = None,
        tags: Optional[Dict[str, str]] = None,
    ) -> TrainingResult:
        """
        Log a completed training run.

        Parameters
        ----------
        params  : hyperparameters used (n_estimators, max_depth, etc.)
        metrics : validation metrics (auc_roc, pr_auc, brier_score, lift_top_decile)
        model_artifact_path : optional path to saved model file
        tags : optional metadata tags
        """
        result = TrainingResult(
            model_version=f"v{len(self._runs) + 1}",
            auc_roc=metrics.get("auc_roc", 0.0),
            pr_auc=metrics.get("pr_auc", 0.0),
            brier_score=metrics.get("brier_score", 1.0),
            lift_at_top_decile=metrics.get("lift_top_decile", 0.0),
            params=params,
            timestamp=datetime.utcnow().isoformat(),
        )
        self._runs.append(result)

        if MLFLOW_AVAILABLE:
            with mlflow.start_run():
                mlflow.log_params(params)
                mlflow.log_metrics(metrics)
                if tags:
                    mlflow.set_tags(tags)
                if model_artifact_path:
                    mlflow.log_artifact(model_artifact_path)

        logger.info(f"Logged training run {result.model_version}: AUC-ROC={result.auc_roc:.4f}")
        return result

    def get_best_model(self, metric: str = "auc_roc") -> Optional[TrainingResult]:
        """Return the training run with the best value for the given metric."""
        if not self._runs:
            return None

        if metric == "brier_score":
            return min(self._runs, key=lambda r: getattr(r, metric, float("inf")))
        return max(self._runs, key=lambda r: getattr(r, metric, 0.0))

    def should_promote(self, candidate: TrainingResult, current_best: Optional[TrainingResult] = None) -> bool:
        """
        Determine if a candidate model should replace the current production model.

        Promotion criteria (from Strategy Doc §3.4):
        - AUC-ROC >= 0.75  (Phase 2+ minimum)
        - PR-AUC  >= 0.25
        - Brier   <= 0.05
        - Lift@10 >= 3.0×
        """
        min_thresholds = {
            "auc_roc": 0.75,
            "pr_auc": 0.25,
            "brier_score": 0.05,  # upper bound
            "lift_at_top_decile": 3.0,
        }

        if candidate.auc_roc < min_thresholds["auc_roc"]:
            return False
        if candidate.pr_auc < min_thresholds["pr_auc"]:
            return False
        if candidate.brier_score > min_thresholds["brier_score"]:
            return False
        if candidate.lift_at_top_decile < min_thresholds["lift_at_top_decile"]:
            return False

        # If there's a current best, candidate must beat it on AUC-ROC
        if current_best and candidate.auc_roc <= current_best.auc_roc:
            return False

        return True

    def list_runs(self) -> list:
        return [
            {
                "version": r.model_version,
                "auc_roc": r.auc_roc,
                "pr_auc": r.pr_auc,
                "brier_score": r.brier_score,
                "lift_top_decile": r.lift_at_top_decile,
                "timestamp": r.timestamp,
            }
            for r in self._runs
        ]
