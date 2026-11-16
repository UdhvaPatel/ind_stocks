"""Setup score 0-100 (PLAN.md 6.1): a transparent composite, shown with its parts.

Weights are judgement, not fitted. Phase 5 tests whether the score carries any
information; it is never tuned silently (model_version must change).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import config

PARTS = ["trend", "level", "momentum", "participation", "risk"]


def tent(x, lo0: float, lo1: float, hi1: float, hi0: float):
    """0 below lo0, rising to 1 at lo1, flat to hi1, falling to 0 at hi0."""
    x = np.asarray(x, dtype=float)
    up = np.clip((x - lo0) / (lo1 - lo0), 0, 1) if lo1 > lo0 else (x >= lo0).astype(float)
    down = np.clip((hi0 - x) / (hi0 - hi1), 0, 1) if hi0 > hi1 else (x <= hi0).astype(float)
    return np.where(np.isnan(x), np.nan, np.minimum(up, down))


def _mix(parts: list[tuple[float, np.ndarray]]) -> np.ndarray:
    """Weighted mean; a missing component counts as neutral (0.5)."""
    total = sum(w for w, _ in parts)
    return sum(w * np.where(np.isnan(v), 0.5, v) for w, v in parts) / total


def setup_parts(feat: pd.DataFrame, vix_regime: pd.Series | None = None) -> pd.DataFrame:
    """Sub-scores in [0, 1] for every row of a feature frame."""
    g = lambda col: feat[col].values.astype(float)
    flag = lambda cond, ref: np.where(np.isnan(ref), np.nan, cond.astype(float))
    c = g("close")

    slope_up = g("slope_20") > 0
    trend = _mix([
        (0.25, flag(c > g("sma_50"), g("sma_50"))),
        (0.25, flag(c > g("sma_200"), g("sma_200"))),
        (0.20, flag(g("sma_50") > g("sma_200"), g("sma_200"))),
        (0.15, np.clip(g("slope_20") / 0.2, 0, 1)),
        (0.15, tent(g("adx_14"), 10, 25, 1e9, 1e9 + 1) * slope_up),
    ])
    level = _mix([
        (0.5, tent(g("z_20"), -2.5, -0.5, 1.5, 3.0)),
        (0.3, tent(g("bb_pctb"), -0.2, 0.2, 0.9, 1.2)),
        (0.2, tent(g("dist_sma_20"), -8, -2, 5, 10)),
    ])
    momentum = _mix([
        (0.4, tent(g("rsi_14"), 30, 45, 68, 82)),
        (0.3, np.clip(g("roc_21") / 5, 0, 1)),
        (0.3, np.clip((g("rs_21") + 3) / 6, 0, 1)),
    ])
    participation = _mix([
        (0.4, tent(g("volume_ratio"), 0.4, 0.8, 2.5, 5.0)),
        (0.3, np.clip(0.5 + g("deliv_vs_60") / 20, 0, 1)),
        (0.3, np.clip((g("up_volume_ratio") - 35) / 30, 0, 1)),
    ])
    if vix_regime is not None and len(vix_regime):
        reg = vix_regime.reindex(feat.index).ffill().values.astype(float)
        vix_score = np.select([reg < 0, reg > 0], [1.0, 0.2], 0.7)
        vix_score = np.where(np.isnan(reg), np.nan, vix_score)
    else:
        vix_score = np.full(len(feat), np.nan)
    risk = _mix([
        (0.4, tent(g("vol_ratio"), -1, 0, 1.1, 1.6)),
        (0.3, vix_score),
        (0.3, np.clip(1 + g("drawdown") / 25, 0, 1)),
    ])
    return pd.DataFrame({"trend": trend, "level": level, "momentum": momentum,
                         "participation": participation, "risk": risk}, index=feat.index)


def setup_score(feat: pd.DataFrame, vix_regime: pd.Series | None = None) -> pd.DataFrame:
    """Sub-scores plus the weighted total in 0-100."""
    weights = config.load_yaml("model.yaml")["setup_weights"]
    parts = setup_parts(feat, vix_regime)
    total = sum(weights[p] * parts[p] for p in PARTS) / sum(weights[p] for p in PARTS)
    parts["setup"] = (100 * total).round(1)
    ready = feat["sma_200"].notna() & feat["atr_14"].notna()
    parts.loc[~ready, "setup"] = np.nan
    return parts
