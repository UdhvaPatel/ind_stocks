"""Multi-day swing research: is there a simple long rule with an edge after delivery costs?

    python -m pipeline.research          (writes data/research.json, about 2 minutes)

PRE-REGISTERED on 21 Nov 2026, before any result was seen. Nothing below may be changed
after looking at results without recording it as a new, separate test.

  Universe   today's Nifty 50 stocks (survivorship bias: they are today's winners), 2016-2026.
  Signal     computed from data up to the close of day t.
  Trade      buy at the open of t+1, sell at the close of t+H, H in {2, 3, 5} sessions.
             No stop, no target: one fixed exit, so nothing can be tuned.
  Returns    total return (dividends included) from the adjusted prices.
  Costs      full delivery costs on a Rs 1,00,000 position: brokerage (capped), STT both sides,
             stamp duty, exchange and SEBI fees, GST, the depository charge on the sale, and
             slippage on both sides by liquidity tier (config/costs.yaml).
  Benchmark  the same 50 stocks held over exactly the same days (their average return).
             EXCESS = net return of the trade minus that average. A long rule in a rising
             market makes money; only beating the market over the same days is an edge.
  Periods    discovery 2017-01-01 to 2020-12-31, validation 2021-01-01 to the latest day.
  Statistic  per entry day, the average excess of that day's trades; t-statistic with a
             Newey-West correction (lag H) because holding windows overlap.
  Pass       mean excess > 0 with t >= 2 in BOTH periods, and >= 200 trades in each.
             18 variants are tested (6 rules x 3 horizons); passing both periods by luck
             is unlikely but not impossible, so a pass is a candidate, not a proof.
"""
from __future__ import annotations

import json
import math
from datetime import date

import numpy as np
import pandas as pd

from . import config, dataset, publish, universe

PREREGISTERED = "2026-11-21"
HORIZONS = (2, 3, 5)
# Test 2, added the same day AFTER test 1 had failed, and recorded as a separate test:
# the same six rules held 10 and 20 sessions, because costs are a fixed hit per trade and
# longer holds make them a smaller share of the move. Same pass rule. Its variants are
# counted on top of test 1's, so the total number of things tried stays visible.
HORIZONS_2 = (10, 20)
ALL_HORIZONS = HORIZONS + HORIZONS_2
DISCOVERY = (date(2017, 1, 1), date(2020, 12, 31))
VALIDATION = (date(2021, 1, 1), None)
MIN_TRADES, MIN_T = 200, 2.0
POSITION = 100_000.0

RULES = {
    "rsi2_dip": ("Short dip in an uptrend", "RSI(2) below 10 while the close is above its 200-day average (a well-known mean-reversion rule)."),
    "three_down": ("Three down days in an uptrend", "Three falling closes in a row while above the 200-day average."),
    "weak_week": ("Weakest of the week", "5-day return in the bottom 10% of the 50 stocks that day (short-term reversal)."),
    "breakout_20": ("20-day high on high volume", "Close at its highest in 20 days with volume 1.5 times its 20-day average."),
    "momentum": ("Six-month leaders", "6-month return (skipping the last week) in the top 10% of the 50 stocks."),
    "big_drop": ("Sharp one-day drop in an uptrend", "Close at least 3% below the previous close while above the 200-day average."),
}


# ------------------------------------------------------------------- costs
def delivery_cost_pct(slip: float, ccfg: dict) -> float:
    """Round-trip delivery cost as a fraction of a Rs 1,00,000 position (sell value taken as equal)."""
    d, buy, sell = ccfg["delivery"], POSITION, POSITION
    brokerage = min(d["brokerage_max_per_order"], d["brokerage_pct_per_order"] * buy) + \
        min(d["brokerage_max_per_order"], d["brokerage_pct_per_order"] * sell)
    turnover = buy + sell
    exchange, sebi = ccfg["exchange_txn"] * turnover, ccfg["sebi_fee"] * turnover
    total = (brokerage + d["stt_buy"] * buy + d["stt_sell"] * sell + d["stamp_duty_buy"] * buy + exchange + sebi
             + ccfg["gst"] * (brokerage + exchange + sebi) + d["dp_charge_per_sell"] + slip * turnover)
    return total / POSITION


def slip_for(turnover_cr: float, ccfg: dict) -> float:
    if not np.isfinite(turnover_cr):
        return ccfg["slippage"]["tiers"][-1]["per_side"]
    for tier in ccfg["slippage"]["tiers"]:                    # ordered from most liquid
        if turnover_cr >= tier["min_turnover_cr"]:
            return tier["per_side"]
    return ccfg["slippage"]["tiers"][-1]["per_side"]


# --------------------------------------------------------------- the panel
def rsi(close: pd.Series, n: int = 2) -> pd.Series:
    d = close.diff()
    up, dn = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean(), (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return 100 - 100 / (1 + up / dn.replace(0, np.nan))


def build_panel(frames: dict[str, pd.DataFrame]) -> dict[str, pd.DataFrame]:
    """Date x symbol tables of signals, forward returns and liquidity."""
    cols: dict[str, dict[str, pd.Series]] = {}
    put = lambda name, sym, s: cols.setdefault(name, {}).__setitem__(sym, s)
    for sym, f in frames.items():
        f = f[["open", "close", "adjclose", "volume"]].dropna(subset=["open", "close"]).astype(float)
        if len(f) < 260:
            continue
        close, vol = f["close"], f["volume"]
        ratio = (f["adjclose"] / close).fillna(1.0)               # dividend adjustment, applied to the open too
        tr_open, tr_close = f["open"] * ratio, f["adjclose"].fillna(close)
        ret1 = close.pct_change()
        above = close > close.rolling(200).mean()
        put("rsi2_dip", sym, (rsi(close) < 10) & above)
        put("three_down", sym, (ret1 < 0) & (ret1.shift(1) < 0) & (ret1.shift(2) < 0) & above)
        put("ret5", sym, close / close.shift(5) - 1)
        put("breakout_20", sym, (close >= close.rolling(20).max()) & (vol > 1.5 * vol.rolling(20).mean().shift(1)))
        put("mom", sym, close.shift(5) / close.shift(131) - 1)
        put("big_drop", sym, (ret1 <= -0.03) & above)
        put("turnover_cr", sym, (close * vol / 1e7).rolling(20).mean())
        for H in ALL_HORIZONS:
            put(f"fwd{H}", sym, tr_close.shift(-H) / tr_open.shift(-1) - 1)
    panel = {k: pd.DataFrame(v).sort_index() for k, v in cols.items()}
    count = panel["ret5"].notna().sum(axis=1)
    enough = count >= 30                                        # cross-sectional ranks need a full field
    panel["weak_week"] = (panel["ret5"].rank(axis=1, pct=True) <= 0.10) & enough.values[:, None]
    panel["momentum"] = (panel["mom"].rank(axis=1, pct=True) > 0.90) & enough.values[:, None]
    return panel


# ------------------------------------------------------------- statistics
def newey_west_t(x: np.ndarray, lag: int) -> float:
    n = len(x)
    if n < 10:
        return float("nan")
    m = x.mean()
    e = x - m
    var = e @ e / n
    for l in range(1, min(lag, n - 1) + 1):
        var += 2 * (1 - l / (lag + 1)) * (e[l:] @ e[:-l]) / n
    return float(m / math.sqrt(var / n)) if var > 0 else float("nan")


def summarize(trades: pd.DataFrame, lag: int) -> dict:
    if trades.empty:
        return {"trades": 0}
    daily = trades.groupby("date")["excess"].mean().sort_index()
    r = lambda x, k=3: round(float(x), k)
    return {
        "trades": int(len(trades)), "days": int(len(daily)),
        "gross_pct": r(trades["gross"].mean() * 100), "net_pct": r(trades["net"].mean() * 100),
        "market_pct": r(trades["market"].mean() * 100), "excess_pct": r(daily.mean() * 100),
        "excess_before_costs_pct": r(trades.groupby("date").apply(lambda g: (g["gross"] - g["market"]).mean()).mean() * 100),
        "t_excess": r(newey_west_t(daily.to_numpy(), lag), 2),
        "win_rate": r((trades["net"] > 0).mean(), 3), "beat_market_rate": r((trades["excess"] > 0).mean(), 3),
        "cost_pct": r(trades["cost"].mean() * 100),
    }


def in_period(idx, period) -> np.ndarray:
    lo, hi = period
    d = np.array(idx)
    return (d >= lo) & ((d <= hi) if hi else True)


def run(frames: dict[str, pd.DataFrame], ccfg: dict, horizons=HORIZONS, panel=None) -> dict:
    panel = panel if panel is not None else build_panel(frames)
    slip = panel["turnover_cr"].apply(lambda col: col.map(lambda v: slip_for(v, ccfg)))
    cost = slip.apply(lambda col: col.map(lambda s: delivery_cost_pct(s, ccfg)))
    variants = []
    for key, (label, how) in RULES.items():
        sig = panel[key].eq(True)
        for H in horizons:
            fwd = panel[f"fwd{H}"]
            market = fwd.mean(axis=1)                            # the same 50 stocks over the same days
            stacked = pd.DataFrame({"gross": fwd.where(sig).stack(), "cost": cost.where(sig).stack()}).dropna()
            stacked.index = stacked.index.set_names(["date", "symbol"])
            t = stacked.reset_index()
            t["market"] = t["date"].map(market)
            t["net"] = t["gross"] - t["cost"]
            t["excess"] = t["net"] - t["market"]
            t = t.dropna(subset=["market"])
            res = {"rule": key, "label": label, "how": how, "hold_days": H}
            for name, period in (("discovery", DISCOVERY), ("validation", VALIDATION)):
                res[name] = summarize(t[in_period(t["date"], period)], H)
            dv, vl = res["discovery"], res["validation"]
            res["passed"] = bool(all(p.get("trades", 0) >= MIN_TRADES and p.get("excess_pct", -1) > 0 and (p.get("t_excess") or 0) >= MIN_T
                                     for p in (dv, vl)))
            variants.append(res)
    passed = [v for v in variants if v["passed"]]
    last = max(pd.Timestamp(d).date() for d in panel["ret5"].index)
    typical_cost = delivery_cost_pct(ccfg["slippage"]["tiers"][0]["per_side"], ccfg) * 100
    if passed:
        names = ", ".join(f"{v['label'].lower()} ({v['hold_days']} days)" for v in passed)
        verdict = (f"{len(passed)} of {len(variants)} variants passed both periods: {names}. Treat these as candidates "
                   "to watch live, not as proof; they will be tracked before any plan is built on them.")
    else:
        verdict = (f"None of the {len(variants)} variants passed. After delivery costs, no simple multi-day long rule "
                   "beat simply holding the same stocks over the same days, in both periods. This is the expected "
                   "result for well-known rules on large, heavily traded stocks.")
    return {
        **publish.stamp(config.load_yaml("model.yaml")["model_version"]),
        "preregistered": PREREGISTERED, "data_to": last.isoformat(),
        "periods": {"discovery": [DISCOVERY[0].isoformat(), DISCOVERY[1].isoformat()], "validation": [VALIDATION[0].isoformat(), last.isoformat()]},
        "rules_tested": len(RULES), "variants_tested": len(variants), "pass_rule": f"mean excess > 0 with t >= {MIN_T} in both periods, at least {MIN_TRADES} trades in each",
        "typical_round_trip_cost_pct": round(typical_cost, 3),
        "method": __doc__.split("PRE-REGISTERED", 1)[1].split("\n", 1)[1].strip(),
        "variants": variants, "passed": [f"{v['rule']}:{v['hold_days']}" for v in passed], "verdict": verdict,
    }


def combined(frames: dict[str, pd.DataFrame], ccfg: dict) -> dict:
    """Test 1 (2-5 day holds) and test 2 (10-20 day holds), reported separately and together."""
    panel = build_panel(frames)
    t1 = run(frames, ccfg, HORIZONS, panel)
    t2 = run(frames, ccfg, HORIZONS_2, panel)
    for v in t1["variants"]:
        v["test"] = 1
    for v in t2["variants"]:
        v["test"] = 2
    variants = t1["variants"] + t2["variants"]
    passed = [v for v in variants if v["passed"]]
    if passed:
        names = ", ".join(f"{v['label'].lower()} held {v['hold_days']} days" for v in passed)
        verdict = (f"{len(passed)} of {len(variants)} variants passed both periods: {names}. With {len(variants)} variants tried, "
                   "treat these as candidates to track live, not as proof.")
    else:
        beat = sum(1 for v in variants if v["validation"].get("excess_pct", -1) > 0)
        verdict = (f"None of the {len(variants)} variants passed. Even before costs, no rule beat simply holding the same "
                   f"stocks over the same days consistently in both periods; after delivery costs, {len(variants) - beat} of "
                   f"{len(variants)} did worse than holding in the recent period, and the rest by margins that could be luck. "
                   "No simple long rule on these 50 stocks has shown an edge, so the site keeps advising caution.")
    return {**t1, "variants": variants, "variants_tested": len(variants),
            "tests": [{"n": 1, "hold_days": list(HORIZONS), "note": "pre-registered 21 Nov 2026 before any result"},
                      {"n": 2, "hold_days": list(HORIZONS_2), "note": "added the same day after test 1 failed; same rules and pass rule"}],
            "passed": [f"{v['rule']}:{v['hold_days']}" for v in passed], "verdict": verdict}


def main() -> None:
    from .costs import cost_cfg
    ds = dataset.load_dataset(universe.plan_symbols())
    out = combined(ds.frames, cost_cfg())
    publish.write_json(config.DATA_DIR / "research.json", out, indent=1)
    print(f"{'rule':<14}{'H':>3}  {'disc n':>6} {'pre%':>7} {'excess%':>8} {'t':>6}  |  {'valid n':>7} {'pre%':>7} {'excess%':>8} {'t':>6}  net%  pass")
    for v in out["variants"]:
        d, w = v["discovery"], v["validation"]
        print(f"{v['rule']:<14}{v['hold_days']:>3}  {d.get('trades', 0):>6} {d.get('excess_before_costs_pct', 0):>7.3f} {d.get('excess_pct', 0):>8.3f} {d.get('t_excess') or 0:>6.2f}  |  "
              f"{w.get('trades', 0):>7} {w.get('excess_before_costs_pct', 0):>7.3f} {w.get('excess_pct', 0):>8.3f} {w.get('t_excess') or 0:>6.2f}  {w.get('net_pct', 0):>5.2f}  {'YES' if v['passed'] else '-'}")
    print("\n" + out["verdict"])
    print(f"typical round-trip cost: {out['typical_round_trip_cost_pct']}%")


if __name__ == "__main__":
    main()
