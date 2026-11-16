"""Phase 7 tests: 5-minute replay settles what a daily bar cannot."""
from datetime import datetime, timedelta

import pandas as pd
import pytest

from pipeline import replay

DAY = datetime(2026, 11, 16, 9, 15)


def session(path, spread=0.2):
    """75 five-minute bars following `path`: {bar index: price}; held flat in between."""
    rows, price = [], path[0]
    for k in range(75):
        nxt = path.get(k, price)
        o, c = price, nxt
        rows.append({"ts": DAY + timedelta(minutes=5 * k), "open": o, "high": max(o, c) + spread,
                     "low": min(o, c) - spread, "close": c, "volume": 1000})
        price = nxt
    return pd.DataFrame(rows)


BREAKOUT = {"entry": 101.2, "stop": 99.2, "t1": 103.2, "t2": 105.2, "risk": 2.0}
PULLBACK = {"entry": 99.0, "stop": 97.4, "t1": 100.6, "t2": 102.2, "risk": 1.6}
GAP = {"entry": 98.5, "stop": 95.5, "t1": 100.0, "t2": 100.0, "risk": 3.0, "floor": 94.0}


def run(kind, lv, path, **kw):
    return replay.replay_plan(kind, lv, session(path, **kw), 0.0)


def test_breakout_time_exit_at_1515():
    res = run("breakout", BREAKOUT, {0: 100.0, 10: 101.8, 40: 102.0})
    assert res["status"] == "time" and res["fill_time"] == "10:05"
    assert res["exit_time"] == "15:15" and res["exit"] == pytest.approx(102.0)
    assert res["fill"] == pytest.approx(101.2) and res["source"] == "5m"


def test_five_minute_path_settles_stop_versus_target_order():
    # Daily bar would show both the target and the stop inside one session.
    target_first = run("breakout", BREAKOUT, {0: 100.0, 5: 102.0, 10: 105.5, 30: 98.5})
    assert target_first["status"] == "t2" and target_first["exit"] == pytest.approx(105.2)
    stop_first = run("breakout", BREAKOUT, {0: 100.0, 5: 102.0, 10: 98.5, 30: 105.5})
    assert stop_first["status"] == "stopped" and stop_first["exit"] == pytest.approx(99.2)
    assert stop_first["r_gross"] == pytest.approx(-1.0)


def test_first_target_then_rest_keeps_the_stop():
    res = run("breakout", BREAKOUT, {0: 100.0, 5: 102.0, 10: 103.5, 20: 98.0})
    assert res["status"] == "t1"                                  # half at 103.2, half stopped at 99.2
    assert res["exit"] == pytest.approx(0.5 * 103.2 + 0.5 * 99.2)
    res = run("breakout", BREAKOUT, {0: 100.0, 5: 102.0, 10: 103.5, 20: 102.5})
    assert res["status"] == "t1" and res["exit"] == pytest.approx(0.5 * 103.2 + 0.5 * 102.5)


def test_no_entry_after_1430_and_touch_is_not_a_fill():
    late = run("breakout", BREAKOUT, {0: 100.0, 64: 102.5})       # bar 64 starts at 14:35
    assert late["status"] == "not_triggered"
    touch = run("breakout", BREAKOUT, {0: 100.0, 10: 101.0}, spread=0.2)   # high is exactly 101.2
    assert touch["status"] == "not_triggered"


def test_breakout_cancelled_on_gap():
    assert run("breakout", BREAKOUT, {0: 99.0})["status"] == "cancelled"
    assert run("breakout", BREAKOUT, {0: 103.5})["status"] == "cancelled"


def test_pullback_fill_and_target_after_the_dip():
    # The high of the day comes after the dip, so the target genuinely counts.
    res = run("pullback", PULLBACK, {0: 100.0, 5: 98.6, 20: 101.0})
    assert res["status"] == "t1" and res["fill"] == pytest.approx(99.0)
    res = run("pullback", PULLBACK, {0: 100.0, 5: 98.6, 20: 96.5})
    assert res["status"] == "stopped"
    assert run("pullback", PULLBACK, {0: 100.0, 5: 99.5})["status"] == "not_triggered"


def test_gap_reversal_from_the_open():
    res = run("gap_reversal", GAP, {0: 98.0, 10: 100.5})
    assert res["status"] == "t2" and res["fill_time"] == "09:15" and res["exit"] == pytest.approx(100.0)
    res = run("gap_reversal", GAP, {0: 98.0, 10: 94.5})
    assert res["status"] == "stopped" and res["exit"] == pytest.approx(95.0)      # 3.0 under the fill
    assert run("gap_reversal", GAP, {0: 99.5})["status"] == "not_triggered"
    assert run("gap_reversal", GAP, {0: 93.0})["status"] == "cancelled"


def test_plan_results_needs_a_full_session(monkeypatch):
    rec = {"symbol": "AAA", "inputs": {"slippage": 0.0005}, "plans": {"breakout": BREAKOUT}}
    monkeypatch.setattr(replay, "bars_for", lambda d: {"AAA": session({0: 100.0, 10: 101.8})})
    out = replay.plan_results(rec, DAY.date())
    assert out["breakout"]["status"] == "time" and out["breakout"]["r"] < out["breakout"]["r_gross"]
    monkeypatch.setattr(replay, "bars_for", lambda d: {"AAA": session({0: 100.0}).iloc[:20]})
    assert replay.plan_results(rec, DAY.date()) is None
    monkeypatch.setattr(replay, "bars_for", lambda d: {})
    assert replay.plan_results(rec, DAY.date()) is None
