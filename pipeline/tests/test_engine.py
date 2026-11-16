"""The engine must give the same book live and in replay (no look-ahead)."""
import json
from datetime import date, timedelta

import numpy as np
import pandas as pd
import pytest

from pipeline import plans
from pipeline.dataset import Dataset
from pipeline.engine import Engine
from pipeline.tests.test_features import make_frame
from pipeline.tradingcal import TradingCalendar


def synthetic_dataset(n=520, symbols=("AAA", "BBB", "CCC")):
    frames = {}
    for k, sym in enumerate(symbols):
        df = make_frame(n, seed=100 + k)
        df["turnover"] = df["close"] * df["volume"] * 5000        # comfortably liquid
        frames[sym] = df
    days = list(frames[symbols[0]].index)
    nifty = make_frame(n, seed=7)[["open", "high", "low", "close"]]
    vix = pd.DataFrame({"open": 15.0, "high": 16.0, "low": 14.0,
                        "close": 15 + np.sin(np.arange(n) / 9.0)}, index=days)
    us_days = [d for d in (days[0] + timedelta(days=i) for i in range((days[-1] - days[0]).days + 1))
               if d.weekday() < 5]
    rng = np.random.default_rng(5)
    sp = pd.DataFrame({"close": 4000 * np.exp(np.cumsum(rng.normal(0, 0.01, len(us_days))))}, index=us_days)
    for col in ("open", "high", "low"):
        sp[col] = sp["close"]
    breadth = pd.DataFrame({"date": days, "advances": 1200, "declines": 800, "unchanged": 10,
                            "stocks": 2010, "turnover": 1e12})
    ds = Dataset(frames=frames, indices={"NIFTY50": nifty, "INDIAVIX": vix},
                 overnight={"SP500": sp}, breadth=breadth,
                 valuation=pd.DataFrame(columns=["pe", "pb", "div_yield"]), last_session=days[-1])
    return ds, TradingCalendar(open_days=days)


def _plain(book):
    """The publishable part of a book, as comparable JSON."""
    keep = ("symbol", "as_of", "prev", "atr", "setup", "claims", "plans", "decision", "overnight_z")
    return json.loads(json.dumps({s: {k: e[k] for k in keep} for s, e in book.items()}, default=float))


def test_book_is_complete():
    ds, cal = synthetic_dataset()
    eng = Engine(ds, cal)
    book = eng.book(eng.last_session, detail=True)
    assert set(book) == {"AAA", "BBB", "CCC"}
    e = book["AAA"]
    assert set(e["plans"]) == set(plans.KINDS)
    for kind, lv in e["plans"].items():
        assert lv["stop"] < lv["entry"] and lv["t1"] <= lv["t2"] and lv["risk"] > 0
        assert 0 <= lv["p_trigger"] <= 1
    c = e["claims"]
    assert c["close"]["p05"] < c["close"]["p50"] < c["close"]["p95"]
    assert len(c["touch"]) == 4 and all(0 <= t["p"] <= 1 for t in c["touch"])
    assert e["decision"]["call"] in ("FAVOURABLE", "NEUTRAL", "NO_TRADE")
    assert set(e["rules"]) == set(plans.KINDS) and e["rules"]["breakout"]["trades"] > 50
    assert 0 <= e["setup"] <= 100


def test_replay_equals_live_no_look_ahead():
    ds, cal = synthetic_dataset()
    full = Engine(ds, cal)
    days = list(ds.frames["AAA"].index)
    for k in (400, 470, len(days) - 2):
        as_of = days[k]
        nxt = cal.next_trading_day(as_of)
        live = Engine(ds.truncated(as_of, nxt), cal)          # only what was known that morning
        assert live.last_session == as_of
        a, b = _plain(full.book(as_of)), _plain(live.book(as_of))
        assert a == b, f"replay differs from live on {as_of}"


def test_pooled_record_uses_only_resolved_plans():
    ds, cal = synthetic_dataset()
    eng = Engine(ds, cal)
    days = list(ds.frames["AAA"].index)
    as_of = days[300]
    manual = []
    for st in eng.states.values():
        sim = st.sims["breakout"]
        ok = sim["status"].isin(plans.TRADED) & sim["r"].notna() & (np.array(sim.index) < as_of)
        manual += list(sim.loc[ok, "r"])
    assert eng.pooled_mean("breakout", as_of) == pytest.approx(np.mean(manual), rel=1e-12)
    assert eng.pooled_mean("breakout", days[0]) == 0.0
