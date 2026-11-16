"""Phase 3 tests: costs, plan levels, fills, rule statistics, decisions, adjustments."""
from datetime import date, timedelta

import numpy as np
import pandas as pd
import pytest

from pipeline import backtest, clean, costs, decide, plans, setupscore
from pipeline import features as ft
from pipeline.tests.test_features import make_frame

CC = costs.cost_cfg()


# --------------------------------------------------------------------- costs
def test_charges_reconcile_by_hand():
    # Buy Rs 60,000, sell Rs 60,600 intraday.
    b = costs.charges_breakdown(60000, 60600)
    assert b["brokerage"] == pytest.approx(18.0 + 18.18)             # 0.03% each, under the Rs 20 cap
    assert b["stt"] == pytest.approx(60600 * 0.00025)
    assert b["stamp"] == pytest.approx(60000 * 0.00003)
    assert b["exchange"] == pytest.approx(120600 * 0.0000297, abs=0.01)
    assert b["gst"] == pytest.approx(0.18 * (36.18 + 3.58 + 0.12), abs=0.02)
    assert b["total"] == pytest.approx(float(costs.charges(60000, 60600)), abs=0.02)
    assert 60 < b["total"] < 70


def test_brokerage_cap_applies_to_large_orders():
    assert costs.charges_breakdown(500000, 500000)["brokerage"] == 40.0


def test_slippage_and_liquidity_tiers():
    assert costs.slippage_per_side(900) == 0.0005
    assert costs.slippage_per_side(150) == 0.0010
    assert costs.slippage_per_side(10) == 0.0015
    assert list(costs.slippage_per_side(np.array([900.0, 10.0]))) == [0.0005, 0.0015]
    assert (costs.liquidity_tier(900), costs.liquidity_tier(150), costs.liquidity_tier(10)) == (1, 2, 3)


# ------------------------------------------------------------ plans and fills
def _two_days(next_bar, close=100.0, high=101.0, low=99.0, atr=2.0):
    """Day 0 fixes the levels; day 1 is the session the plan is for."""
    d0, d1 = date(2026, 11, 12), date(2026, 11, 13)
    o, h, l, c = next_bar
    df = pd.DataFrame({"open": [close, o], "high": [high, h], "low": [low, l], "close": [close, c]},
                      index=[d0, d1])
    feat = pd.DataFrame({"atr_14": [atr, atr]}, index=[d0, d1])
    return df, feat


def _run(kind, next_bar, slip=0.0, **kw):
    df, feat = _two_days(next_bar, **kw)
    lv = plans.plan_levels(df, feat, kind)
    return lv.iloc[0], plans.simulate(df, lv, kind, slip).iloc[0]


def test_breakout_levels():
    lv, _ = _run("breakout", (100, 100, 100, 100))
    assert lv["entry"] == pytest.approx(101.2)            # previous high + 0.1 ATR
    assert lv["stop"] == pytest.approx(99.2)              # 1 ATR below (previous low is further)
    assert lv["t1"] == pytest.approx(103.2) and lv["t2"] == pytest.approx(105.2)


@pytest.mark.parametrize("bar,status", [
    ((100.0, 101.0, 99.5, 100.5), "not_triggered"),       # never reaches the entry
    ((100.5, 102.0, 100.2, 101.8), "time"),               # triggers, exits at the close
    ((100.5, 103.5, 100.2, 102.0), "t1"),                 # first target, rest at close
    ((100.5, 105.5, 100.2, 105.0), "t2"),                 # second target
    ((100.5, 103.5, 99.0, 100.0), "stopped"),             # stop and target in one bar: stop first
    ((99.0, 102.0, 98.5, 101.5), "cancelled"),            # opens below the stop
    ((103.5, 104.0, 103.0, 103.8), "cancelled"),          # opens beyond the first target
])
def test_breakout_outcomes(bar, status):
    _, res = _run("breakout", bar)
    assert res["status"] == status


def test_breakout_gap_over_entry_fills_at_open_and_costs_reduce_r():
    lv, res = _run("breakout", (102.0, 102.5, 101.5, 102.4))
    assert res["status"] == "time" and res["fill"] == pytest.approx(102.0)
    assert res["r_gross"] == pytest.approx((102.4 - 102.0) / 2.0)
    assert res["r"] < res["r_gross"]                      # charges always cost something
    _, slipped = _run("breakout", (102.0, 102.5, 101.5, 102.4), slip=0.001)
    assert slipped["r_gross"] < res["r_gross"]


def test_stop_exit_takes_extra_slippage():
    lv, res = _run("breakout", (100.5, 101.5, 99.0, 99.5), slip=0.001)
    assert res["status"] == "stopped" and res["ambiguous"]
    assert res["exit"] == pytest.approx(lv["stop"] * (1 - 0.0015))
    assert res["r_gross"] < -1.0


def test_pullback_target_needs_the_close_beyond_it():
    lv, _ = _run("pullback", (100, 100, 100, 100))
    assert lv["entry"] == pytest.approx(99.0)             # S1 = 99, inside the allowed band
    _, res = _run("pullback", (100.0, 102.0, 98.8, 99.5))     # high above target but close below
    assert res["status"] == "time" and res["fill"] == pytest.approx(99.0)
    _, res = _run("pullback", (100.0, 101.5, 98.8, 101.0))
    assert res["status"] == "t1"
    _, res = _run("pullback", (100.0, 100.5, 97.0, 98.0))
    assert res["status"] == "stopped"
    _, res = _run("pullback", (98.6, 99.5, 98.5, 99.2))       # opens under the entry: better fill
    assert res["fill"] == pytest.approx(98.6)


def test_gap_reversal_outcomes():
    lv, res = _run("gap_reversal", (99.0, 99.5, 98.5, 99.2))  # gap of 0.5 ATR: too small
    assert lv["entry"] == pytest.approx(98.5) and res["status"] == "not_triggered"
    _, res = _run("gap_reversal", (98.0, 100.5, 97.5, 99.0))  # gap closes: exit at previous close
    assert res["status"] == "t2" and res["exit"] == pytest.approx(100.0)
    assert res["r_gross"] == pytest.approx((100.0 - 98.0) / 3.0)
    _, res = _run("gap_reversal", (98.0, 98.5, 94.9, 96.0))   # stop is 1.5 ATR under the fill
    assert res["status"] == "stopped" and res["exit"] == pytest.approx(95.0)
    _, res = _run("gap_reversal", (93.0, 95.0, 92.0, 94.0))   # more than 3 ATR down: news
    assert res["status"] == "cancelled"
    _, res = _run("gap_reversal", (98.0, 99.0, 97.0, 98.5))
    assert res["status"] == "time"


def test_last_row_is_pending_and_missing_atr_gives_no_plan():
    df = make_frame(60)
    feat = ft.compute_features(df)
    for kind in plans.KINDS:
        sim = plans.simulate(df, plans.plan_levels(df, feat, kind), kind, 0.0005)
        assert sim["status"].iloc[-1] == "pending"
        assert sim["status"].iloc[0] == "none"
        assert sim.loc[~sim["status"].isin(plans.TRADED), "r"].isna().all()


def test_ticks_and_rounding_never_flatter_the_plan():
    assert plans.tick_size(640.0) == 0.05 and plans.tick_size(1353.0) == 0.10
    assert plans.tick_size(7054.0) == 0.50 and plans.tick_size(25000.0) == 5.0
    p = plans.round_plan({"entry": 1352.93, "stop": 1331.07, "t1": 1374.79, "t2": 1396.66}, "breakout")
    assert p == {"entry": 1353.0, "stop": 1331.0, "t1": 1374.7, "t2": 1396.6, "risk": 22.0}
    q = plans.round_plan({"entry": 640.03, "stop": 631.98, "t1": 648.04, "t2": 656.09}, "pullback")
    assert q["entry"] == 640.0 and q["stop"] == 631.95 and q["t1"] == 648.0


def test_position_sizing():
    pos = plans.position(1353.0, 1331.0, 100000, 1.0)
    assert pos == {"shares": 45, "value": 60885.0, "risk_rs": 990.0, "capped": False}
    capped = plans.position(1353.0, 1352.0, 100000, 1.0)      # tiny stop: capital is the limit
    assert capped["shares"] == 73 and capped["capped"]
    assert plans.position(100.0, 100.0, 100000, 1.0)["shares"] == 0


# ------------------------------------------------------------- rule evidence
def _sim(rs):
    idx = [date(2026, 1, 1) + timedelta(days=i) for i in range(len(rs))]
    status = ["time" if np.isfinite(r) else "not_triggered" for r in rs]
    return pd.DataFrame({"status": status, "r": rs, "r_gross": rs, "ret_pct": rs,
                         "ambiguous": False}, index=idx)


def test_rule_stats():
    st = backtest.rule_stats(_sim([1.0, -1.0, np.nan, -1.0, 2.0, -0.5, np.nan]))
    assert st["plans"] == 7 and st["trades"] == 5
    assert st["trigger_rate"] == pytest.approx(5 / 7, abs=1e-3)
    assert st["win_rate"] == 0.4 and st["expectancy_r"] == pytest.approx(0.1)
    assert st["profit_factor"] == pytest.approx(3.0 / 2.5)
    assert st["max_drawdown_r"] == -2.0 and st["longest_losing_streak"] == 2
    assert backtest.rule_stats(_sim([np.nan, np.nan]))["trades"] == 0


def test_monte_carlo_is_reproducible_and_ordered():
    r = np.random.default_rng(1).normal(0.05, 1.0, 300)
    a, b = backtest.monte_carlo(r), backtest.monte_carlo(r)
    assert a == b
    assert a["total_r"]["p05"] < a["total_r"]["p50"] < a["total_r"]["p95"]
    assert a["max_drawdown_r"]["p05"] <= a["max_drawdown_r"]["p95"] <= 0
    assert backtest.monte_carlo(r[:10]) is None


def test_expanding_evidence_sees_only_the_past():
    rs = [1.0, np.nan, -1.0, 3.0, np.nan, 1.0]
    ev = backtest.expanding_evidence(_sim(rs))
    assert list(ev["n"]) == [0, 1, 1, 2, 3, 3]
    assert np.isnan(ev["expectancy_r"].iloc[0])
    assert ev["expectancy_r"].iloc[3] == pytest.approx(0.0)       # mean of 1 and -1
    assert ev["expectancy_r"].iloc[5] == pytest.approx(1.0)       # mean of 1, -1, 3
    # Changing a later outcome must not change earlier evidence.
    rs2 = rs[:3] + [-9.0] + rs[4:]
    ev2 = backtest.expanding_evidence(_sim(rs2))
    assert ev2["expectancy_r"].iloc[:4].equals(ev["expectancy_r"].iloc[:4])


# ------------------------------------------------------------------ decisions
def _ev(n, mean, t):
    return {"n": n, "expectancy_r": mean, "t_stat": t}


def test_decision_no_trade_when_nothing_made_money():
    out = decide.choose({"breakout": _ev(400, -0.2, -5.0), "pullback": _ev(400, -0.1, -2.0)},
                        {"breakout": -0.22, "pullback": -0.10}, turnover_cr=900)
    assert out["call"] == decide.NO_TRADE and out["label"] == "no tested edge"
    assert out["kind"] is None and out["reference_kind"] == "pullback"


def test_decision_grades_evidence_and_shrinks_small_samples():
    pooled = {"gap_reversal": 0.02, "breakout": -0.22}
    weak = decide.choose({"gap_reversal": _ev(60, 0.15, 1.1), "breakout": _ev(500, -0.2, -4)},
                         pooled, turnover_cr=900)
    assert weak["call"] == decide.NEUTRAL and weak["kind"] == "gap_reversal"
    assert weak["evidence"]["gap_reversal"]["shrunk_r"] == pytest.approx((60 * 0.15 + 200 * 0.02) / 260, abs=1e-4)
    strong = decide.choose({"gap_reversal": _ev(300, 0.25, 2.6)}, pooled, turnover_cr=900)
    assert strong["call"] == decide.FAVOURABLE and strong["label"] == "supported"
    # A lucky small sample of a losing rule is pulled below zero by the pooled record.
    lucky = decide.choose({"breakout": _ev(45, 0.3, 1.5)}, pooled, turnover_cr=900)
    assert lucky["call"] == decide.NO_TRADE


def test_decision_gates():
    ev = {"gap_reversal": _ev(300, 0.25, 2.6)}
    pooled = {"gap_reversal": 0.02}
    assert decide.choose(ev, pooled, turnover_cr=5)["label"] == "illiquid"
    assert decide.choose(ev, pooled, turnover_cr=900, flags=["Sources disagree"])["label"] == "data flag"
    assert decide.choose({"gap_reversal": _ev(10, 0.5, 2.5)}, pooled, 900)["label"] == "not enough history"


# ---------------------------------------------------------------- setup score
def test_tent_shape():
    x = np.array([-1.0, 0.0, 0.5, 1.0, 2.0, 3.0, 4.0, np.nan])
    y = setupscore.tent(x, 0, 1, 2, 4)
    assert list(y[:7]) == [0.0, 0.0, 0.5, 1.0, 1.0, 0.5, 0.0] and np.isnan(y[7])


def test_setup_score_range_and_direction():
    up = pd.Series(np.linspace(100, 160, 300) * (1 + 0.004 * np.sin(np.arange(300))))
    down = pd.Series(np.linspace(160, 100, 300) * (1 + 0.004 * np.sin(np.arange(300))))
    frame = lambda c: pd.DataFrame({"open": c, "high": c * 1.01, "low": c * 0.99, "close": c,
                                    "volume": 1000.0})
    s_up = setupscore.setup_score(ft.compute_features(frame(up)))
    s_down = setupscore.setup_score(ft.compute_features(frame(down)))
    assert 0 <= s_down["setup"].iloc[-1] < s_up["setup"].iloc[-1] <= 100
    assert s_up["trend"].iloc[-1] > 0.8 and s_down["trend"].iloc[-1] < 0.2
    assert np.isnan(s_up["setup"].iloc[50])                   # not ready before 200 sessions


# ------------------------------------------------- measured price adjustment
def _days(n):
    out, d = [], date(2026, 1, 1)
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def test_adjustment_rejects_a_vendor_step_the_official_price_does_not_show():
    days = _days(40)
    official = pd.Series(np.linspace(1000, 1040, 40), index=days)       # no discontinuity at all
    nse = pd.DataFrame({"open": official.shift(1).fillna(1000.0), "close": official})
    vendor = official.copy()
    vendor.iloc[10:25] = vendor.iloc[10:25] / 1.5                        # vendor adjusted only a slice
    adj = clean.empirical_factor(nse, vendor)
    assert len(adj.artefacts) == 2 and (adj.factor == 1.0).all()
    assert adj.vendor_factor.iloc[15] == pytest.approx(1.5)


def test_adjustment_follows_a_real_bonus_and_flags_a_bad_print():
    days = _days(40)
    base = np.linspace(1000, 1040, 40)
    official = pd.Series(np.where(np.arange(40) < 20, base * 2, base), index=days)   # 1:1 bonus on day 20
    opens = official.shift(1).fillna(official.iloc[0])
    opens.iloc[20] = official.iloc[20]                                   # opens at the halved price
    nse = pd.DataFrame({"open": opens, "close": official})
    vendor = pd.Series(base, index=days)
    vendor.iloc[30] *= 1.04                                              # one bad print
    adj = clean.empirical_factor(nse, vendor)
    assert adj.factor.iloc[5] == pytest.approx(2.0) and adj.factor.iloc[25] == 1.0
    assert adj.bad_prints == [days[30]] and not adj.artefacts


def test_unadjusted_gap_is_repaired_and_reported():
    days = _days(6)
    df = pd.DataFrame({"open": [100, 101, 102, 60, 61, 62], "high": [102, 103, 104, 62, 63, 64],
                       "low": [99, 100, 101, 59, 60, 61], "close": [101.0, 102.0, 100.0, 61.0, 62.0, 63.0],
                       "adjclose": [101.0, 102.0, 100.0, 61.0, 62.0, 63.0],
                       "volume": [10.0] * 6, "factor": 1.0}, index=days)
    issues = clean.repair_unadjusted_gaps(df)
    assert [i["issue"] for i in issues] == ["estimated_corporate_action"]
    assert df["close"].iloc[2] == pytest.approx(60.0) and df["volume"].iloc[0] == pytest.approx(10 / 0.6)
    assert (df["open"] / df["close"].shift(1) - 1).min() > -0.05
