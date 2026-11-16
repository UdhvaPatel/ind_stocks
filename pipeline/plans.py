"""One-session trade plans (PLAN.md 6.2-6.4): levels, fills and outcomes.

A plan made after the close of session t is for session t+1 only. It is a set
of pre-committed levels (entry, stop, two targets), cancelled at 14:30 if not
triggered and closed at 15:15 at the latest. Long-only in v1.

Three plan types:
  breakout     : stop-buy above the previous session's high
  pullback     : limit-buy on a dip toward the pivot support
  gap_reversal : buy at the open after a large gap down, target = the gap closes

`simulate` replays a plan against the next session's DAILY bar with
deliberately conservative assumptions (the stop is assumed to come first
whenever the bar alone cannot prove otherwise). The live ledger uses archived
5-minute bars instead (replay.py), which settles the order of events exactly.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from . import config, costs

KINDS = ["breakout", "pullback", "gap_reversal"]
STATUS = ["none", "pending", "cancelled", "not_triggered", "stopped", "t1", "t2", "time"]
TRADED = {"stopped", "t1", "t2", "time"}


def model_cfg() -> dict:
    return config.load_yaml("model.yaml")


# ------------------------------------------------------------------- levels
def plan_levels(df: pd.DataFrame, feat: pd.DataFrame, kind: str, cfg: dict | None = None) -> pd.DataFrame:
    """Entry, stop and targets for the session AFTER each row (unrounded prices)."""
    p = (cfg or model_cfg())["plans"][kind]
    atr = feat["atr_14"]
    c, h, l = df["close"], df["high"], df["low"]
    if kind == "breakout":
        entry = h + p["trigger_atr"] * atr
        dist = np.minimum(p["stop_atr"] * atr, entry - (l - 0.05 * atr))
        dist = np.maximum(dist, p["min_stop_atr"] * atr)
    elif kind == "pullback":
        s1 = 2 * (h + l + c) / 3 - h
        entry = np.minimum(np.maximum(s1, c - p["max_atr"] * atr), c - p["min_atr"] * atr)
        dist = p["stop_atr"] * atr
    elif kind == "gap_reversal":
        # "entry" is the highest opening price that triggers the plan; the real
        # fill is the open itself, and the stop sits `risk` below that fill.
        entry = c - p["gap_atr"] * atr
        dist = p["stop_atr"] * atr
        out = pd.DataFrame({"entry": entry, "stop": entry - dist, "t1": c, "t2": c,
                            "risk": dist, "floor": c - p["max_gap_atr"] * atr}, index=df.index)
        out[atr.isna() | (atr <= 0)] = np.nan
        return out
    else:
        raise ValueError(kind)
    out = pd.DataFrame({"entry": entry, "stop": entry - dist,
                        "t1": entry + p["t1_r"] * dist, "t2": entry + p["t2_r"] * dist,
                        "risk": dist}, index=df.index)
    out[atr.isna() | (atr <= 0)] = np.nan
    return out


# --------------------------------------------------------------- simulation
def simulate(df: pd.DataFrame, lv: pd.DataFrame, kind: str, slip, cost_cfg: dict | None = None) -> pd.DataFrame:
    """Outcome of each row's plan on the next session's daily bar.

    `slip` is the slippage fraction per side (scalar or array aligned to df).
    Returned columns: status, fill, exit, r (net of all costs, in units of the
    planned risk per share), r_gross, ret_pct (net % on capital deployed),
    ambiguous (stop and entry inside the same bar).
    """
    ccfg = cost_cfg or costs.cost_cfg()
    n = len(df)
    nxt = lambda col: np.r_[df[col].values[1:].astype(float), np.nan]
    o, h, l, c = nxt("open"), nxt("high"), nxt("low"), nxt("close")
    entry, stop, t1, t2 = (lv[k].values.astype(float) for k in ("entry", "stop", "t1", "t2"))
    risk = lv["risk"].values.astype(float)
    slip = np.broadcast_to(np.asarray(slip, dtype=float), (n,)).copy()
    slip_stop = slip * ccfg["slippage"]["stop_exit_multiplier"]

    has_plan = np.isfinite(entry) & np.isfinite(stop) & (risk > 0)
    known = np.isfinite(o) & np.isfinite(c)
    with np.errstate(invalid="ignore"):
        if kind == "breakout":
            cancelled = (o <= stop) | (o >= t1)            # gap through the stop, or past the first target
            triggered = (h >= entry) & ~cancelled
            fill = np.maximum(entry, o) * (1 + slip)       # stop-buy: fills at the open if it gaps over
            stopped = triggered & (l <= stop)              # conservative: stop first
            hit2 = triggered & ~stopped & (h >= t2)
            hit1 = triggered & ~stopped & ~hit2 & (h >= t1)
        elif kind == "gap_reversal":
            floor = lv["floor"].values.astype(float)
            cancelled = o < floor                          # too large a gap: treated as news
            triggered = (o <= entry) & ~cancelled
            fill = o * (1 + slip)                          # market order at the open
            stop = fill - risk                             # stop follows the real fill
            stopped = triggered & (l <= stop)              # conservative: stop first
            hit2 = triggered & ~stopped & (h >= t1)        # single target: the gap closes
            hit1 = np.zeros(n, dtype=bool)
        else:
            cancelled = o <= stop                          # gap below the stop
            triggered = (l <= entry) & ~cancelled
            fill = np.minimum(entry, o)                    # limit-buy: no slippage, better if it gaps under
            stopped = triggered & (l <= stop)
            # After a dip-buy the daily high may have come BEFORE the fill, so a
            # target only counts when the close itself is beyond it.
            hit2 = triggered & ~stopped & (c >= t2)
            hit1 = triggered & ~stopped & ~hit2 & (c >= t1)
        ambiguous = triggered & (l <= stop)

    time_exit = c * (1 - slip)
    exit_ = np.where(stopped, stop * (1 - slip_stop),
             np.where(hit2, t2,
              np.where(hit1, 0.5 * t1 + 0.5 * time_exit, time_exit)))

    status = np.full(n, "none", dtype=object)
    status[has_plan & ~known] = "pending"
    live = has_plan & known
    status[live & cancelled] = "cancelled"
    status[live & ~cancelled & ~triggered] = "not_triggered"
    traded = live & triggered
    status[traded] = "time"
    status[traded & hit1] = "t1"
    status[traded & hit2] = "t2"
    status[traded & stopped] = "stopped"

    # Costs at the reference account: shares sized by risk, capped by capital.
    ref = ccfg["reference"]
    risk_rs = ref["capital"] * ref["risk_pct"] / 100.0
    with np.errstate(invalid="ignore", divide="ignore"):
        shares = np.floor(np.minimum(risk_rs / risk, ref["capital"] / fill))
        shares = np.where(traded & np.isfinite(shares), np.maximum(shares, 0), 0.0)
        buy_val, sell_val = shares * fill, shares * exit_
        charge = np.where(shares > 0, costs.charges(np.nan_to_num(buy_val), np.nan_to_num(sell_val), ccfg), 0.0)
        gross = shares * (exit_ - fill)
        r_gross = np.where(shares > 0, (exit_ - fill) / risk, np.nan)
        r_net = np.where(shares > 0, (gross - charge) / (shares * risk), np.nan)
        ret_pct = np.where(shares > 0, (gross - charge) / buy_val * 100, np.nan)

    out = pd.DataFrame({"status": status, "fill": np.where(traded, fill, np.nan),
                        "exit": np.where(traded, exit_, np.nan), "r": r_net, "r_gross": r_gross,
                        "ret_pct": ret_pct, "ambiguous": traded & ambiguous}, index=df.index)
    out.loc[out["status"].isin(["none", "pending", "cancelled", "not_triggered"]),
            ["r", "r_gross", "ret_pct"]] = np.nan
    return out


# ------------------------------------------------------------ tick rounding
def tick_size(price: float, cfg: dict | None = None) -> float:
    for row in (cfg or model_cfg())["ticks"]:
        if price < row["below"]:
            return row["tick"]
    return 0.05


def round_tick(price: float, direction: str = "nearest", cfg: dict | None = None) -> float:
    tick = tick_size(price, cfg)
    q = price / tick
    n = {"up": math.ceil(q - 1e-9), "down": math.floor(q + 1e-9)}.get(direction, round(q))
    return round(n * tick, 2)


def round_plan(levels: dict, kind: str, cfg: dict | None = None) -> dict:
    """Round to valid ticks without making the plan more optimistic."""
    entry = round_tick(levels["entry"], "up" if kind == "breakout" else "down", cfg)
    stop = round_tick(levels["stop"], "down", cfg)
    if stop >= entry:
        stop = round_tick(entry - tick_size(entry, cfg), "down", cfg)
    t1 = max(round_tick(levels["t1"], "down", cfg), round_tick(entry + tick_size(entry, cfg), "up", cfg))
    t2 = max(round_tick(levels["t2"], "down", cfg), t1)
    return {"entry": entry, "stop": stop, "t1": t1, "t2": t2, "risk": round(entry - stop, 2)}


def position(entry: float, stop: float, capital: float, risk_pct: float) -> dict:
    """Whole shares sized so that hitting the stop loses risk_pct of capital."""
    risk_ps = entry - stop
    if risk_ps <= 0 or entry <= 0:
        return {"shares": 0, "value": 0.0, "risk_rs": 0.0, "capped": False}
    by_risk = math.floor(capital * risk_pct / 100.0 / risk_ps)
    by_cash = math.floor(capital / entry)
    shares = max(0, min(by_risk, by_cash))
    return {"shares": shares, "value": round(shares * entry, 2),
            "risk_rs": round(shares * risk_ps, 2), "capped": by_cash < by_risk}


# ------------------------------------------------- single-plan resolution
def resolve_one(kind: str, lv: dict, bar: dict, slip: float, cost_cfg: dict | None = None) -> dict:
    """Outcome of one recorded plan on one session's bar (open, high, low, close).

    Same rules as `simulate` (the test suite checks they agree), written for a
    single plan so the ledger scorer and the walk-forward can call it cheaply.
    """
    ccfg = cost_cfg or costs.cost_cfg()
    o, h, l, c = (float(bar[k]) for k in ("open", "high", "low", "close"))
    entry, stop, t1, t2, risk = (float(lv[k]) for k in ("entry", "stop", "t1", "t2", "risk"))
    slip_stop = slip * ccfg["slippage"]["stop_exit_multiplier"]
    res = {"status": "not_triggered", "fill": None, "exit": None, "r": None, "r_gross": None,
           "ret_pct": None, "ambiguous": False}
    if not (risk > 0):
        res["status"] = "none"
        return res

    if kind == "breakout":
        if o <= stop or o >= t1:
            res["status"] = "cancelled"
            return res
        if h < entry:
            return res
        fill = max(entry, o) * (1 + slip)
        stopped = l <= stop
        hit2 = not stopped and h >= t2
        hit1 = not stopped and not hit2 and h >= t1
    elif kind == "pullback":
        if o <= stop:
            res["status"] = "cancelled"
            return res
        if l > entry:
            return res
        fill = min(entry, o)
        stopped = l <= stop
        hit2 = not stopped and c >= t2
        hit1 = not stopped and not hit2 and c >= t1
    elif kind == "gap_reversal":
        if o < float(lv["floor"]):
            res["status"] = "cancelled"
            return res
        if o > entry:
            return res
        fill = o * (1 + slip)
        stop = fill - risk
        stopped = l <= stop
        hit2 = not stopped and h >= t1
        hit1 = False
    else:
        raise ValueError(kind)

    time_exit = c * (1 - slip)
    if stopped:
        status, exit_ = "stopped", stop * (1 - slip_stop)
    elif hit2:
        status, exit_ = "t2", t2
    elif hit1:
        status, exit_ = "t1", 0.5 * t1 + 0.5 * time_exit
    else:
        status, exit_ = "time", time_exit

    ref = ccfg["reference"]
    shares = math.floor(min(ref["capital"] * ref["risk_pct"] / 100.0 / risk, ref["capital"] / fill))
    res.update({"status": status, "fill": round(fill, 2), "exit": round(exit_, 2), "ambiguous": bool(stopped)})
    if shares <= 0:
        res["status"] = "none"
        return res
    gross = shares * (exit_ - fill)
    charge = float(costs.charges(shares * fill, shares * exit_, ccfg))
    res.update({"r": round((gross - charge) / (shares * risk), 4),
                "r_gross": round((exit_ - fill) / risk, 4),
                "ret_pct": round((gross - charge) / (shares * fill) * 100, 4)})
    return res


def open_to_close_baseline(atr: float, bar: dict, slip: float, cost_cfg: dict | None = None) -> dict:
    """The naive comparison rule: buy at every open with a 1 ATR stop, sell at the close.

    It trades every session regardless of any signal, so it is a fair yardstick:
    a plan rule only shows timing skill if it beats this, and both must beat
    not trading at all (zero).
    """
    ccfg = cost_cfg or costs.cost_cfg()
    risk = float(atr)
    o, l, c = float(bar["open"]), float(bar["low"]), float(bar["close"])
    res = {"status": "none", "fill": None, "exit": None, "r": None, "r_gross": None,
           "ret_pct": None, "ambiguous": False}
    if not (risk > 0 and o > 0):
        return res
    fill = o * (1 + slip)
    stop = fill - risk
    stopped = l <= stop
    exit_ = stop * (1 - slip * ccfg["slippage"]["stop_exit_multiplier"]) if stopped else c * (1 - slip)
    ref = ccfg["reference"]
    shares = math.floor(min(ref["capital"] * ref["risk_pct"] / 100.0 / risk, ref["capital"] / fill))
    if shares <= 0:
        return res
    net = shares * (exit_ - fill) - float(costs.charges(shares * fill, shares * exit_, ccfg))
    res.update({"status": "stopped" if stopped else "time", "fill": round(fill, 2), "exit": round(exit_, 2),
                "r": round(net / (shares * risk), 4), "r_gross": round((exit_ - fill) / risk, 4),
                "ret_pct": round(net / (shares * fill) * 100, 4)})
    return res


def trade_result(fill: float, exit_: float, risk: float, cost_cfg: dict | None = None) -> dict | None:
    """Net and gross R of one round trip at the reference account (None if no shares fit)."""
    ccfg = cost_cfg or costs.cost_cfg()
    ref = ccfg["reference"]
    if not (risk > 0 and fill > 0):
        return None
    shares = math.floor(min(ref["capital"] * ref["risk_pct"] / 100.0 / risk, ref["capital"] / fill))
    if shares <= 0:
        return None
    net = shares * (exit_ - fill) - float(costs.charges(shares * fill, shares * exit_, ccfg))
    return {"r": round(net / (shares * risk), 4), "r_gross": round((exit_ - fill) / risk, 4),
            "ret_pct": round(net / (shares * fill) * 100, 4)}
