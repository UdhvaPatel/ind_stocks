"""After-the-close replay with 5-minute bars (PLAN.md 6.6, Phase 7). No live data.

After each session the pipeline archives that day's 5-minute bars in the vault
(Yahoo keeps only about 60 days of them) and replays every recorded plan
against them. A daily bar cannot say whether the stop or the target came
first; the 5-minute path can, so live scoring uses it whenever the archive has
the session, and falls back to the conservative daily-bar rules otherwise.

Rules applied here that a daily bar cannot express:
  * entries are only taken before 14:30 IST
  * any open position is closed at 15:15 IST
  * a touch is not a fill: price must trade through the entry by one tick
  * after the first target, the remaining half keeps the same stop
Inside one 5-minute bar the order is still unknown, so the stop is assumed
first there (flagged `ambiguous`).
"""
from __future__ import annotations

from datetime import date, time, timedelta

import pandas as pd

from . import config, costs, fetch_yahoo, plans, store, universe
from .http import FetchError, Http

MIN_BARS = 60                       # a normal session has 75 five-minute bars
ARCHIVE_LOOKBACK = 5                # sessions checked for a missing archive on each run

_cache: dict[date, dict[str, pd.DataFrame]] = {}


# ------------------------------------------------------------------ archive
def archive_recent(http: Http, log=print) -> dict:
    """Archive 5-minute bars for recent sessions that are not in the vault yet."""
    have = set(store.bars5m_days())
    recent = store.open_days()[-ARCHIVE_LOOKBACK:]
    missing = [d for d in recent if d not in have]
    if not missing:
        return {"saved": [], "note": "archive is up to date"}
    frames, failed = [], []
    for sym in universe.plan_symbols():
        try:
            df = fetch_yahoo.fetch_5m(http, fetch_yahoo.yahoo_symbol(sym), days=5)
        except (FetchError, ValueError, KeyError) as exc:
            failed.append(sym)
            log(f"  5m {sym}: {exc}")
            continue
        df.insert(0, "symbol", sym)
        frames.append(df)
    if not frames:
        raise FetchError("no 5-minute bars could be downloaded")
    allbars = pd.concat(frames, ignore_index=True)
    allbars["day"] = allbars["ts"].dt.date
    saved = []
    for d in missing:
        day = allbars[allbars["day"] == d].drop(columns=["day"])
        if day["symbol"].nunique() >= 0.8 * len(frames) and len(day):
            store.save_bars5m(d, day.sort_values(["symbol", "ts"]))
            saved.append(d.isoformat())
    return {"saved": saved, "failed_symbols": failed}


def bars_for(d: date) -> dict[str, pd.DataFrame]:
    if d not in _cache:
        df = store.load_bars5m(d)
        _cache[d] = {} if df is None else {s: g.sort_values("ts").reset_index(drop=True)
                                           for s, g in df.groupby("symbol")}
    return _cache[d]


# ------------------------------------------------------------------- replay
def _t(text: str) -> time:
    hh, mm = text.split(":")
    return time(int(hh), int(mm))


def replay_plan(kind: str, lv: dict, bars: pd.DataFrame, slip: float,
                cost_cfg: dict | None = None, model_cfg: dict | None = None) -> dict:
    """Outcome of one plan on a session's 5-minute bars (columns ts, open, high, low, close)."""
    ccfg = cost_cfg or costs.cost_cfg()
    mcfg = model_cfg or plans.model_cfg()
    cancel_after, exit_by = _t(mcfg["session"]["cancel_after"]), _t(mcfg["session"]["exit_by"])
    slip_stop = slip * ccfg["slippage"]["stop_exit_multiplier"]
    entry, stop, t1, t2, risk = (float(lv[k]) for k in ("entry", "stop", "t1", "t2", "risk"))
    tick = plans.tick_size(entry, mcfg)
    res = {"status": "not_triggered", "fill": None, "exit": None, "r": None, "r_gross": None,
           "ret_pct": None, "ambiguous": False, "fill_time": None, "exit_time": None, "source": "5m"}
    if not (risk > 0) or not len(bars):
        res["status"] = "none"
        return res

    rows = list(bars.itertuples(index=False))
    o0 = float(rows[0].open)
    if kind == "breakout" and (o0 <= stop or o0 >= t1):
        res["status"] = "cancelled"
        return res
    if kind == "pullback" and o0 <= stop:
        res["status"] = "cancelled"
        return res
    if kind == "gap_reversal":
        if o0 < float(lv["floor"]):
            res["status"] = "cancelled"
            return res
        if o0 > entry:
            return res

    fill = None
    half_out = False                 # first target already taken on half the position
    realised = 0.0                   # exit value per share already booked (as a weighted sum)
    weight_left = 1.0

    def close_out(price: float, when, status: str) -> dict:
        exit_ = realised + weight_left * price
        out = plans.trade_result(fill, exit_, risk, ccfg)
        if out is None:
            res["status"] = "none"
            return res
        final = "t1" if half_out and status in ("time", "stopped") else status
        res.update({"status": final, "fill": round(fill, 2), "exit": round(exit_, 2),
                    "exit_time": when.strftime("%H:%M"), **out})
        return res

    for k, bar in enumerate(rows):
        ts = bar.ts
        o, h, l, c = float(bar.open), float(bar.high), float(bar.low), float(bar.close)
        now = ts.time()

        if fill is not None and now >= exit_by:                      # 15:15 time exit
            return close_out(o * (1 - slip), ts, "time")

        just_filled = False
        if fill is None:
            if now >= cancel_after:                                  # no new entries after 14:30
                return res
            if kind == "breakout" and h >= entry + tick:
                fill = max(entry, o) * (1 + slip)
            elif kind == "pullback" and l <= entry - tick:
                fill = min(entry, o)
            elif kind == "gap_reversal" and k == 0:
                fill = o * (1 + slip)
                stop = fill - risk
            if fill is None:
                continue
            just_filled = True
            res["fill_time"] = ts.strftime("%H:%M")

        # Manage the open position on this bar. Stop is checked first.
        if o <= stop and not just_filled:                            # gapped through the stop
            return close_out(o * (1 - slip_stop), ts, "stopped")
        if l <= stop:
            res["ambiguous"] = bool(just_filled or h >= t1)
            return close_out(stop * (1 - slip_stop), ts, "stopped")
        if kind == "gap_reversal":
            if h >= t1:
                return close_out(t1, ts, "t2")
            continue
        if h >= t2:
            return close_out(t2, ts, "t2")
        if not half_out and h >= t1:
            half_out = True
            realised += 0.5 * t1
            weight_left = 0.5

    if fill is None:
        return res
    last = rows[-1]
    return close_out(float(last.close) * (1 - slip), last.ts, "time")


def plan_results(record: dict, d: date) -> dict | None:
    """5-minute outcomes for every plan in a ledger record, or None if the archive lacks the session."""
    bars = bars_for(d).get(record["symbol"])
    if bars is None or len(bars) < MIN_BARS:
        return None
    slip = record["inputs"].get("slippage", 0.0005)
    return {kind: replay_plan(kind, lv, bars, slip) for kind, lv in record.get("plans", {}).items()}


def intraday_profile(days: int = 60) -> pd.DataFrame | None:
    """Average share of the day's variance in each 5-minute slot, from the archive."""
    parts = []
    for d in store.bars5m_days()[-days:]:
        df = store.load_bars5m(d)
        if df is None or not len(df):
            continue
        df = df.sort_values(["symbol", "ts"])
        df["ret2"] = (df.groupby("symbol")["close"].pct_change().fillna(df["close"] / df["open"] - 1)) ** 2
        df["slot"] = df["ts"].dt.strftime("%H:%M")
        tot = df.groupby("symbol")["ret2"].transform("sum")
        df["share"] = df["ret2"] / tot.where(tot > 0)
        parts.append(df.groupby("slot")["share"].mean())
    if not parts:
        return None
    prof = pd.concat(parts, axis=1).mean(axis=1)
    return (prof / prof.sum()).rename("variance_share").to_frame()
