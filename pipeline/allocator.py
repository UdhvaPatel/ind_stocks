"""Weekly allocator (portfolio v2, SHADOW ONLY until it earns promotion).

For every stock, session and rule it predicts, from information known before the open:
  P(trigger)            logistic regression
  E[net R | triggered]  ridge regression on net R (after costs), clipped at +-3 R
and takes a plan only when the expected value P x E[R] is above a threshold, sized by a capped
quarter-Kelly fraction (config/portfolio.yaml, allocator:). Otherwise it holds cash.

Evaluation (every Sunday, run_weekly): a walk-forward over the backtest replays with a refit for
every week on data from before that Monday only. Its daily rupee P&L is compared with doing
nothing and with the simple Desk rules (portfolio v1) on the same days, with Newey-West t-stats.
The fitted weights are saved in data/allocator.json; each morning `shadow_orders` writes the
allocator's choices as a separate "allocator" book in the paper portfolio. It never drives the
headline Desk book automatically: promotion needs the walk-forward gate, 60 verified shadow
sessions inside its backtest band, and a new portfolio_version (PLAN.md 15.3).
"""
from __future__ import annotations

import json
import math
from datetime import date, timedelta

import numpy as np

from . import config, costs, publish
from .decide import FAVOURABLE, NEUTRAL

RULES = ("breakout", "pullback", "gap_reversal")
TRADED = ("stopped", "t1", "t2", "time")
FEATURES = ["p_up", "close_mid", "close_width", "gap_mid", "range_mid", "health", "entry_dist", "risk_pct",
            "p_trigger", "shrunk_r", "weekday"]


def report_path():
    return config.DATA_DIR / "allocator.json"


def load_report() -> dict | None:
    try:
        return json.loads(report_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


# ---------------------------------------------------------------- features
def features(claims: dict | None, lv: dict, prev: float | None, health, shrunk_r, day: str) -> list[float] | None:
    """Everything here is known before the open. None when the levels are unusable."""
    try:
        entry, risk = float(lv["entry"]), float(lv.get("risk") or (float(lv["entry"]) - float(lv["stop"])))
        prev = float(prev)
    except (KeyError, TypeError, ValueError):
        return None
    if not (entry > 0 and risk > 0 and prev > 0):
        return None
    c = claims or {}
    cl, gp, rg = c.get("close") or {}, c.get("gap") or {}, c.get("range") or {}
    num = lambda x, d=0.0: float(x) if isinstance(x, (int, float)) and math.isfinite(x) else d
    return [num((c.get("dir") or {}).get("p_up"), 0.5), num(cl.get("p50")), num(cl.get("p95")) - num(cl.get("p05")),
            num(gp.get("p50")), num(rg.get("p50")), num(health, 50.0) / 100.0, (entry / prev - 1) * 100, risk / entry * 100,
            num(lv.get("p_trigger"), 0.3), num(shrunk_r, -0.2), float(date.fromisoformat(day).weekday())]


def rows_from_scores(scores: list[dict]) -> dict[str, dict]:
    """Training rows per rule from the walk-forward scores: X, triggered, net R, outcome, levels."""
    out = {k: {"X": [], "trig": [], "r": [], "day": [], "sym": [], "outcome": [], "lv": [], "called": []} for k in RULES}
    for s in scores:
        if s.get("status") != "scored":
            continue
        call = s.get("call") or {}
        for kind in RULES:
            oc = (s.get("plans") or {}).get(kind)
            lv = (s.get("plan_levels") or {}).get(kind)
            if not oc or not lv or oc.get("status") in ("none", "pending"):
                continue
            ev = ((s.get("evidence") or {}).get(kind) or {}).get("shrunk_r")
            x = features(s.get("claims"), lv, s.get("prev_close"), s.get("setup"), ev, s["for_date"])
            if x is None:
                continue
            trig = oc.get("status") in TRADED and isinstance(oc.get("r"), (int, float))
            d = out[kind]
            d["X"].append(x); d["trig"].append(trig); d["r"].append(float(oc["r"]) if trig else np.nan)
            d["day"].append(s["for_date"]); d["sym"].append(s["symbol"]); d["outcome"].append(oc); d["lv"].append(lv)
            d["called"].append(call.get("call") in (FAVOURABLE, NEUTRAL) and call.get("kind") == kind)
    for d in out.values():
        d["X"] = np.array(d["X"], dtype=float).reshape(-1, len(FEATURES)); d["trig"] = np.array(d["trig"], dtype=bool)
        d["r"] = np.array(d["r"], dtype=float); d["day"] = np.array(d["day"])
    return out


# ------------------------------------------------------------------ models
def fit(X: np.ndarray, trig: np.ndarray, r: np.ndarray) -> dict | None:
    from sklearn.linear_model import LogisticRegression, Ridge
    if len(X) < 50 or trig.sum() < 30 or trig.all():
        return None
    mu, sd = X.mean(axis=0), X.std(axis=0)
    sd[sd == 0] = 1.0
    Z = (X - mu) / sd
    lg = LogisticRegression(C=0.5, max_iter=500).fit(Z, trig)
    rr = np.clip(r[trig], -3, 3)
    rd = Ridge(alpha=50.0).fit(Z[trig], rr)
    resid = rr - rd.predict(Z[trig])
    return {"mu": mu.tolist(), "sd": sd.tolist(), "lg_coef": lg.coef_[0].tolist(), "lg_b": float(lg.intercept_[0]),
            "rd_coef": rd.coef_.tolist(), "rd_b": float(rd.intercept_), "r_var": float(max(np.var(resid), 1e-4)),
            "n": int(len(X)), "trades": int(trig.sum())}


def predict(m: dict, X: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    Z = (np.asarray(X, dtype=float) - np.array(m["mu"])) / np.array(m["sd"])
    p = 1 / (1 + np.exp(-(Z @ np.array(m["lg_coef"]) + m["lg_b"])))
    er = Z @ np.array(m["rd_coef"]) + m["rd_b"]
    return p, er


def choose(cands: list[dict], c: dict) -> list[dict]:
    """Candidates {symbol, kind, ev, er, r_var, lv}: the allocator's book for one session."""
    a, cap = c["allocator"], float(c["capital"])
    per_trade_cap = cap * a["max_risk_per_trade_pct"] / 100
    day_cap, used_risk, budget = cap * a["max_risk_per_day_pct"] / 100, 0.0, cap
    out, used = [], set()
    for x in sorted((x for x in cands if x["ev"] > a["ev_threshold_r"]), key=lambda x: (-x["ev"], x["symbol"])):
        if len(out) >= c["max_positions"] or x["symbol"] in used:
            continue
        lv = x["lv"]
        entry, risk_ps = float(lv["entry"]), float(lv.get("risk") or (float(lv["entry"]) - float(lv["stop"])))
        kelly = max(0.0, x["er"]) / max(x["r_var"], 1e-4)                # Kelly: share of capital to put at risk
        risk_rs = min(per_trade_cap, a["kelly_fraction"] * kelly * cap, day_cap - used_risk)
        n = math.floor(min(risk_rs / risk_ps, cap * c["max_position_pct"] / entry)) if risk_ps > 0 else 0
        if n <= 0 or n * entry > budget:
            continue
        used.add(x["symbol"]); budget -= n * entry; used_risk += n * risk_ps
        out.append({"symbol": x["symbol"], "kind": x["kind"], "shares": n, "entry": lv["entry"], "stop": lv["stop"],
                    "t1": lv.get("t1"), "t2": lv.get("t2"), "ev_r": round(x["ev"], 4), "record_id": x.get("record_id")})
    return out


def pnl_of(book: list[dict], outcomes: dict, ccfg: dict) -> float:
    total = 0.0
    for o in book:
        oc = outcomes.get((o["symbol"], o["kind"])) or {}
        if oc.get("status") in TRADED and isinstance(oc.get("fill"), (int, float)) and isinstance(oc.get("exit"), (int, float)):
            n, f, e = o["shares"], oc["fill"], oc["exit"]
            total += n * (e - f) - float(costs.charges(n * f, n * e, ccfg))
    return total


def monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


# ------------------------------------------------------------ walk-forward
def walk_forward(scores: list[dict], c: dict, ccfg: dict, log=print) -> dict:
    from .portfolio import size
    from .research import newey_west_t
    data = rows_from_scores(scores)
    by_day: dict[str, dict] = {}
    for kind, d in data.items():
        for i in range(len(d["day"])):
            by_day.setdefault(d["day"][i], []).append((kind, i))
    days = sorted(by_day)
    if not days:
        return {"weeks": 0}
    weeks = sorted({monday(date.fromisoformat(x)) for x in days})
    min_trades = c["allocator"]["min_training_trades"]
    daily = []
    for w in weeks:
        models = {}
        for kind, d in data.items():
            past = d["day"] < w.isoformat()
            if d["trig"][past].sum() >= min_trades:
                models[kind] = fit(d["X"][past], d["trig"][past], d["r"][past])
        week_days = [x for x in days if monday(date.fromisoformat(x)) == w]
        if not any(models.values()):
            continue
        for day in week_days:
            cands, outcomes, v1 = [], {}, []
            for kind, i in by_day[day]:
                d = data[kind]
                outcomes[(d["sym"][i], kind)] = d["outcome"][i]
                m = models.get(kind)
                if m:
                    p, er = predict(m, d["X"][i:i + 1])
                    cands.append({"symbol": d["sym"][i], "kind": kind, "ev": float(p[0] * er[0]), "er": float(er[0]),
                                  "r_var": m["r_var"], "lv": d["lv"][i]})
                if d["called"][i]:
                    v1.append((float(d["X"][i][FEATURES.index("shrunk_r")]), d["sym"][i], kind, d["lv"][i]))
            book = choose(cands, c)
            v1_book, used, budget = [], set(), float(c["capital"])          # portfolio v1 on the same day
            for _, sym, kind, lv in sorted(v1, key=lambda x: (-x[0], x[1])):
                n = size(lv, c)
                if len(v1_book) >= c["max_positions"] or sym in used or n <= 0 or n * float(lv["entry"]) > budget:
                    continue
                used.add(sym); budget -= n * float(lv["entry"])
                v1_book.append({"symbol": sym, "kind": kind, "shares": n})
            daily.append({"date": day, "alloc": pnl_of(book, outcomes, ccfg), "v1": pnl_of(v1_book, outcomes, ccfg),
                          "positions": len(book)})
    if log:
        log(f"allocator walk-forward: {len(daily)} sessions over {len(weeks)} weeks")
    if not daily:
        return {"weeks": len(weeks), "sessions": 0}
    a = np.array([x["alloc"] for x in daily]); v = np.array([x["v1"] for x in daily])
    t_cash, t_v1 = newey_west_t(a, 5), newey_west_t(a - v, 5)
    gate = c["allocator"]["promotion_t"]
    passed = bool(a.mean() > 0 and (t_cash or 0) >= gate and (t_v1 or 0) >= gate)
    cum, curve = 0.0, []
    for x in daily:
        cum += x["alloc"]
        curve.append([x["date"], round(cum, 2)])
    return {"weeks": len(weeks), "sessions": len(daily), "from": daily[0]["date"], "to": daily[-1]["date"],
            "mean_daily_pnl": round(float(a.mean()), 2), "total_pnl": round(float(a.sum()), 2),
            "v1_total_pnl": round(float(v.sum()), 2), "active_share": round(float(np.mean([x["positions"] > 0 for x in daily])), 3),
            "t_vs_cash": None if t_cash is None or not math.isfinite(t_cash) else round(t_cash, 2),
            "t_vs_v1": None if t_v1 is None or not math.isfinite(t_v1) else round(t_v1, 2),
            "passed_walk_forward": passed, "curve": curve[-250:]}


def train(engine, scores: list[dict], shadow_sessions: int = 0, log=print) -> dict:
    """Sunday: walk-forward evaluation, then fit on all history and save the weights."""
    from .portfolio import cfg as pcfg
    c = pcfg()
    wf = walk_forward(scores, c, engine.ccfg, log=log)
    data = rows_from_scores(scores)
    weights = {k: fit(d["X"], d["trig"], d["r"]) for k, d in data.items()
               if d["trig"].sum() >= c["allocator"]["min_training_trades"]}
    weights = {k: v for k, v in weights.items() if v}
    need = c["allocator"]["shadow_days_before_promotion"]
    eligible = bool(wf.get("passed_walk_forward")) and shadow_sessions >= need
    status = ("eligible for promotion (needs a new portfolio_version)" if eligible
              else "shadow: failed the walk-forward test, so it is shown for information only" if not wf.get("passed_walk_forward")
              else f"shadow: {shadow_sessions} of {need} verified sessions")
    out = {**publish.stamp(engine.mcfg["model_version"]), "features": FEATURES, "weights": weights,
           "trained_on": {"from": min((s["for_date"] for s in scores), default=None), "to": max((s["for_date"] for s in scores), default=None),
                          "trades": {k: v["trades"] for k, v in weights.items()}},
           "walk_forward": wf, "shadow_sessions": shadow_sessions, "shadow_needed": need, "status": status,
           "rules": {"ev_threshold_r": c["allocator"]["ev_threshold_r"], "kelly_fraction": c["allocator"]["kelly_fraction"],
                     "max_risk_per_trade_pct": c["allocator"]["max_risk_per_trade_pct"], "max_risk_per_day_pct": c["allocator"]["max_risk_per_day_pct"]},
           "next_training": (monday(config.today_ist()) + timedelta(days=7)).isoformat()}
    publish.write_json(report_path(), out, indent=1)
    return out


# ------------------------------------------------------------------ shadow
def shadow_orders(records: list[dict], c: dict) -> list[dict] | None:
    """The allocator's book for today's ledger records, or None if it has not been trained yet."""
    rep = load_report()
    if not rep or not rep.get("weights"):
        return None
    cands = []
    for rec in records:
        for kind, m in rep["weights"].items():
            lv = (rec.get("plans") or {}).get(kind)
            if not lv:
                continue
            x = features(rec.get("claims"), lv, ((rec.get("inputs") or {}).get("prev") or {}).get("close"),
                         (rec.get("inputs") or {}).get("setup"), ((rec.get("evidence") or {}).get(kind) or {}).get("shrunk_r"), rec["for_date"])
            if x is None:
                continue
            p, er = predict(m, [x])
            cands.append({"symbol": rec["symbol"], "kind": kind, "ev": float(p[0] * er[0]), "er": float(er[0]),
                          "r_var": m["r_var"], "lv": lv, "record_id": rec["id"]})
    return choose(cands, c)
