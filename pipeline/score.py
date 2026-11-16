"""Scoring (PLAN.md 7.2-7.4): resolve each record against what happened, then aggregate.

Every claim in a ledger record is checked against the session's official bar:
  direction  -> Brier score against the base rate
  close/gap  -> was the outcome inside the predicted 90% range (coverage), pinball loss
  range      -> was the high-low range under the predicted 90th percentile
  touch      -> predicted probability vs whether the level was touched (calibration)
  plans      -> not triggered / stopped / target / time exit, in R after costs,
                next to a naive "buy at every open" rule and to not trading (zero)

Aggregation never hides small samples: every rate carries its count and a
Wilson interval, and pooled means carry a day-clustered bootstrap interval,
because stocks on the same day move together and are not independent.
"""
from __future__ import annotations

import math
from collections import defaultdict

import numpy as np

from . import costs, plans

MIN_N = 30                      # below this the UI shows "too early"
BOOT_RESAMPLES = 1000
BOOT_SEED = 20261115


# ------------------------------------------------------------------ resolving
def pinball(q_lo: float, q_hi: float, y: float, alpha: float = 0.10) -> float:
    """Interval (Winkler) score for a central (1-alpha) range: lower is better."""
    width = q_hi - q_lo
    if y < q_lo:
        return width + 2 / alpha * (q_lo - y)
    if y > q_hi:
        return width + 2 / alpha * (y - q_hi)
    return width


def resolve(record: dict, bar: dict | None, void_reason: str | None = None,
            cost_cfg: dict | None = None, plan_results: dict | None = None) -> dict:
    """Score one ledger record against the session bar {open, high, low, close}.

    `plan_results` lets the caller supply outcomes from the 5-minute replay;
    otherwise the conservative daily-bar rules are used.
    """
    out = {"id": record["id"], "symbol": record["symbol"], "for_date": record["for_date"],
           "model_version": record["model_version"], "call": record["call"]}
    if bar is None or void_reason:
        out.update({"status": "void", "reason": void_reason or "no official session"})
        return out

    prev = record["inputs"]["prev"]["close"]
    o, h, l, c = (float(bar[k]) for k in ("open", "high", "low", "close"))
    ret = (c / prev - 1) * 100
    gap = (o / prev - 1) * 100
    rng = (h - l) / prev * 100
    out.update({"status": "scored",
                "actual": {"open": o, "high": h, "low": l, "close": c, "ret_pct": round(ret, 3),
                           "gap_pct": round(gap, 3), "range_pct": round(rng, 3)}})

    cl = record.get("claims")
    if cl:
        up = ret > 0
        p, base = cl["dir"]["p_up"], cl["dir"]["base_p_up"]
        out["dir"] = {"up": up, "p_up": p, "brier": round((p - up) ** 2, 5),
                      "brier_base": round((base - up) ** 2, 5),
                      "correct": (p > 0.5) == up}
        b = cl["baseline_close"]
        out["close"] = {"inside": cl["close"]["p05"] <= ret <= cl["close"]["p95"],
                        "width": round(cl["close"]["p95"] - cl["close"]["p05"], 3),
                        "pinball": round(pinball(cl["close"]["p05"], cl["close"]["p95"], ret), 4),
                        "pinball_base": round(pinball(b["p05"], b["p95"], ret), 4),
                        "inside_base": b["p05"] <= ret <= b["p95"]}
        out["gap"] = {"inside": cl["gap"]["p05"] <= gap <= cl["gap"]["p95"]}
        out["range"] = {"inside": rng <= cl["range"]["p90"]}
        out["touch"] = [{"name": t["name"], "p": t["p"],
                         "hit": (h >= t["level"]) if t["side"] == "up" else (l <= t["level"])}
                        for t in cl["touch"]]

    slip = record["inputs"].get("slippage", 0.0005)
    ccfg = cost_cfg or costs.cost_cfg()
    out["plans"] = {}
    for kind, lv in record.get("plans", {}).items():
        res = (plan_results or {}).get(kind) or plans.resolve_one(kind, lv, bar, slip, ccfg)
        out["plans"][kind] = dict(res)
    out["baseline"] = plans.open_to_close_baseline(record["inputs"]["atr"], bar, slip, ccfg)
    return out


# ---------------------------------------------------------------- statistics
def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float] | None:
    """Wilson score interval for a proportion."""
    if n <= 0:
        return None
    p = k / n
    den = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return (round(max(0.0, centre - half), 4), round(min(1.0, centre + half), 4))


def rate(k: int, n: int) -> dict:
    ci = wilson(k, n)
    return {"n": int(n), "k": int(k), "rate": round(k / n, 4) if n else None,
            "ci": ci, "too_early": n < MIN_N}


def clustered_mean(values: list[float], days: list[str]) -> dict:
    """Mean with a day-clustered bootstrap 95% interval."""
    if not values:
        return {"n": 0, "days": 0, "mean": None, "ci": None, "too_early": True}
    by_day = defaultdict(list)
    for v, d in zip(values, days):
        by_day[d].append(v)
    sums = np.array([sum(v) for v in by_day.values()])
    counts = np.array([len(v) for v in by_day.values()], dtype=float)
    mean = float(sums.sum() / counts.sum())
    ci = None
    if len(sums) >= 5:
        rng = np.random.default_rng(BOOT_SEED)
        pick = rng.integers(0, len(sums), size=(BOOT_RESAMPLES, len(sums)))
        boots = sums[pick].sum(axis=1) / counts[pick].sum(axis=1)
        ci = (round(float(np.percentile(boots, 2.5)), 4), round(float(np.percentile(boots, 97.5)), 4))
    return {"n": len(values), "days": len(sums), "mean": round(mean, 4), "ci": ci,
            "too_early": len(values) < MIN_N}


def calibration(pairs: list[tuple[float, bool]], edges=(0, .1, .2, .3, .4, .5, .6, .7, .8, .9, 1.0001)) -> list[dict]:
    """Predicted probability vs realised frequency, in bins."""
    out = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        sel = [(p, y) for p, y in pairs if lo <= p < hi]
        if not sel:
            continue
        k = sum(1 for _, y in sel if y)
        out.append({"bin": [round(lo, 2), round(min(hi, 1.0), 2)], "n": len(sel),
                    "predicted": round(float(np.mean([p for p, _ in sel])), 4),
                    "realised": round(k / len(sel), 4), "ci": wilson(k, len(sel))})
    return out


def skill(loss: float, loss_base: float) -> float | None:
    """1 - loss/baseline loss. Above 0 means better than the baseline."""
    if loss_base is None or loss_base <= 0:
        return None
    return round(1 - loss / loss_base, 4)


# --------------------------------------------------------------- aggregation
def aggregate(scores: list[dict]) -> dict:
    """Scoreboard for a list of resolved records (one model version, one track)."""
    scored = [s for s in scores if s.get("status") == "scored"]
    out = {"records": len(scores), "scored": len(scored),
           "void": len(scores) - len(scored),
           "days": len({s["for_date"] for s in scored}),
           "first": min((s["for_date"] for s in scored), default=None),
           "last": max((s["for_date"] for s in scored), default=None)}
    with_claims = [s for s in scored if "dir" in s]
    days = [s["for_date"] for s in with_claims]

    # Direction
    n = len(with_claims)
    if n:
        ups = sum(s["dir"]["up"] for s in with_claims)
        brier = float(np.mean([s["dir"]["brier"] for s in with_claims]))
        brier_base = float(np.mean([s["dir"]["brier_base"] for s in with_claims]))
        out["direction"] = {
            "hit": rate(sum(s["dir"]["correct"] for s in with_claims), n),
            "up_share": rate(ups, n),
            "always_up_hit": round(ups / n, 4),
            "brier": round(brier, 5), "brier_base": round(brier_base, 5),
            "skill": skill(brier, brier_base),
            "skill_days": clustered_mean(
                [s["dir"]["brier_base"] - s["dir"]["brier"] for s in with_claims], days),
            "calibration": calibration([(s["dir"]["p_up"], s["dir"]["up"]) for s in with_claims],
                                       edges=(0, .40, .45, .48, .50, .52, .55, .60, 1.0001)),
        }
        # Ranges
        pin = float(np.mean([s["close"]["pinball"] for s in with_claims]))
        pin_base = float(np.mean([s["close"]["pinball_base"] for s in with_claims]))
        out["ranges"] = {
            "target": 0.90,
            "close": rate(sum(s["close"]["inside"] for s in with_claims), n),
            "close_baseline": rate(sum(s["close"]["inside_base"] for s in with_claims), n),
            "gap": rate(sum(s["gap"]["inside"] for s in with_claims), n),
            "session_range": rate(sum(s["range"]["inside"] for s in with_claims), n),
            "avg_width": round(float(np.mean([s["close"]["width"] for s in with_claims])), 3),
            "interval_score": round(pin, 4), "interval_score_base": round(pin_base, 4),
            "skill": skill(pin, pin_base),
        }
        # Touch levels
        pairs = [(t["p"], t["hit"]) for s in with_claims for t in s["touch"]]
        brier_t = float(np.mean([(p - y) ** 2 for p, y in pairs]))
        freq = float(np.mean([y for _, y in pairs]))
        out["touch"] = {"n": len(pairs), "brier": round(brier_t, 5),
                        "skill_vs_constant": skill(brier_t, freq * (1 - freq)),
                        "calibration": calibration(pairs)}

    # Plans: every tracked rule, and separately the plans the tool actually called.
    def plan_block(items: list[tuple[dict, str]]) -> dict:
        issued = [(p, d) for p, d in items if p["status"] not in ("none",)]
        traded = [(p, d) for p, d in issued if p["status"] in plans.TRADED and p["r"] is not None]
        block = {"plans": len(issued), "trades": len(traded),
                 "trigger": rate(len(traded), len(issued))}
        if traded:
            rs = [p["r"] for p, _ in traded]
            ds_ = [d for _, d in traded]
            block["win"] = rate(sum(r > 0 for r in rs), len(rs))
            block["mean_r"] = clustered_mean(rs, ds_)
            block["total_r"] = round(float(sum(rs)), 2)
            block["outcomes"] = {k: sum(1 for p, _ in traded if p["status"] == k)
                                 for k in ("stopped", "t1", "t2", "time")}
            by_day = defaultdict(float)
            for p, d in traded:
                by_day[d] += p["r"]
            cum, curve = 0.0, []
            for d in sorted(by_day):
                cum += by_day[d]
                curve.append([d, round(cum, 2)])
            block["equity_r"] = curve
        return block

    out["rules"] = {}
    for kind in plans.KINDS:
        items = [(s["plans"][kind], s["for_date"]) for s in scored if kind in s.get("plans", {})]
        out["rules"][kind] = plan_block(items)
    called = [(s["plans"][s["call"]["kind"]], s["for_date"]) for s in scored
              if s["call"].get("kind") and s["call"]["kind"] in s.get("plans", {})]
    out["called"] = plan_block(called)
    out["baseline"] = plan_block([(s["baseline"], s["for_date"]) for s in scored if "baseline" in s])
    calls = defaultdict(int)
    for s in scored:
        calls[s["call"]["call"]] += 1
    out["calls"] = dict(calls)
    return out


def by_symbol(scores: list[dict]) -> dict:
    """Compact per-stock view: where the tool works and where it does not."""
    groups = defaultdict(list)
    for s in scores:
        if s.get("status") == "scored" and "dir" in s:
            groups[s["symbol"]].append(s)
    out = {}
    for sym, items in sorted(groups.items()):
        n = len(items)
        out[sym] = {
            "n": n,
            "dir_hit": round(sum(s["dir"]["correct"] for s in items) / n, 4),
            "coverage": round(sum(s["close"]["inside"] for s in items) / n, 4),
            "too_early": n < MIN_N,
        }
    return out
