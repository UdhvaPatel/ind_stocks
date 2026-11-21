"""Swing research: costs, the benchmark, the statistic and the pass rule."""
import json
from datetime import date

import numpy as np
import pandas as pd

from pipeline import publish, research
from pipeline.costs import cost_cfg


def _frames(n_days=900, n_stocks=40, seed=1, bounce=0.0, start="2016-11-01"):
    """Random-walk stocks. `bounce` > 0 plants a real edge: after a day down 3% or more,
    each of the next five days gains that much extra."""
    rng = np.random.default_rng(seed)
    days = pd.bdate_range(start, periods=n_days).date
    out = {}
    for k in range(n_stocks):
        sym = f"S{k:02d}"
        r = rng.normal(0.0004, 0.016, n_days)
        if bounce:
            boost = 0
            for i in range(n_days):
                if boost:
                    r[i] += bounce
                    boost -= 1
                if r[i] <= -0.03:
                    boost = 5
        close = 100 * np.exp(np.cumsum(r))
        open_ = close * np.exp(rng.normal(0, 0.004, n_days))
        out[sym] = pd.DataFrame({"open": open_, "close": close, "adjclose": close, "volume": 2e6}, index=days)
    return out


def test_delivery_cost_is_about_four_tenths_of_a_percent():
    c = research.delivery_cost_pct(0.0005, cost_cfg())
    assert 0.0035 < c < 0.0042                         # STT 0.2% + slippage 0.1% + stamp, fees, DP charge
    assert research.delivery_cost_pct(0.0015, cost_cfg()) > c


def test_newey_west_t_detects_a_real_mean_and_not_noise():
    rng = np.random.default_rng(0)
    assert abs(research.newey_west_t(rng.normal(0, 1, 2000), 3)) < 3
    assert research.newey_west_t(rng.normal(0.2, 1, 2000), 3) > 5
    assert np.isnan(research.newey_west_t(np.ones(5), 2))


def test_benchmark_is_fair_and_random_rules_do_not_pass():
    frames = _frames()
    panel = research.build_panel(frames)
    for H in research.ALL_HORIZONS:                    # 'buy everything' has zero excess before costs
        fwd = panel[f"fwd{H}"]
        assert abs(fwd.sub(fwd.mean(axis=1), axis=0).mean(axis=1).mean()) < 1e-12
    out = research.combined(frames, cost_cfg())
    json.dumps(publish.clean(out), allow_nan=False)
    assert out["variants_tested"] == 6 * len(research.ALL_HORIZONS)
    assert out["passed"] == []                         # no edge exists in random walks
    assert all(v["validation"]["excess_pct"] < 0 for v in out["variants"] if v["validation"].get("trades"))
    assert "None of the" in out["verdict"]


def test_a_real_edge_is_found():
    """Positive control: the method must be able to say yes, or its 'no' would mean nothing."""
    frames = _frames(n_days=2600, n_stocks=40, seed=3, bounce=0.006)   # ~2016-2026, like the real data
    out = research.combined(frames, cost_cfg())
    passed = set(out["passed"])
    assert {"big_drop:3", "big_drop:5"} <= passed, out["passed"]
    assert "None of the" not in out["verdict"]


def test_no_lookahead_signals_ignore_the_future():
    frames = _frames(n_days=700)
    cut = list(frames["S00"].index)[600]
    full = research.build_panel(frames)
    trunc = research.build_panel({k: v[v.index <= cut] for k, v in frames.items()})
    for key in ("rsi2_dip", "three_down", "breakout_20", "big_drop", "weak_week", "momentum"):
        a = full[key].loc[:cut].fillna(False).astype(bool)
        b = trunc[key].loc[:cut].fillna(False).astype(bool)
        assert a.equals(b), key


def test_period_split():
    idx = [date(2016, 12, 30), date(2017, 1, 2), date(2020, 12, 31), date(2021, 1, 1), date(2026, 11, 20)]
    assert list(research.in_period(idx, research.DISCOVERY)) == [False, True, True, False, False]
    assert list(research.in_period(idx, research.VALIDATION)) == [False, False, False, True, True]
