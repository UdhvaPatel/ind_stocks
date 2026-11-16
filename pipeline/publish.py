"""Write the static JSON the website reads (PLAN.md section 8).

Only derived analytics are published. Raw vendor history stays in the vault.
All numbers are plain JSON numbers, missing values are null, and every file
carries `schema`, `model_version` and `generated_at`.
"""
from __future__ import annotations

import json
import math
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

from . import config, costs, plans
from .engine import Engine

SCHEMA = 1


# ------------------------------------------------------------------- helpers
def clean(obj):
    """Make any nested structure JSON-safe: numpy types to Python, NaN to null."""
    if isinstance(obj, dict):
        return {str(k): clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [clean(v) for v in obj]
    if isinstance(obj, (np.bool_, bool)):
        return bool(obj)
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (float, np.floating)):
        return None if not math.isfinite(obj) else float(obj)
    if isinstance(obj, (date, pd.Timestamp)):
        return obj.isoformat()
    return obj


def write_json(path: Path, obj, indent: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(clean(obj), indent=indent, separators=None if indent else (",", ":"),
                      ensure_ascii=False, allow_nan=False)
    path.write_text(text + "\n", encoding="utf-8", newline="\n")


def stamp(model_version: str) -> dict:
    return {"schema": SCHEMA, "model_version": model_version,
            "generated_at": config.now_ist().isoformat(timespec="seconds")}


def r(x, k: int = 2):
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return round(x, k) if math.isfinite(x) else None


def safe_name(symbol: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in symbol)


# --------------------------------------------------------------- statistics
# (group, key, label, decimals, unit, what it means)
STAT_CELLS = [
    ("Level", "pct_rank_252", "1-year percentile", 0, "pct", "Where the close sits among the last 252 closes (100 = highest)."),
    ("Level", "pct_rank_60", "60-day percentile", 0, "pct", "Where the close sits among the last 60 closes."),
    ("Level", "range_pos_20", "20-day range position", 0, "pct", "0 = at the 20-day low, 100 = at the 20-day high."),
    ("Level", "dist_52w_high", "From 52-week high", 1, "%", "Distance below the highest price of the last year."),
    ("Level", "dist_52w_low", "From 52-week low", 1, "%", "Distance above the lowest price of the last year."),
    ("Level", "drawdown", "Drawdown", 1, "%", "Decline from the highest close in the history."),
    ("Level", "z_20", "Z-score (20d)", 2, "", "Standard deviations from the 20-day average."),
    ("Trend", "dist_sma_20", "vs 20-day average", 1, "%", "Close relative to the 20-day average."),
    ("Trend", "dist_sma_50", "vs 50-day average", 1, "%", "Close relative to the 50-day average."),
    ("Trend", "dist_sma_200", "vs 200-day average", 1, "%", "Close relative to the 200-day average."),
    ("Trend", "slope_20", "20-day slope", 2, "%/day", "Slope of a straight line fitted to the last 20 closes."),
    ("Trend", "r2_20", "Trend fit (R²)", 2, "", "How straight that line is: 1 = perfectly steady trend."),
    ("Trend", "adx_14", "ADX (14)", 0, "", "Trend strength. Above 25 is a strong trend, below 15 is drift."),
    ("Trend", "macd_hist", "MACD histogram", 2, "%", "Momentum direction (12, 26, 9), as % of price."),
    ("Trend", "days_since_cross", "Days since 50/200 cross", 0, "d", "Sessions since the 50-day average crossed the 200-day."),
    ("Momentum", "rsi_14", "RSI (14)", 0, "", "Above 70 stretched up, below 30 stretched down."),
    ("Momentum", "stoch_14", "Stochastic (14)", 0, "", "Close within the 14-day high-low range."),
    ("Momentum", "roc_5", "5-day change", 1, "%", "Price change over 5 sessions."),
    ("Momentum", "roc_21", "1-month change", 1, "%", "Price change over 21 sessions."),
    ("Momentum", "roc_63", "3-month change", 1, "%", "Price change over 63 sessions."),
    ("Momentum", "roc_252", "1-year change", 1, "%", "Price change over 252 sessions."),
    ("Momentum", "mom_12_1", "12-1 momentum", 1, "%", "12-month change excluding the latest month."),
    ("Volatility", "atr_pct", "ATR (14)", 2, "%", "Average daily true range as % of price."),
    ("Volatility", "rv_21", "Volatility (21d)", 1, "% pa", "Annualised volatility of the last 21 sessions."),
    ("Volatility", "rv_63", "Volatility (63d)", 1, "% pa", "Annualised volatility of the last 63 sessions."),
    ("Volatility", "vol_ratio", "Volatility ratio", 2, "x", "21-day over 63-day. Above 1.15 expanding, below 0.85 calm."),
    ("Volatility", "garman_klass_21", "Range volatility", 1, "% pa", "Garman-Klass estimate from daily high, low, open, close."),
    ("Volatility", "bb_pctb", "Bollinger %B", 2, "", "0 = lower band, 1 = upper band."),
    ("Volatility", "bb_width_rank", "Band-width percentile", 0, "pct", "Low values mean a squeeze (unusually narrow bands)."),
    ("Participation", "volume_ratio", "Volume vs 20-day", 2, "x", "Latest volume over the prior 20-day average."),
    ("Participation", "deliv_pct", "Delivery", 1, "%", "Share of traded quantity taken for delivery (official NSE)."),
    ("Participation", "deliv_vs_60", "Delivery vs 60-day", 1, "pts", "Delivery % minus its own 60-day average."),
    ("Participation", "up_volume_ratio", "Up-volume share", 0, "%", "Share of 20-day volume traded on rising days."),
    ("Participation", "turnover_cr", "Avg turnover", 0, "cr", "20-day average daily turnover in crore rupees."),
    ("Relative", "rs_21", "vs Nifty (1m)", 1, "%", "Out- or under-performance against Nifty 50 over 21 sessions."),
    ("Relative", "rs_63", "vs Nifty (3m)", 1, "%", "Out- or under-performance against Nifty 50 over 63 sessions."),
    ("Relative", "rs_rank_252", "Relative-strength percentile", 0, "pct", "Stock/Nifty ratio among its last 252 values."),
    ("Relative", "beta_252", "Beta", 2, "", "Sensitivity to Nifty 50 over one year."),
    ("Relative", "corr_252", "Correlation", 2, "", "Correlation of daily moves with Nifty 50."),
    ("Risk", "var_95", "1-day VaR (95%)", 2, "%", "Daily loss exceeded on 1 day in 20 over the last year."),
    ("Risk", "cvar_95", "Expected shortfall", 2, "%", "Average loss on those worst 5% of days."),
    ("Risk", "worst_day_252", "Worst day (1y)", 1, "%", "Largest single-day fall in the last year."),
    ("Risk", "skew_252", "Skew", 2, "", "Negative means large falls are more common than large rises."),
    ("Risk", "kurt_252", "Kurtosis", 1, "", "Above 0 means fat tails: extreme days are more common than normal."),
    ("Risk", "p_down_after_down", "Down after down", 0, "%", "How often a down day followed a down day in the last year."),
]


def stat_groups(feat_row: pd.Series, turnover_cr: float) -> list[dict]:
    groups: dict[str, list] = {}
    for group, key, label, dec, unit, note in STAT_CELLS:
        value = turnover_cr if key == "turnover_cr" else feat_row.get(key)
        groups.setdefault(group, []).append(
            {"key": key, "label": label, "value": r(value, dec), "unit": unit, "note": note})
    return [{"group": g, "cells": cells} for g, cells in groups.items()]


def histogram(samples: np.ndarray, bins: int = 31) -> dict | None:
    """Histogram of forecast samples (in %), for the "what similar days did" chart."""
    if samples is None or len(samples) < 30:
        return None
    lo, hi = np.percentile(samples, [1, 99])
    edges = np.linspace(lo, hi, bins + 1)
    counts, _ = np.histogram(np.clip(samples, lo, hi), bins=edges)
    return {"lo": r(lo, 3), "hi": r(hi, 3), "counts": [int(c) for c in counts], "n": int(len(samples))}


def series_block(df: pd.DataFrame, feat: pd.DataFrame, days: int, raw_prices: bool) -> dict:
    """Recent bars for the chart, in rupees or in % relative to the latest close."""
    tail = df.iloc[-days:]
    last = float(tail["close"].iloc[-1])
    conv = (lambda x: x) if raw_prices else (lambda x: (x / last - 1) * 100)
    dec = 2 if raw_prices else 3
    rows = [[d.isoformat(), r(conv(o), dec), r(conv(h), dec), r(conv(l), dec), r(conv(c), dec)]
            for d, o, h, l, c in zip(tail.index, tail["open"], tail["high"], tail["low"], tail["close"])]
    f = feat.iloc[-days:]
    avg = lambda col: [r(conv(v), dec) if np.isfinite(v) else None for v in f[col]]
    vol = tail["volume"] / tail["volume"].max() if tail["volume"].max() > 0 else tail["volume"]
    return {"unit": "inr" if raw_prices else "pct", "ref_close": r(last, 2), "rows": rows,
            "sma20": avg("sma_20"), "sma50": avg("sma_50"),
            "volume": [r(v, 3) for v in vol]}


# ------------------------------------------------------------ symbol files
RULE_LABELS = {
    "breakout": "Breakout above yesterday's high",
    "pullback": "Dip toward support",
    "gap_reversal": "Gap-down reversal at the open",
}


def plan_card(entry: dict, kind: str, ccfg: dict, mcfg: dict) -> dict:
    """Levels plus a worked position at the reference capital."""
    lv = entry["plans"][kind]
    ref = ccfg["reference"]
    pos = plans.position(lv["entry"], lv["stop"], ref["capital"], ref["risk_pct"])
    buy = pos["shares"] * lv["entry"]
    card = {"kind": kind, "label": RULE_LABELS[kind], "levels": lv,
            "cancel_after": mcfg["session"]["cancel_after"], "exit_by": mcfg["session"]["exit_by"],
            "reference": {"capital": ref["capital"], "risk_pct": ref["risk_pct"], **pos,
                          "charges_if_target": costs.charges_breakdown(buy, pos["shares"] * lv["t1"], ccfg),
                          "charges_if_stop": costs.charges_breakdown(buy, pos["shares"] * lv["stop"], ccfg)}}
    return card


def symbol_file(engine: Engine, entry: dict, info: dict, for_date: date, plan_status: str,
                pub: dict, issues: list) -> dict:
    sym = entry["symbol"]
    st = engine.states[sym]
    i = st.pos[date.fromisoformat(entry["as_of"])]
    fc = entry["forecast"]
    prev_close = float(st.df["close"].iloc[i - 1]) if i > 0 else None
    d = entry["decision"]
    shown = d["kind"] or d["reference_kind"]
    out = {
        **stamp(engine.mcfg["model_version"]),
        "symbol": sym, "name": info.get("name"), "industry": info.get("industry"),
        "as_of": entry["as_of"], "for_date": for_date.isoformat(), "plan_status": plan_status,
        "last": {**entry["prev"],
                 "change_pct": r((entry["prev"]["close"] / prev_close - 1) * 100) if prev_close else None,
                 "volume_ratio": r(entry["features"].get("volume_ratio"))},
        "atr": entry["atr"], "atr_pct": entry["atr_pct"],
        "liquidity_tier": entry["liquidity_tier"], "slippage": entry["slippage"],
        "call": {"call": d["call"], "label": d["label"], "kind": d["kind"],
                 "reference_kind": d["reference_kind"], "reasons": d["reasons"]},
        "evidence": d["evidence"],
        "plan": plan_card(entry, shown, engine.ccfg, engine.mcfg) if shown in entry["plans"] else None,
        "plans": {k: plan_card(entry, k, engine.ccfg, engine.mcfg) for k in entry["plans"]},
        "rules": entry["rules"],
        "claims": entry["claims"],
        "forecast": fc.to_json() if fc.ok else None,
        "distribution": {"close": histogram(fc.s_cc), "high": histogram(fc.s_hi), "low": histogram(fc.s_lo)}
        if fc.ok else None,
        "health": {"score": entry["setup"], "parts": entry["setup_parts"],
                   "note": "Descriptive only. In the walk-forward test this score did not predict the next session."},
        "stats": stat_groups(entry["features"], float(np.nan_to_num(st.turnover_cr[i]))),
        "series": series_block(st.df.iloc[:i + 1], st.feat.iloc[:i + 1], pub["series_days"], pub["publish_prices"]),
        "overnight_z": entry["overnight_z"],
        "data_flags": [x for x in issues if x["date"] >= str(st.dates[max(i - 30, 0)])],
    }
    return out


# ------------------------------------------------------------ planner file
def planner_file(symbol_files: list[dict], model_version: str) -> dict:
    """One compact file with every stock's levels and each rule's record.

    The "Make a plan" page sizes these for the amount, target and risk a viewer
    types in. It carries nothing that is not already in the symbol files; a rule
    with incomplete levels or no history is left out rather than guessed.
    """
    def share(count, trades):
        return r(count / trades, 4) if trades else None

    stocks = []
    for f in sorted(symbol_files, key=lambda x: x["symbol"]):
        call = f.get("call") or {}
        rules = {}
        for kind, card in (f.get("plans") or {}).items():
            lv = (card or {}).get("levels") or {}
            rec = (f.get("rules") or {}).get(kind) or {}
            ev = (f.get("evidence") or {}).get(kind) or {}
            needed = [lv.get(k) for k in ("entry", "stop", "t1", "t2")]
            if any(v is None or not math.isfinite(float(v)) for v in needed):
                continue
            if not (lv["entry"] > lv["stop"] > 0):
                continue
            trades = rec.get("trades") or 0
            won = rec.get("outcomes") or {}
            q = rec.get("r_quantiles") or {}
            rules[kind] = {
                "entry": lv["entry"], "stop": lv["stop"], "t1": lv["t1"], "t2": lv["t2"],
                "floor": lv.get("floor"), "p_trigger": lv.get("p_trigger"),
                "cancel_after": card.get("cancel_after"), "exit_by": card.get("exit_by"),
                "trades": trades, "win_rate": rec.get("win_rate"),
                "expectancy_r": rec.get("expectancy_r"), "shrunk_r": ev.get("shrunk_r"),
                "enough": bool(ev.get("enough")),
                "hit_t1": share(won.get("t1", 0) + won.get("t2", 0), trades),
                "hit_t2": share(won.get("t2", 0), trades),
                "r_p05": q.get("p05"), "r_p25": q.get("p25"), "r_p50": q.get("p50"),
                "r_p75": q.get("p75"), "r_p95": q.get("p95"),
            }
        if not rules:
            continue
        close_q = ((f.get("claims") or {}).get("close") or {})
        stocks.append({
            "symbol": f["symbol"], "name": f.get("name"), "close": (f.get("last") or {}).get("close"),
            "call": call.get("call"), "label": call.get("label"), "kind": call.get("kind"),
            "slippage": f.get("slippage"), "close_p95": close_q.get("p95"), "rules": rules,
        })
    first = symbol_files[0] if symbol_files else {}
    return {**stamp(model_version), "as_of": first.get("as_of"), "for_date": first.get("for_date"),
            "plan_status": first.get("plan_status"), "stocks": stocks}


# ------------------------------------------------------------- market file
def market_file(engine: Engine, book: dict, as_of: date) -> dict:
    ds = engine.ds
    cfg = config.universe_cfg()

    def tile(df: pd.DataFrame | None, label: str, key: str, cut_day=None):
        if df is None or len(df) < 2:
            return None
        if cut_day is not None:
            df = df[df.index <= cut_day]
        last, prev = float(df["close"].iloc[-1]), float(df["close"].iloc[-2])
        return {"key": key, "label": label, "date": df.index[-1].isoformat(), "close": r(last, 2),
                "change": r(last - prev, 2), "change_pct": r((last / prev - 1) * 100, 2)}

    indices = [t for t in (tile(ds.indices.get(k), v["label"], k, as_of) for k, v in cfg["indices"].items()) if t]
    overnight = [t for t in (tile(ds.overnight.get(k), v["label"], k) for k, v in cfg["overnight"].items()) if t]

    mk = engine.market[engine.market.index <= as_of]
    last = mk.iloc[-1] if len(mk) else pd.Series(dtype=float)
    regime = {-1: "calm", 0: "normal", 1: "stressed"}.get(
        int(last["vix_regime"]) if "vix_regime" in last and np.isfinite(last["vix_regime"]) else 0)

    val = ds.valuation[ds.valuation.index <= as_of]
    valuation = None
    if len(val):
        v = val.iloc[-1]
        rank = lambda col: r(float((val[col].dropna() <= v[col]).mean() * 100), 0) if np.isfinite(v[col]) else None
        valuation = {"pe": r(v["pe"]), "pb": r(v["pb"]), "div_yield": r(v["div_yield"]),
                     "pe_percentile": rank("pe"), "pb_percentile": rank("pb"),
                     "since": val.index[0].isoformat()}

    above = [1.0 if e["features"].get("dist_sma_50", np.nan) > 0 else 0.0 for e in book.values()
             if np.isfinite(e["features"].get("dist_sma_50", np.nan))]
    heat = []
    for sym, e in sorted(book.items()):
        st = engine.states[sym]
        i = st.pos[as_of]
        chg = (st.df["close"].iloc[i] / st.df["close"].iloc[i - 1] - 1) * 100 if i > 0 else None
        heat.append({"symbol": sym, "close": e["prev"]["close"], "change_pct": r(chg),
                     "health": e["setup"], "call": e["decision"]["call"], "label": e["decision"]["label"],
                     "kind": e["decision"]["kind"], "atr_pct": e["atr_pct"],
                     "p_up": e["claims"]["dir"]["p_up"] if e["claims"] else None})
    calls = {}
    for h in heat:
        calls[h["call"]] = calls.get(h["call"], 0) + 1
    return {
        **stamp(engine.mcfg["model_version"]), "as_of": as_of.isoformat(),
        "indices": indices, "overnight": overnight,
        "overnight_z": r(next(iter(book.values()))["overnight_z"]) if book else None,
        "vix": {"level": r(last.get("vix")), "percentile": r(last.get("vix_rank_252"), 0), "regime": regime},
        "breadth": {"advance_pct": r(last.get("adv_pct"), 1), "advance_pct_10d": r(last.get("adv_pct_10"), 1),
                    "above_sma50_pct": r(100 * float(np.mean(above)), 0) if above else None},
        "valuation": valuation, "heatmap": heat, "calls": calls,
    }


# ----------------------------------------------------------------- day pages
def day_summary(day: str, scores: list[dict], track: str, model_version: str) -> dict:
    """One session: what was predicted, what happened, and how it scored."""
    rows = []
    for s in sorted(scores, key=lambda x: x["symbol"]):
        row = {"symbol": s["symbol"], "status": s["status"], "call": s["call"], "made_at": s.get("made_at")}
        if s["status"] != "scored":
            row["reason"] = s.get("reason")
            rows.append(row)
            continue
        cl = s.get("claims") or {}
        row.update({
            "prev_close": s.get("prev_close"), "actual": s["actual"],
            "p_up": s["dir"]["p_up"] if "dir" in s else None,
            "dir_correct": s["dir"]["correct"] if "dir" in s else None,
            "range": [cl["close"]["p05"], cl["close"]["p50"], cl["close"]["p95"]] if cl else None,
            "inside": s["close"]["inside"] if "close" in s else None,
            "touch": s.get("touch"),
        })
        kind = s["call"].get("kind") or s["call"].get("reference_kind")
        if kind and kind in s.get("plans", {}):
            row["plan"] = {"kind": kind, "levels": (s.get("plan_levels") or {}).get(kind),
                           "outcome": s["plans"][kind]}
        row["rules"] = {k: {"status": v["status"], "r": v["r"]} for k, v in s.get("plans", {}).items()}
        rows.append(row)
    scored = [x for x in rows if x["status"] == "scored" and x.get("dir_correct") is not None]
    n = len(scored)
    summary = {"stocks": len(rows), "scored": n,
               "dir_hit": r(sum(x["dir_correct"] for x in scored) / n, 3) if n else None,
               "coverage": r(sum(x["inside"] for x in scored) / n, 3) if n else None,
               "up_share": r(sum(x["actual"]["ret_pct"] > 0 for x in scored) / n, 3) if n else None,
               "avg_ret_pct": r(float(np.mean([x["actual"]["ret_pct"] for x in scored])), 3) if n else None}
    return {**stamp(model_version), "date": day, "track": track, "summary": summary, "rows": rows}


def write_day(day: str, scores: list[dict], track: str, model_version: str) -> None:
    write_json(config.DATA_DIR / "days" / day / "summary.json",
               day_summary(day, scores, track, model_version))
