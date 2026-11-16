"""The call for one stock and one session (PLAN.md 6.2), driven by measured evidence.

Wording is neutral by design (decision 5): the output describes a setup and
if-then levels, it never says "buy".

A rule's record on one stock is noisy, and with 3 rules x 50 stocks some will
look good by luck. So each stock's record is shrunk toward the record of the
same rule across all stocks before it is judged (empirical-Bayes shrinkage).
"""
from __future__ import annotations

import math

from . import config

FAVOURABLE, NEUTRAL, NO_TRADE = "FAVOURABLE", "NEUTRAL", "NO_TRADE"


def shrink(mean: float, n: int, pooled_mean: float, k: float) -> float:
    if n <= 0 or mean is None or not math.isfinite(mean):
        return pooled_mean
    return (n * mean + k * pooled_mean) / (n + k)


def choose(evidence: dict, pooled: dict, turnover_cr: float, flags: list[str] | None = None,
           cfg: dict | None = None) -> dict:
    """Pick the call.

    evidence: {kind: {"n": trades, "expectancy_r": mean net R, "t_stat": t}}
              built only from trades resolved before the decision.
    pooled:   {kind: mean net R of that rule across all stocks}.
    """
    th = (cfg or config.load_yaml("model.yaml"))["thresholds"]
    flags = list(flags or [])
    table = {}
    for kind, ev in evidence.items():
        n = int(ev.get("n") or 0)
        mean = ev.get("expectancy_r")
        t = ev.get("t_stat")
        table[kind] = {
            "n": n,
            "expectancy_r": None if mean is None or not math.isfinite(mean) else round(mean, 4),
            "shrunk_r": round(shrink(mean, n, pooled.get(kind, 0.0), th["shrink_trades"]), 4),
            "t_stat": None if t is None or not math.isfinite(t) else round(t, 2),
            "enough": n >= th["min_rule_trades"],
        }
    out = {"call": NO_TRADE, "kind": None, "reference_kind": None, "label": "",
           "reasons": [], "evidence": table}
    if table:
        out["reference_kind"] = max(table, key=lambda k: table[k]["shrunk_r"])

    if turnover_cr is None or not math.isfinite(turnover_cr) or turnover_cr < th["min_turnover_cr"]:
        out["label"] = "illiquid"
        out["reasons"].append("Average turnover is below the liquidity gate, so no plan is issued.")
        return out
    if flags:
        out["label"] = "data flag"
        out["reasons"] += flags
        return out

    judged = {k: v for k, v in table.items() if v["enough"]}
    if not judged:
        out["label"] = "not enough history"
        out["reasons"].append("No rule has enough past trades on this stock to be judged.")
        return out
    best = max(judged, key=lambda k: judged[k]["shrunk_r"])
    rec = judged[best]
    if rec["shrunk_r"] <= 0:
        out["label"] = "no tested edge"
        out["reasons"].append(
            "After costs, none of the tested rules has made money on this stock. "
            "Levels are shown for reference only.")
        return out

    out["kind"] = best
    if rec["t_stat"] is not None and rec["t_stat"] >= th["supported_t"]:
        out["call"], out["label"] = FAVOURABLE, "supported"
        out["reasons"].append("This rule's past record on this stock is positive after costs "
                              "and unlikely to be luck alone.")
    else:
        out["call"], out["label"] = NEUTRAL, "weak evidence"
        out["reasons"].append("This rule's past record on this stock is slightly positive after "
                              "costs, but the evidence is weak and could be luck.")
    return out
