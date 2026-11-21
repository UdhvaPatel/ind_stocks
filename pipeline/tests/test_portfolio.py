"""Paper portfolio, weekly allocator and range study."""
import json
from datetime import date, datetime, timedelta, timezone

import numpy as np
import pandas as pd
import pytest

from pipeline import allocator, config, costs, ledger, portfolio, range_study, walkforward
from pipeline.engine import Engine
from pipeline.tests.test_engine import synthetic_dataset

C = {"capital": 100000, "risk_per_trade": 500, "max_position_pct": 0.25, "max_positions": 4, "portfolio_version": "test",
     "first_day": "2026-11-23", "min_days_for_verdict": 60,
     "books": {"desk": {"label": "Desk"}, "practice": {"label": "Practice", "per_rule": 2}},
     "allocator": {"ev_threshold_r": 0.05, "kelly_fraction": 0.25, "max_risk_per_trade_pct": 0.5, "max_risk_per_day_pct": 2.0,
                   "min_training_trades": 20, "shadow_days_before_promotion": 60, "promotion_t": 2.0}}


def rec(sym, call="NEUTRAL", kind="breakout", shrunk=0.05, entry=100.0, stop=98.0, day="2026-11-23"):
    lv = {"entry": entry, "stop": stop, "t1": entry + 2, "t2": entry + 4, "risk": entry - stop}
    return {"id": f"{day}|{sym}|1", "symbol": sym, "for_date": day, "model_version": "1",
            "call": {"call": call, "kind": kind if call != "NO_TRADE" else None},
            "plans": {"breakout": lv, "pullback": dict(lv), "gap_reversal": dict(lv)},
            "evidence": {"breakout": {"shrunk_r": shrunk}, "pullback": {"shrunk_r": shrunk - 0.1}, "gap_reversal": {"shrunk_r": shrunk - 0.2}}}


def test_sizing_respects_the_risk_and_position_caps():
    assert portfolio.size({"entry": 100, "stop": 98, "risk": 2}, C) == 250          # 500 / 2 = 250 shares = 25,000: both caps meet
    assert portfolio.size({"entry": 100, "stop": 99, "risk": 1}, C) == 250          # risk allows 500, 25% cap allows 250
    assert portfolio.size({"entry": 1000, "stop": 900, "risk": 100}, C) == 5
    assert portfolio.size({"entry": 100, "stop": 101}, C) == 0                      # stop above entry: no position
    assert portfolio.size({}, C) == 0


def test_desk_takes_only_called_plans_best_record_first_within_capital():
    records = [rec("AAA", shrunk=0.02), rec("BBB", shrunk=0.09), rec("CCC", call="NO_TRADE"), rec("DDD", shrunk=0.05),
               rec("EEE", shrunk=0.04), rec("FFF", shrunk=0.03)]
    desk = portfolio.desk_orders(records, C)
    assert [o["symbol"] for o in desk] == ["BBB", "DDD", "EEE", "FFF"], "4 positions of 25,000: capital is used up"
    assert all(o["shares"] * o["entry"] <= 25000 for o in desk)
    assert sum(o["shares"] * o["entry"] for o in desk) <= C["capital"]
    assert portfolio.desk_orders([rec("CCC", call="NO_TRADE")], C) == [], "a Wait day keeps the money"


def test_practice_book_takes_the_best_of_each_rule_whatever_the_call():
    records = [rec(s, call="NO_TRADE", shrunk=x) for s, x in (("AAA", 0.1), ("BBB", 0.2), ("CCC", 0.3))]
    small = dict(C, max_position_pct=0.05)                                           # small positions so all fit
    book = portfolio.practice_orders(records, small)
    # per rule the top two are CCC then BBB; one position per stock, so the dip and gap picks repeat them
    assert [(o["symbol"], o["kind"]) for o in book] == [("CCC", "breakout"), ("BBB", "breakout")]


def test_orders_are_written_once_and_verified_only_before_the_open(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(portfolio, "cfg", lambda: C)
    monkeypatch.setattr(ledger, "load", lambda a=None, b=None: [rec("AAA"), rec("BBB", shrunk=0.08)])
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    early = datetime(2026, 11, 23, 0, 40, tzinfo=timezone.utc)                       # 06:10 IST
    assert portfolio.issue(date(2026, 11, 23), "1", now=early) == 2                    # desk + practice
    assert portfolio.issue(date(2026, 11, 23), "1", now=early) == 0, "never written twice"
    lines = portfolio.load_orders()
    assert {l["book"] for l in lines} == {"desk", "practice"}
    assert all(ledger.verified(l) for l in lines)
    late = {**lines[0], "made_at": "2026-11-23T04:00:00+00:00"}                        # 09:30 IST
    assert not ledger.verified(late)


def test_rupee_results_use_the_scorers_fills_and_real_charges():
    ccfg = costs.cost_cfg()
    order = {"symbol": "AAA", "kind": "breakout", "shares": 100, "entry": 100.0}
    won = portfolio.position_result(order, {"status": "t2", "fill": 100.05, "exit": 103.0}, ccfg)
    expected = 100 * (103.0 - 100.05) - float(costs.charges(100 * 100.05, 100 * 103.0, ccfg))
    assert won["pnl"] == pytest.approx(round(expected, 2))
    assert portfolio.position_result(order, {"status": "not_triggered"}, ccfg)["pnl"] == 0.0
    assert portfolio.position_result(order, None, ccfg)["status"] == "pending"


def test_a_session_is_scored_only_when_all_its_plans_are():
    ccfg = costs.cost_cfg()
    line = {"for_date": "2026-11-23", "made_at": "2026-11-23T00:40:00+00:00", "source": {"runner": "github-actions"},
            "orders": [{"symbol": "AAA", "kind": "breakout", "shares": 100, "entry": 100.0, "record_id": "a"}]}
    assert portfolio.score_line(line, {}, ccfg) is None
    scores = {"a": {"status": "scored", "verified": True, "plans": {"breakout": {"status": "stopped", "fill": 100.05, "exit": 97.9}}}}
    day = portfolio.score_line(line, scores, ccfg)
    assert day["verified"] and day["trades"] == 1 and day["pnl"] < 0 and day["wins"] == 0
    scores["a"]["verified"] = False                                                    # a plan made on a laptop
    assert portfolio.score_line(line, scores, ccfg)["verified"] is False
    t = portfolio.totals([day, {**day, "verified": False}])
    assert t["sessions"] == 1, "unverified sessions never count"


@pytest.fixture(scope="module")
def engine():
    ds, cal = synthetic_dataset()
    return Engine(ds, cal)


def test_allocator_sizing_threshold_and_caps():
    lv = {"entry": 100.0, "stop": 98.0, "risk": 2.0}
    cands = [{"symbol": f"S{i}", "kind": "breakout", "ev": ev, "er": 0.4, "r_var": 1.0, "lv": lv}
             for i, ev in enumerate([0.30, 0.20, 0.10, 0.08, 0.06, 0.04])]
    book = allocator.choose(cands, C)
    assert len(book) == 4 and all(o["ev_r"] > 0.05 for o in book), "below the threshold, or over the cap of 4: cash"
    assert all(o["shares"] * 2.0 <= 500 + 1e-9 for o in book), "risk per trade at most 0.5% of capital"
    assert allocator.choose([{**cands[0], "ev": 0.01}], C) == []


def test_allocator_walk_forward_uses_only_the_past_and_reports(engine):
    as_of = engine.last_session
    scores = walkforward.replay(engine, as_of - timedelta(days=400), as_of, "test")
    wf = allocator.walk_forward(scores, C, engine.ccfg, log=None)
    assert wf["weeks"] > 10
    assert "passed_walk_forward" in wf and isinstance(wf["passed_walk_forward"], bool)
    assert wf["passed_walk_forward"] is False, "random synthetic prices must not pass the gate"
    rows = allocator.rows_from_scores(scores)
    m = allocator.fit(rows["breakout"]["X"], rows["breakout"]["trig"], rows["breakout"]["r"])
    p, er = allocator.predict(m, rows["breakout"]["X"][:5])
    assert ((p > 0) & (p < 1)).all() and np.isfinite(er).all()


def test_range_study_keeps_the_current_range_without_enough_live_evidence():
    rng = np.random.default_rng(0)
    days = [f"2026-{9 + (i // 22):02d}-{1 + i % 22:02d}" for i in range(60)]
    cols = ["day", "prev", "p05", "p50", "p95", "close", "ret"]
    stocks = {f"S{k}": [[i, 100, -2.0, 0.0, 2.0, 100, float(rng.normal(0, 1.2))] for i in range(60)] for k in range(20)}
    compare = {"cols": cols, "days": days, "track": ["backtest"] * 60, "stocks": stocks}
    out = range_study.study(compare, {})
    # the conformal factor needs at least 200 earlier stock-days: 10 days of 20 stocks
    assert out["sessions"] == 60 - 10
    assert out["ready"] is False and "keep the current range" in out["decision"]
    assert 0.8 < out["challenger"]["coverage"] < 1.0
    assert "0 of 40 verified live sessions" in out["decision"]
