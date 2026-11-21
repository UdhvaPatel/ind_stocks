"""Trust and data-integrity guards: ledger verification, the 09:15 cut-off, open-direction
scoring, partial-file and closed-day guards, append-only ledger, freshness check, validation."""
import json
from datetime import date, datetime, time, timedelta

import pandas as pd
import pytest

from pipeline import check_fresh, config, ingest, jobs, ledger, ledger_guard, score, store, validate_site
from pipeline.http import FormatError
from pipeline.tests.test_publish_jobs import _at, engine, tmp_data  # noqa: F401  (fixtures)


def rec(made_at, for_date="2026-11-23", runner="github-actions"):
    return {"made_at": made_at, "for_date": for_date, "source": {"runner": runner}}


def test_only_scheduled_plans_made_before_the_open_count_as_live():
    assert ledger.verified(rec("2026-11-23T00:31:00+00:00"))                    # 06:01 IST by the workflow
    assert not ledger.verified(rec("2026-11-23T00:31:00+00:00", runner="local"))  # a laptop: timing unprovable
    assert not ledger.made_before_open(rec("2026-11-23T03:45:00+00:00"))         # 09:15 IST exactly: too late
    assert ledger.made_before_open(rec("2026-11-23T03:44:59+00:00"))
    assert not ledger.verified({"made_at": "nonsense", "for_date": "2026-11-23"})
    # The 16 Nov records: made at 03:55 IST on a laptop, no source -> unverified
    assert not ledger.verified({"made_at": "2026-11-15T22:25:59+00:00", "for_date": "2026-11-16"})
    assert jobs.day_track([{"verified": False}]) == "unverified"
    assert jobs.day_track([{"verified": False}, {"verified": True}]) == "live"


def test_new_records_say_where_they_were_made(monkeypatch):
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    monkeypatch.setenv("GITHUB_RUN_ID", "123")
    monkeypatch.delenv("GITHUB_REPOSITORY", raising=False)
    assert ledger.runner_info() == {"runner": "github-actions", "run_id": "123", "repository": None}
    monkeypatch.delenv("GITHUB_ACTIONS")
    assert ledger.runner_info()["runner"] == "local"


def test_no_plan_after_the_open_even_when_forced(engine, tmp_data, monkeypatch):  # noqa: F811
    _at(monkeypatch, engine, 0, time(9, 20))
    assert jobs.issue_plan(engine, force=True)[0] == "not_issued"
    assert not ledger.load()
    _at(monkeypatch, engine, 0, time(9, 10))                                      # force still lifts the 08:45 cut-off
    assert jobs.issue_plan(engine, force=True)[0] == "scored"


def test_direction_is_also_scored_from_the_open():
    r = {"id": "x", "symbol": "A", "for_date": "2026-11-23", "model_version": "1", "call": {"call": "NO_TRADE", "kind": None},
         "inputs": {"prev": {"close": 100.0}, "atr": 2.0, "slippage": 0.0005},
         "claims": {"dir": {"p_up": 0.6, "base_p_up": 0.5}, "baseline_close": {"p05": -2, "p95": 2},
                    "close": {"p05": -2, "p50": 0, "p95": 2}, "gap": {"p05": -1, "p95": 1}, "range": {"p90": 3}, "touch": []},
         "plans": {}}
    s = score.resolve(r, {"open": 102.0, "high": 102.5, "low": 100.5, "close": 101.0})   # gapped up, then fell
    assert s["dir"]["correct"] is True and s["dir"]["correct_open"] is False
    agg = score.aggregate([s] * 3)
    assert agg["direction"]["hit_open"]["mean"] == 0.0 and agg["direction"]["hit_days"]["days"] == 1


def _day(rows):
    return pd.DataFrame(rows, columns=["symbol", "open", "high", "low", "close"])


def test_partial_or_broken_official_files_are_refused():
    expected = {f"S{i}" for i in range(20)}
    good = _day([[f"S{i}", 100, 102, 99, 101] for i in range(20)])
    ingest.check_day(date(2026, 11, 20), good, expected)
    with pytest.raises(FormatError, match="only 10 of 20"):
        ingest.check_day(date(2026, 11, 20), good.head(10), expected)
    broken = _day([[f"S{i}", 100, 95, 99, 101] for i in range(20)])                # high below the close
    with pytest.raises(FormatError, match="impossible prices"):
        ingest.check_day(date(2026, 11, 20), broken, expected)


def test_a_missing_file_is_a_holiday_only_when_later_data_proves_it(monkeypatch):
    eod = pd.DataFrame([
        {"date": date(2026, 11, 19), "symbol": f"S{i}", "close": 100.0 + i, "prev_close": 99.0} for i in range(12)] + [
        {"date": date(2026, 11, 23), "symbol": f"S{i}", "close": 103.0, "prev_close": 100.0 + i} for i in range(12)] + [
        {"date": date(2026, 11, 25), "symbol": f"S{i}", "close": 104.0, "prev_close": 99.0} for i in range(12)])
    monkeypatch.setattr(store, "load_nse_eod", lambda start=None: eod)
    # 20 Nov: the next session's previous close equals the 19 Nov close -> nothing traded in between
    # 24 Nov: the 25 Nov previous close does not match the 23 Nov close -> a session is missing
    assert ingest.confirm_closed_days([date(2026, 11, 20), date(2026, 11, 24)]) == [date(2026, 11, 20)]


def test_ledger_may_only_grow_at_the_end():
    old = {"data/ledger/p.jsonl": "a\nb\n"}
    assert ledger_guard.violations(old, {"data/ledger/p.jsonl": "a\nb\nc\n"}) == []
    assert "line 2" in ledger_guard.violations(old, {"data/ledger/p.jsonl": "a\nB\nc\n"})[0]
    assert "deleted" in ledger_guard.violations(old, {})[0]
    assert "line 2" in ledger_guard.violations(old, {"data/ledger/p.jsonl": "a\n"})[0]


def test_freshness_check_catches_a_missed_day(tmp_data, monkeypatch):  # noqa: F811
    today = date(2026, 11, 23)
    meta = {"today_is_session": True, "today_ist": "2026-11-23", "last_eod_date": "2026-11-20",
            "plan_for_date": "2026-11-23", "model_version": "1.0.0", "pipeline_status": "ok"}
    assert "not ingested" in check_fresh.problems("eod", meta, today)[0]
    assert "no plan for today" in check_fresh.problems("premarket", meta, today)[0]
    assert check_fresh.problems("eod", {**meta, "last_eod_date": "2026-11-23"}, today) == []
    assert check_fresh.problems("eod", {**meta, "today_is_session": False}, today) == []


def test_validation_flags_a_broken_publish(tmp_data):  # noqa: F811
    tmp_data.mkdir(parents=True, exist_ok=True)
    (tmp_data / "meta.json").write_text(json.dumps({"schema": 1, "model_version": "1", "generated_at": "x",
        "last_eod_date": "2026-11-20", "plan_for_date": "2026-11-23", "symbols": ["AAA"]}), encoding="utf-8")
    found = validate_site.check()
    assert any("only 1 symbols" in p for p in found)
    assert any("symbols/AAA.json: missing" in p for p in found)
    assert any("planner.json: missing" in p for p in found)
