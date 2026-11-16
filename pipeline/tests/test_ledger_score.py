"""Phase 4 tests: append-only ledger, resolution, scoring maths and baselines."""
import json
from datetime import date, datetime, timedelta, timezone

import numpy as np
import pandas as pd
import pytest

from pipeline import config, costs, ledger, plans, score
from pipeline.engine import Engine
from pipeline.tests.test_engine import synthetic_dataset


@pytest.fixture
def tmp_data(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    return tmp_path / "data"


@pytest.fixture(scope="module")
def engine():
    ds, cal = synthetic_dataset()
    return Engine(ds, cal), cal


def _records(engine, k=-1):
    eng, cal = engine
    days = eng.states["AAA"].dates
    as_of = days[k]
    for_date = cal.next_trading_day(as_of) if k == -1 else days[k + 1]
    made = datetime(2026, 11, 16, 0, 31, tzinfo=timezone.utc)
    return [ledger.make_record(e, for_date, "1.0.0", made, vix=15.5)
            for e in eng.book(as_of).values()], for_date


# -------------------------------------------------------------------- ledger
def test_record_shape(engine):
    recs, for_date = _records(engine)
    r = recs[0]
    assert r["id"] == f"{for_date.isoformat()}|AAA|1.0.0"
    assert r["made_at"] == "2026-11-16T00:31:00+00:00" and len(r["data_hash"]) == 16
    assert set(r["plans"]) == set(plans.KINDS)
    assert set(r["call"]) == {"call", "kind", "reference_kind", "label"}
    json.dumps(r)                                              # plain JSON, no numpy types


def test_ledger_is_append_only_and_idempotent(engine, tmp_data):
    recs, _ = _records(engine)
    assert ledger.append(recs) == 3
    before = ledger.fingerprint()
    assert ledger.append(recs) == 0                            # re-running the morning job writes nothing
    changed = [dict(r, claims=None) for r in recs]             # a different prediction for the same id
    assert ledger.append(changed) == 0                         # ... is refused, the original stands
    older, _ = _records(engine, k=-30)
    assert ledger.append(older) == 3
    after = ledger.fingerprint()
    assert all(after[i] == h for i, h in before.items())       # no existing line changed
    assert len(after) == 6 and len(ledger.load()) == 6
    assert ledger.has_plan_for(date.fromisoformat(recs[0]["for_date"]), "1.0.0")
    assert not ledger.has_plan_for(date.fromisoformat(recs[0]["for_date"]), "2.0.0")


# ----------------------------------------------------------------- resolving
def test_resolve_one_agrees_with_vectorised_simulation():
    rng = np.random.default_rng(4)
    ccfg = costs.cost_cfg()
    checked = 0
    for kind in plans.KINDS:
        for _ in range(400):
            close, atr = 100.0, float(rng.uniform(1.0, 3.0))
            high, low = close + rng.uniform(0, 2), close - rng.uniform(0, 2)
            o = close + rng.normal(0, 1.5)
            c = o + rng.normal(0, 1.5)
            h, l = max(o, c) + rng.uniform(0, 2), min(o, c) - rng.uniform(0, 2)
            days = [date(2026, 11, 12), date(2026, 11, 13)]
            df = pd.DataFrame({"open": [close, o], "high": [high, h], "low": [low, l],
                               "close": [close, c]}, index=days)
            lv = plans.plan_levels(df, pd.DataFrame({"atr_14": [atr, atr]}, index=days), kind)
            vec = plans.simulate(df, lv, kind, 0.0005, ccfg).iloc[0]
            one = plans.resolve_one(kind, lv.iloc[0].to_dict(),
                                    {"open": o, "high": h, "low": l, "close": c}, 0.0005, ccfg)
            assert one["status"] == vec["status"], (kind, one, vec.to_dict())
            if vec["status"] in plans.TRADED:
                assert one["r"] == pytest.approx(vec["r"], abs=2e-4)
                assert one["r_gross"] == pytest.approx(vec["r_gross"], abs=2e-4)
                checked += 1
    assert checked > 200


def test_resolve_scores_every_claim(engine):
    recs, _ = _records(engine)
    rec = recs[0]
    prev = rec["inputs"]["prev"]["close"]
    bar = {"open": prev * 1.002, "high": prev * 1.02, "low": prev * 0.995, "close": prev * 1.01}
    s = score.resolve(rec, bar)
    assert s["status"] == "scored" and s["actual"]["ret_pct"] == pytest.approx(1.0, abs=1e-3)
    assert s["dir"]["up"] is True
    assert s["dir"]["brier"] == pytest.approx((rec["claims"]["dir"]["p_up"] - 1) ** 2, abs=1e-5)
    assert s["close"]["inside"] == (rec["claims"]["close"]["p05"] <= 1.0 <= rec["claims"]["close"]["p95"])
    assert {t["name"] for t in s["touch"]} == {"up_half_atr", "down_half_atr", "prev_high", "prev_low"}
    assert set(s["plans"]) == set(plans.KINDS)
    assert score.resolve(rec, None)["status"] == "void"
    assert score.resolve(rec, bar, void_reason="corporate action")["reason"] == "corporate action"


def test_interval_score_penalises_misses():
    assert score.pinball(-2, 2, 0.0) == 4.0
    assert score.pinball(-2, 2, 3.0) == pytest.approx(4.0 + 20 * 1.0)
    assert score.pinball(-1, 1, 0.0) < score.pinball(-2, 2, 0.0)       # narrower is better when right


# ------------------------------------------------------------------ statistics
def test_wilson_interval_known_values():
    lo, hi = score.wilson(50, 100)
    assert lo == pytest.approx(0.4038, abs=1e-3) and hi == pytest.approx(0.5962, abs=1e-3)
    assert score.wilson(0, 0) is None
    assert score.rate(5, 10)["too_early"] and not score.rate(20, 40)["too_early"]


def test_clustered_interval_is_wider_than_naive_when_days_move_together():
    rng = np.random.default_rng(2)
    values, days = [], []
    for d in range(60):
        shock = rng.normal(0, 1.0)                              # everything moves together that day
        for _ in range(50):
            values.append(shock + rng.normal(0, 0.1))
            days.append(f"day{d}")
    res = score.clustered_mean(values, days)
    naive_half = 1.96 * np.std(values) / np.sqrt(len(values))
    assert (res["ci"][1] - res["ci"][0]) / 2 > 3 * naive_half
    assert res["n"] == 3000 and res["days"] == 60
    assert score.clustered_mean([], [])["mean"] is None


def test_calibration_bins():
    pairs = [(0.25, True)] * 25 + [(0.25, False)] * 75 + [(0.75, True)] * 30 + [(0.75, False)] * 10
    bins = score.calibration(pairs)
    assert [b["n"] for b in bins] == [100, 40]
    assert bins[0]["realised"] == 0.25 and bins[1]["realised"] == 0.75


# ------------------------------------------------- end to end on the engine
def _walk(engine, tweak=None, n_days=120):
    eng, _ = engine
    days = eng.states["AAA"].dates
    scores = []
    for k in range(len(days) - n_days - 1, len(days) - 1):
        for e in eng.book(days[k]).values():
            rec = ledger.make_record(e, days[k + 1], "1.0.0")
            if tweak:
                tweak(rec)
            bar = eng.states[e["symbol"]].df.iloc[k + 1][["open", "high", "low", "close"]].to_dict()
            scores.append(score.resolve(rec, bar))
    return scores


def test_aggregate_scoreboard(engine):
    agg = score.aggregate(_walk(engine))
    assert agg["scored"] == 360 and agg["days"] == 120
    assert 0.80 <= agg["ranges"]["close"]["rate"] <= 0.97       # 90% range, random-walk data
    assert abs(agg["direction"]["skill"]) < 0.05                # no skill on pure noise
    assert set(agg["rules"]) == set(plans.KINDS)
    br = agg["rules"]["breakout"]
    assert br["trades"] > 30 and br["equity_r"][-1][1] == br["total_r"]
    assert sum(br["outcomes"].values()) == br["trades"]
    assert sum(b["n"] for b in agg["touch"]["calibration"]) == 4 * 360
    assert sum(agg["calls"].values()) == 360
    sym = score.by_symbol(_walk(engine, n_days=40))
    assert set(sym) == {"AAA", "BBB", "CCC"} and sym["AAA"]["n"] == 40


def test_rerunning_scoring_gives_identical_numbers(engine):
    assert score.aggregate(_walk(engine, n_days=60)) == score.aggregate(_walk(engine, n_days=60))


def test_a_deliberately_wrong_model_scores_worse_than_baseline(engine):
    def sabotage(rec):
        # Confident in the wrong thing: always 95% "up", and a range ten times too narrow.
        rec["claims"]["dir"]["p_up"] = 0.95
        for k in ("p05", "p95"):
            rec["claims"]["close"][k] /= 10
    bad = score.aggregate(_walk(engine, sabotage))
    assert bad["direction"]["skill"] < -0.3
    assert bad["ranges"]["skill"] < 0
    assert bad["ranges"]["close"]["rate"] < 0.5


def test_void_records_are_counted_not_scored(engine):
    recs, _ = _records(engine)
    scores = [score.resolve(r, None) for r in recs]
    agg = score.aggregate(scores)
    assert agg["records"] == 3 and agg["scored"] == 0 and agg["void"] == 3
