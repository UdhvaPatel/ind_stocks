"""Phase 2 tests: analog forecasts are sane, calibrated on noise, and free of look-ahead."""
from datetime import date, timedelta

import numpy as np
import pandas as pd
import pytest

from pipeline import features as ft
from pipeline.forecast import SymbolModel, overnight_signal
from pipeline.tests.test_features import make_frame


def _model(n=900, seed=3, overnight=None):
    df = make_frame(n, seed)
    return df, SymbolModel(df, ft.compute_features(df), overnight)


def test_forecast_basic_shape_and_order():
    df, m = _model()
    fc = m.forecast(len(df) - 1)
    assert fc.ok and fc.n >= 60
    c = fc.close
    assert c["p05"] < c["p25"] < c["p50"] < c["p75"] < c["p95"]
    assert fc.low["p50"] < 0 < fc.high["p50"]
    assert 0.3 < fc.p_up < 0.7
    assert fc.touch_up(0.0) > fc.touch_up(1.0) > fc.touch_up(5.0)
    assert fc.touch_down(0.0) > fc.touch_down(-5.0)
    js = fc.to_json()
    assert set(js["close"]) == {"p05", "p25", "p50", "p75", "p95"} and js["n"] == fc.n


def test_forecast_uses_no_future_rows():
    df, full = _model()
    feat = ft.compute_features(df)
    for i in (500, 700, 880):
        part = SymbolModel(df.iloc[:i + 1], feat.iloc[:i + 1])
        a, b = full.forecast(i), part.forecast(i)
        assert a.n == b.n and a.tier == b.tier
        assert a.p_up == pytest.approx(b.p_up, rel=1e-9)
        assert a.close == pytest.approx(b.close, rel=1e-9)
        np.testing.assert_allclose(a.s_hi, b.s_hi, rtol=1e-9)


def test_ninety_percent_range_covers_about_ninety_percent_on_random_walk():
    df, m = _model(1500, seed=21)
    c = df["close"].values
    hits = total = 0
    for i in range(400, len(df) - 1):
        fc = m.forecast(i)
        if not fc.ok:
            continue
        realised = (c[i + 1] / c[i] - 1) * 100
        hits += fc.close["p05"] <= realised <= fc.close["p95"]
        total += 1
    assert total > 900
    assert 0.86 <= hits / total <= 0.94


def test_shrinkage_keeps_probability_near_base_rate_for_small_samples():
    df, m = _model()
    fc = m.forecast(len(df) - 1)
    raw = float(np.mean(fc.s_cc > 0))
    assert abs(fc.p_up - fc.base_p_up) <= abs(raw - fc.base_p_up) + 1e-12


def test_too_little_history_gives_no_forecast():
    df, m = _model(40)
    assert not m.forecast(len(df) - 1).ok


def test_overnight_signal_alignment():
    # US sessions Mon-Fri; Indian sessions Mon, Tue, Thu (Wed is an Indian holiday).
    us_days = [date(2026, 1, 1) + timedelta(days=i) for i in range(60)]
    us_days = [d for d in us_days if d.weekday() < 5]
    rng = np.random.default_rng(1)
    sp = pd.Series(4000 * np.exp(np.cumsum(rng.normal(0, 0.01, len(us_days)))), index=us_days)
    mon, tue, thu = date(2026, 2, 16), date(2026, 2, 17), date(2026, 2, 19)
    sig = overnight_signal(sp, [mon, tue, thu], next_day=date(2026, 2, 20))
    ret = np.log(sp).diff()
    sigma = ret.rolling(21, min_periods=10).std().shift(1)
    # Tuesday's signal is Monday's US session only.
    assert sig[tue] == pytest.approx(ret[mon] / sigma[mon], rel=1e-9)
    # Thursday's signal spans Tuesday and Wednesday US sessions.
    wed = date(2026, 2, 18)
    assert sig[thu] == pytest.approx((ret[tue] + ret[wed]) / sigma[tue], rel=1e-9)
    assert date(2026, 2, 20) in sig.index and sig[mon] == 0.0


def test_overnight_signal_shifts_the_centre_when_it_matters():
    # Build a stock whose next-day return is driven by the overnight signal.
    df = make_frame(1200, seed=5)
    rng = np.random.default_rng(9)
    x = pd.Series(rng.normal(0, 1, len(df)), index=df.index)
    close = [1000.0]
    for k in range(1, len(df)):
        close.append(close[-1] * (1 + 0.006 * x.iloc[k] + rng.normal(0, 0.004)))
    close = np.array(close)
    df["close"] = close
    df["open"] = np.r_[close[0], close[:-1]] * (1 + 0.006 * x.values)
    df["high"] = np.maximum(df["open"], df["close"]) * 1.002
    df["low"] = np.minimum(df["open"], df["close"]) * 0.998
    m = SymbolModel(df, ft.compute_features(df), x)
    i = len(df) - 1
    up, down = m.forecast(i, x_now=2.0), m.forecast(i, x_now=-2.0)
    assert up.close["p50"] > 0.5 > -0.5 > down.close["p50"]
    assert up.p_up > 0.8 and down.p_up < 0.2
