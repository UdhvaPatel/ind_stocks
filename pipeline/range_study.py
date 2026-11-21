"""Weekly range study: should the 90% close range get narrower? (pre-registered 21 Nov 2026)

Current range: the published p05..p95 for each stock and session (data/compare.json).
Challenger (fixed in advance, nothing tuned afterwards):
  1. scale each half-width by clip(sqrt(GK10 / GK60), 0.75, 1.25), where GK10 and GK60 are the
     stock's Garman-Klass daily variance over the last 10 and 60 sessions (known before the open):
     ranges widen when the stock has been unusually volatile lately and narrow when it is calm;
  2. multiply by a conformal factor fitted on the previous 20 sessions of all stocks, so that 90%
     of those closes would have landed inside (keeps the promise honest).
Score: coverage, average width, and the interval (Winkler) score = width + 20 x distance outside.
Adoption rule: the challenger may replace the current range only if
  - its walk-forward coverage is between 89% and 91%,
  - on at least 40 verified live sessions its coverage is between 87% and 93%,
  - its interval score is better with a day-clustered 95% interval that excludes zero.
Even then this module only reports "candidate ready": switching changes the published forecasts,
so it needs a new model_version, done by hand. Ranges will follow market volatility; they are not
expected to shrink steadily week by week.
"""
from __future__ import annotations

import json
import math

import numpy as np
import pandas as pd

from . import config, publish, score

ALPHA = 0.10
WINDOW = 20
MIN_LIVE = 40


def gk_variance(df: pd.DataFrame) -> pd.Series:
    o, h, l, c = (df[k].astype(float) for k in ("open", "high", "low", "close"))
    return 0.5 * np.log(h / l) ** 2 - (2 * math.log(2) - 1) * np.log(c / o) ** 2


def vol_ratio(frames: dict) -> dict[tuple[str, str], float]:
    """sqrt(GK10/GK60) as known before each session (shifted one day)."""
    out = {}
    for sym, df in frames.items():
        try:
            v = gk_variance(df.dropna(subset=["open", "high", "low", "close"]))
        except KeyError:
            continue
        ratio = np.sqrt(v.rolling(10).mean() / v.rolling(60).mean()).shift(1)
        for d, x in ratio.items():
            if np.isfinite(x):
                out[(sym, d.isoformat() if hasattr(d, "isoformat") else str(d))] = float(x)
    return out


def winkler(lo: float, hi: float, y: float) -> float:
    return (hi - lo) + (2 / ALPHA) * (max(0.0, lo - y) + max(0.0, y - hi))


def study(compare: dict, ratios: dict) -> dict:
    cols = compare.get("cols") or []
    at = {c: i for i, c in enumerate(cols)}
    need = ("day", "p05", "p50", "p95", "ret")
    if not all(c in at for c in need):
        return {"rows": 0}
    rows = []
    for sym, rr in (compare.get("stocks") or {}).items():
        for r in rr:
            d = compare["days"][r[at["day"]]]
            vals = [r[at[c]] for c in ("p05", "p50", "p95", "ret")]
            if any(not isinstance(v, (int, float)) for v in vals):
                continue
            rows.append({"date": d, "track": compare["track"][r[at["day"]]], "sym": sym, "p05": vals[0], "p50": vals[1],
                         "p95": vals[2], "ret": vals[3], "s": min(1.25, max(0.75, ratios.get((sym, d), 1.0)))})
    if not rows:
        return {"rows": 0}
    df = pd.DataFrame(rows).sort_values(["date", "sym"]).reset_index(drop=True)
    df["lo_half"], df["up_half"] = (df["p50"] - df["p05"]) * df["s"], (df["p95"] - df["p50"]) * df["s"]
    # normalised miss: how many scaled half-widths the close was from the middle
    df["z"] = np.where(df["ret"] >= df["p50"], (df["ret"] - df["p50"]) / df["up_half"].clip(lower=1e-6),
                       (df["p50"] - df["ret"]) / df["lo_half"].clip(lower=1e-6))
    days = sorted(df["date"].unique())
    k_by_day = {}
    for i, d in enumerate(days):
        past = df[df["date"].isin(days[max(0, i - WINDOW):i])]
        k_by_day[d] = float(np.quantile(past["z"], 1 - ALPHA)) if len(past) >= 200 else np.nan
    df["k"] = df["date"].map(k_by_day)
    df = df[np.isfinite(df["k"])].copy()
    if df.empty:
        return {"rows": 0}
    df["c_lo"], df["c_hi"] = df["p50"] - df["k"] * df["lo_half"], df["p50"] + df["k"] * df["up_half"]
    df["b_in"] = (df["ret"] >= df["p05"]) & (df["ret"] <= df["p95"])
    df["c_in"] = (df["ret"] >= df["c_lo"]) & (df["ret"] <= df["c_hi"])
    df["b_score"] = [winkler(a, b, y) for a, b, y in zip(df["p05"], df["p95"], df["ret"])]
    df["c_score"] = [winkler(a, b, y) for a, b, y in zip(df["c_lo"], df["c_hi"], df["ret"])]
    diff = score.clustered_mean(list(df["c_score"] - df["b_score"]), list(df["date"]))
    live = df[df["track"] == "live"]
    live_days = int(live["date"].nunique())
    r = lambda x, k=4: round(float(x), k)
    cov_c, cov_live = float(df["c_in"].mean()), (float(live["c_in"].mean()) if len(live) else None)
    reasons = []
    if not 0.89 <= cov_c <= 0.91:
        reasons.append(f"walk-forward coverage {cov_c:.1%} is outside 89-91%")
    if live_days < MIN_LIVE:
        reasons.append(f"only {live_days} of {MIN_LIVE} verified live sessions so far")
    elif cov_live is None or not 0.87 <= cov_live <= 0.93:
        reasons.append(f"live coverage {cov_live:.1%} is outside 87-93%")
    if not (diff.get("ci") and diff["ci"][1] < 0):
        ci = diff.get("ci")
        if ci and ci[0] > 0:
            reasons.append(f"the challenger scores worse (interval score {diff['mean']:+.2f}, 95% interval {ci[0]:+.2f} to {ci[1]:+.2f}; above zero means worse)")
        else:
            reasons.append("the challenger is not better with confidence (its 95% interval includes zero)")
    ready = not reasons
    recent = df[df["date"].isin(days[-20:])]
    return {"rows": int(len(df)), "sessions": int(df["date"].nunique()), "live_sessions": live_days,
            "current": {"coverage": r(df["b_in"].mean()), "avg_width": r((df["p95"] - df["p05"]).mean(), 3), "score": r(df["b_score"].mean(), 3),
                        "coverage_20d": r(recent["b_in"].mean()), "width_20d": r((recent["p95"] - recent["p05"]).mean(), 3)},
            "challenger": {"coverage": r(cov_c), "avg_width": r((df["c_hi"] - df["c_lo"]).mean(), 3), "score": r(df["c_score"].mean(), 3),
                           "coverage_live": None if cov_live is None else r(cov_live)},
            "score_difference": diff, "ready": ready,
            "decision": ("candidate ready: switching needs a new model_version, done by hand" if ready
                         else "keep the current range: " + "; ".join(reasons))}


def run(engine) -> dict:
    path = config.DATA_DIR / "compare.json"
    compare = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    out = {**publish.stamp(engine.mcfg["model_version"]), "preregistered": "2026-11-21",
           "rule": "adopt only with walk-forward coverage 89-91%, live coverage 87-93% on at least 40 verified sessions, "
                   "and a better interval score whose day-clustered 95% interval excludes zero",
           **study(compare, vol_ratio(engine.ds.frames))}
    publish.write_json(config.DATA_DIR / "range_study.json", out, indent=1)
    return out
