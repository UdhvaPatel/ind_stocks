"""Phase 2 tests: indicators against hand-computed values, and no look-ahead."""
from datetime import date, timedelta

import numpy as np
import pandas as pd
import pytest

from pipeline import features as ft


def make_frame(n=420, seed=7):
    rng = np.random.default_rng(seed)
    rets = rng.normal(0.0004, 0.014, n)
    close = 1000 * np.exp(np.cumsum(rets))
    open_ = np.r_[close[0], close[:-1]] * (1 + rng.normal(0, 0.004, n))
    high = np.maximum(open_, close) * (1 + np.abs(rng.normal(0, 0.006, n)))
    low = np.minimum(open_, close) * (1 - np.abs(rng.normal(0, 0.006, n)))
    days, d = [], date(2024, 1, 1)
    while len(days) < n:
        if d.weekday() < 5:
            days.append(d)
        d += timedelta(days=1)
    return pd.DataFrame({"open": open_, "high": high, "low": low, "close": close,
                         "adjclose": close, "volume": rng.integers(1e5, 1e6, n).astype(float),
                         "deliv_pct": rng.uniform(30, 70, n)}, index=days)


def test_rsi_matches_hand_calculation():
    # Classic Wilder example series (first RSI value is 70.46 on day 15 of data).
    close = pd.Series([44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
                       45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64])
    delta = close.diff().dropna()
    gain, loss = delta.clip(lower=0), (-delta).clip(lower=0)
    # ewm(adjust=False) seeds with the first value, so replicate that recursion by hand.
    ag, al = gain.iloc[0], loss.iloc[0]
    for g, lo in zip(gain.iloc[1:], loss.iloc[1:]):
        ag, al = ag + (g - ag) / 14, al + (lo - al) / 14
    expected = 100 - 100 / (1 + ag / al)
    assert ft.rsi(close, 14).iloc[-1] == pytest.approx(expected, rel=1e-9)
    assert 0 < expected < 100


def test_rsi_is_100_when_price_only_rises():
    assert ft.rsi(pd.Series(np.arange(1.0, 40.0)), 14).iloc[-1] == 100.0


def test_atr_and_true_range():
    df = pd.DataFrame({"high": [10.0, 11.0, 12.0], "low": [9.0, 10.5, 9.5],
                       "close": [9.5, 10.8, 10.0], "open": [9.2, 10.6, 11.9]})
    tr = ft.true_range(df)
    assert list(tr) == [1.0, pytest.approx(1.5), pytest.approx(2.5)]


def test_percentile_and_range_position():
    df = make_frame(60)
    df.iloc[-1, df.columns.get_loc("close")] = df["close"].max() * 1.5
    df.iloc[-1, df.columns.get_loc("high")] = df["close"].iloc[-1]
    f = ft.compute_features(df)
    assert f["pct_rank_20"].iloc[-1] == 100.0
    assert f["range_pos_20"].iloc[-1] == pytest.approx(100.0)
    assert f["drawdown"].iloc[-1] == 0.0
    assert f["donchian"].iloc[-1] == 1


def test_trend_fit_on_exact_exponential():
    close = pd.Series(100 * np.exp(0.002 * np.arange(80)))
    slope, r2 = ft.trend_fit(close, 20)
    assert slope.iloc[-1] == pytest.approx(0.2, rel=1e-6)      # 0.2% a day
    assert r2.iloc[-1] == pytest.approx(1.0, rel=1e-9)


def test_trend_state_and_sma_distance():
    close = pd.Series(np.linspace(100, 200, 260))
    df = pd.DataFrame({"open": close, "high": close * 1.01, "low": close * 0.99,
                       "close": close, "volume": 1000.0})
    f = ft.compute_features(df)
    assert f["trend_state"].iloc[-1] == 1 and f["cross_state"].iloc[-1] == 1
    assert f["dist_sma_20"].iloc[-1] > 0
    assert np.isnan(f["trend_state"].iloc[100])                # no 200-day average yet


def test_beta_of_benchmark_against_itself_is_one():
    df = make_frame(400)
    f = ft.compute_features(df, bench=df["close"])
    assert f["beta_252"].iloc[-1] == pytest.approx(1.0, rel=1e-9)
    assert f["corr_252"].iloc[-1] == pytest.approx(1.0, rel=1e-9)
    assert f["rs_21"].iloc[-1] == pytest.approx(0.0, abs=1e-9)


def test_no_look_ahead_truncation():
    """Row t computed on history cut at t must equal row t computed on the full file."""
    df = make_frame(420)
    bench = make_frame(420, seed=11)["close"]
    full = ft.compute_features(df, bench)
    for cut in (300, 360, 419):
        part = ft.compute_features(df.iloc[:cut + 1], bench.iloc[:cut + 1])
        a, b = full.iloc[cut], part.iloc[-1]
        assert a.index.equals(b.index)
        for col in a.index:
            if pd.isna(a[col]) and pd.isna(b[col]):
                continue
            assert a[col] == pytest.approx(b[col], rel=1e-7, abs=1e-7), col


def test_market_features_regimes():
    days = [date(2024, 1, 1) + timedelta(days=i) for i in range(300)]
    vix = pd.Series(np.r_[np.full(299, 14.0) + np.linspace(0, 1, 299), 40.0], index=days)
    breadth = pd.DataFrame({"date": days, "advances": 1500, "declines": 500})
    m = ft.market_features(vix, breadth, None)
    assert m["vix_regime"].iloc[-1] == 1
    assert m["adv_pct"].iloc[-1] == 75.0
