"""Rule backtests (PLAN.md 6.4): the evidence shown next to every plan.

All figures are net of the cost model and expressed in R (multiples of the
planned risk per share), so they scale to any capital in the UI.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import config
from .plans import TRADED


def rule_stats(sim: pd.DataFrame) -> dict:
    """Summary of one rule on one stock from a `plans.simulate` frame."""
    status = sim["status"]
    issued = status.isin(TRADED | {"cancelled", "not_triggered"})
    traded = status.isin(TRADED)
    r = sim.loc[traded, "r"].dropna().values
    out = {"plans": int(issued.sum()), "trades": int(len(r)),
           "trigger_rate": round(float(traded.sum() / issued.sum()), 3) if issued.sum() else None}
    if len(r) == 0:
        return out
    wins, losses = r[r > 0], r[r <= 0]
    sd = float(r.std(ddof=1)) if len(r) > 1 else float("nan")
    equity = np.cumsum(r)
    drawdown = equity - np.maximum.accumulate(np.r_[0.0, equity])[1:]
    streak = longest = 0
    for x in r:
        streak = streak + 1 if x <= 0 else 0
        longest = max(longest, streak)
    counts = status[traded].value_counts()
    out.update({
        "win_rate": round(float(len(wins) / len(r)), 3),
        "avg_win_r": round(float(wins.mean()), 3) if len(wins) else 0.0,
        "avg_loss_r": round(float(losses.mean()), 3) if len(losses) else 0.0,
        "expectancy_r": round(float(r.mean()), 4),
        "expectancy_gross_r": round(float(sim.loc[traded, "r_gross"].mean()), 4),
        "t_stat": round(float(r.mean() / (sd / np.sqrt(len(r)))), 2) if sd and sd > 0 else None,
        "profit_factor": round(float(wins.sum() / -losses.sum()), 2) if losses.sum() < 0 else None,
        "max_drawdown_r": round(float(drawdown.min()), 2),
        "longest_losing_streak": int(longest),
        "r_quantiles": {f"p{int(q * 100):02d}": round(float(v), 3)
                        for q, v in zip((0.05, 0.25, 0.50, 0.75, 0.95),
                                        np.quantile(r, (0.05, 0.25, 0.50, 0.75, 0.95)))},
        "avg_ret_pct": round(float(sim.loc[traded, "ret_pct"].mean()), 4),
        "outcomes": {k: int(counts.get(k, 0)) for k in ("stopped", "t1", "t2", "time")},
        "ambiguous_share": round(float(sim.loc[traded, "ambiguous"].mean()), 3),
    })
    return out


def monte_carlo(r: np.ndarray, cfg: dict | None = None) -> dict | None:
    """Range of outcomes over a run of trades, by resampling past trades.

    One backtest path is one draw of luck; resampling shows the spread. Returns
    the 5th / 50th / 95th percentile of total R after `trades_per_path` trades
    and of the worst drawdown along the way. Reproducible: fixed seed.
    """
    mc = (cfg or config.load_yaml("model.yaml"))["monte_carlo"]
    r = np.asarray(r, dtype=float)
    r = r[np.isfinite(r)]
    if len(r) < 20:
        return None
    rng = np.random.default_rng(mc["seed"])
    paths = rng.choice(r, size=(mc["resamples"], mc["trades_per_path"]), replace=True)
    equity = np.cumsum(paths, axis=1)
    total = equity[:, -1]
    peak = np.maximum.accumulate(np.concatenate([np.zeros((len(paths), 1)), equity], axis=1), axis=1)[:, 1:]
    worst_dd = (equity - peak).min(axis=1)
    q = lambda a: {f"p{p:02d}": round(float(np.percentile(a, p)), 2) for p in (5, 50, 95)}
    return {"trades": mc["trades_per_path"], "resamples": mc["resamples"],
            "total_r": q(total), "max_drawdown_r": q(worst_dd),
            "p_profit": round(float((total > 0).mean()), 3)}


def expanding_evidence(sim: pd.DataFrame) -> pd.DataFrame:
    """For each row, the rule's record using ONLY trades resolved before that row.

    Row i's own plan is resolved during session i+1, so evidence available when
    making the plan at row i is everything from rows < i. Used by the
    walk-forward so that no decision ever sees its own future.
    """
    r = sim["r"].where(sim["status"].isin(TRADED)).values.astype(float)
    ok = np.isfinite(r)
    n = np.r_[0, np.cumsum(ok)[:-1]]
    s = np.r_[0.0, np.cumsum(np.where(ok, r, 0.0))[:-1]]
    s2 = np.r_[0.0, np.cumsum(np.where(ok, r * r, 0.0))[:-1]]
    with np.errstate(divide="ignore", invalid="ignore"):
        mean = np.where(n > 0, s / n, np.nan)
        var = np.where(n > 1, (s2 - n * mean ** 2) / (n - 1), np.nan)
        t = np.where((n > 1) & (var > 0), mean / np.sqrt(var / n), np.nan)
    return pd.DataFrame({"n": n, "expectancy_r": mean, "t_stat": t}, index=sim.index)
