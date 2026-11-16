"""Publishing and the plan-issuing rules of the morning job."""
import json
from datetime import datetime, time, timedelta

import numpy as np
import pytest

from pipeline import config, jobs, ledger, publish
from pipeline.engine import Engine
from pipeline.tests.test_engine import synthetic_dataset


@pytest.fixture
def tmp_data(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    return tmp_path / "data"


@pytest.fixture(scope="module")
def engine():
    ds, cal = synthetic_dataset()
    return Engine(ds, cal)


def test_clean_makes_strict_json():
    obj = {"a": np.float64(1.5), "b": float("nan"), "c": np.int64(3), "d": [np.bool_(True), float("inf")],
           "e": datetime(2026, 11, 16).date()}
    out = publish.clean(obj)
    assert out == {"a": 1.5, "b": None, "c": 3, "d": [True, None], "e": "2026-11-16"}
    json.dumps(out, allow_nan=False)


def test_symbol_and_market_files_are_complete_and_strict_json(engine):
    as_of = engine.last_session
    for_date = engine.calendar.next_trading_day(as_of)
    book = engine.book(as_of, detail=True)
    pub = {"series_days": 120, "publish_prices": False}
    f = publish.clean(publish.symbol_file(engine, book["AAA"], {"name": "Alpha Ltd", "industry": "Test"},
                                          for_date, "draft", pub, []))
    json.dumps(f, allow_nan=False)
    for key in ("schema", "model_version", "generated_at", "symbol", "for_date", "last", "call", "plan",
                "plans", "rules", "claims", "forecast", "distribution", "health", "stats", "series"):
        assert key in f, key
    assert f["series"]["unit"] == "pct" and f["series"]["rows"][-1][4] == 0.0      # latest close = 0%
    assert len(f["series"]["rows"]) == 120 and len(f["series"]["sma20"]) == 120
    assert f["plan"]["reference"]["shares"] >= 0 and f["plan"]["reference"]["charges_if_stop"]["total"] > 0
    assert sum(len(g["cells"]) for g in f["stats"]) == len(publish.STAT_CELLS)

    raw = publish.series_block(engine.states["AAA"].df, engine.states["AAA"].feat, 60, True)
    assert raw["unit"] == "inr" and raw["rows"][-1][4] == raw["ref_close"]

    m = publish.clean(publish.market_file(engine, book, as_of))
    json.dumps(m, allow_nan=False)
    assert len(m["heatmap"]) == 3 and sum(m["calls"].values()) == 3
    assert {i["key"] for i in m["indices"]} == {"NIFTY50", "INDIAVIX"}


def test_day_summary_counts(engine):
    from pipeline import score
    as_of = engine.states["AAA"].dates[-2]
    for_date = engine.states["AAA"].dates[-1]
    scores = []
    for e in engine.book(as_of).values():
        rec = ledger.make_record(e, for_date, "1.0.0")
        bar = engine.states[e["symbol"]].df.iloc[-1][["open", "high", "low", "close"]].to_dict()
        s = score.resolve(rec, bar)
        s.update({"claims": rec["claims"], "plan_levels": rec["plans"], "prev_close": e["prev"]["close"]})
        scores.append(s)
    day = publish.clean(publish.day_summary(for_date.isoformat(), scores, "live", "1.0.0"))
    assert day["summary"]["stocks"] == 3 and day["summary"]["scored"] == 3
    assert 0 <= day["summary"]["dir_hit"] <= 1 and len(day["rows"][0]["range"]) == 3
    json.dumps(day, allow_nan=False)


def _at(monkeypatch, engine, day_offset, clock):
    """Pretend the India clock reads `clock` on the session after the data, plus an offset."""
    for_date = engine.calendar.next_trading_day(engine.last_session)
    now = datetime.combine(for_date + timedelta(days=day_offset), clock, tzinfo=config.IST)
    monkeypatch.setattr(config, "now_ist", lambda: now)
    return for_date


def test_plan_is_issued_only_on_its_day_and_before_the_cutoff(engine, tmp_data, monkeypatch):
    for_date = _at(monkeypatch, engine, -1, time(18, 30))            # the evening before
    assert jobs.issue_plan(engine) == ("draft", for_date) and not ledger.load()

    _at(monkeypatch, engine, 0, time(9, 5))                          # too late on the day
    assert jobs.issue_plan(engine) == ("not_issued", for_date) and not ledger.load()

    _at(monkeypatch, engine, 0, time(6, 2))                          # the 06:00 run
    assert jobs.issue_plan(engine) == ("scored", for_date)
    assert len(ledger.load()) == 3
    before = ledger.fingerprint()

    _at(monkeypatch, engine, 0, time(6, 32))                         # the retry half an hour later
    assert jobs.issue_plan(engine) == ("scored", for_date)
    assert ledger.fingerprint() == before                            # nothing rewritten

    _at(monkeypatch, engine, 0, time(18, 30))                        # evening of the same day
    assert jobs.issue_plan(engine)[0] == "scored"


def test_no_plan_when_the_data_is_stale(engine, tmp_data, monkeypatch):
    for_date = _at(monkeypatch, engine, 3, time(6, 2))               # three days after the plan's session
    assert jobs.issue_plan(engine) == ("not_issued", for_date) and not ledger.load()


def test_force_overrides_the_cutoff(engine, tmp_data, monkeypatch):
    _at(monkeypatch, engine, 0, time(9, 5))
    assert jobs.issue_plan(engine, force=True)[0] == "scored" and len(ledger.load()) == 3
