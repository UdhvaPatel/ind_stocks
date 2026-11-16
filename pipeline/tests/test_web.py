"""The website's own tests (web/tests, run with Node) and the planner file it reads."""
import json
import shutil
import subprocess

import pytest

from pipeline import config, publish

WEB_TESTS = sorted((config.ROOT / "web" / "tests").glob("*.test.mjs"))


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is not installed")
@pytest.mark.parametrize("path", WEB_TESTS, ids=lambda p: p.name)
def test_web_suite(path):
    """What-if tabs on the Today page, and the "Make a plan" page."""
    run = subprocess.run(["node", "--test", str(path)], cwd=config.ROOT, capture_output=True,
                         text=True, encoding="utf-8", errors="replace", timeout=120)
    assert run.returncode == 0, run.stdout[-4000:] + run.stderr[-2000:]


def test_web_tests_exist():
    assert {p.name for p in WEB_TESTS} >= {"planlogic.test.mjs", "plan_missing.test.mjs", "today_whatif.test.mjs"}


def _symbol(symbol="AAA", **over):
    levels = {"entry": 101.0, "stop": 99.0, "t1": 103.0, "t2": 105.0, "risk": 2.0, "p_trigger": 0.4, "p_t1": 0.2}
    rule = {"plans": 900, "trades": 400, "win_rate": 0.4, "expectancy_r": -0.1,
            "r_quantiles": {"p05": -1.1, "p25": -0.5, "p50": -0.1, "p75": 0.3, "p95": 1.0},
            "outcomes": {"stopped": 100, "t1": 60, "t2": 20, "time": 220}}
    base = {
        "symbol": symbol, "name": "Alpha Ltd", "as_of": "2026-11-13", "for_date": "2026-11-16", "plan_status": "scored",
        "last": {"close": 100.0}, "slippage": 0.0005,
        "call": {"call": "NEUTRAL", "label": "weak evidence", "kind": "breakout", "reference_kind": None},
        "evidence": {"breakout": {"n": 400, "shrunk_r": -0.08, "enough": True}},
        "plans": {"breakout": {"kind": "breakout", "levels": levels, "cancel_after": "14:30", "exit_by": "15:15"}},
        "rules": {"breakout": rule},
        "claims": {"close": {"p05": -2.0, "p50": 0.1, "p95": 2.4}},
    }
    base.update(over)
    return base


def test_planner_file_carries_levels_and_each_rules_record():
    out = publish.clean(publish.planner_file([_symbol("BBB"), _symbol("AAA")], "1.0.0"))
    json.dumps(out, allow_nan=False)
    assert out["schema"] == publish.SCHEMA and out["for_date"] == "2026-11-16" and out["plan_status"] == "scored"
    assert [s["symbol"] for s in out["stocks"]] == ["AAA", "BBB"]
    s = out["stocks"][0]
    assert (s["call"], s["kind"], s["close"], s["close_p95"]) == ("NEUTRAL", "breakout", 100.0, 2.4)
    b = s["rules"]["breakout"]
    assert (b["entry"], b["stop"], b["t1"], b["t2"]) == (101.0, 99.0, 103.0, 105.0)
    assert (b["cancel_after"], b["exit_by"], b["p_trigger"]) == ("14:30", "15:15", 0.4)
    assert b["hit_t1"] == 0.2 and b["hit_t2"] == 0.05                 # (60 + 20) / 400 and 20 / 400
    assert (b["r_p05"], b["r_p50"], b["r_p95"], b["shrunk_r"], b["enough"]) == (-1.1, -0.1, 1.0, -0.08, True)


def test_planner_file_leaves_out_incomplete_rules():
    broken = _symbol("CCC")
    broken["plans"]["breakout"]["levels"] = {"entry": 101.0, "stop": None, "t1": 103.0, "t2": 105.0}
    upside_down = _symbol("DDD")
    upside_down["plans"]["breakout"]["levels"]["stop"] = 120.0          # a stop above the entry is not a plan
    no_history = _symbol("EEE", rules={}, evidence={})
    out = publish.clean(publish.planner_file([broken, upside_down, no_history, _symbol("FFF", plans=None)], "1.0.0"))
    assert [s["symbol"] for s in out["stocks"]] == ["EEE"]
    e = out["stocks"][0]["rules"]["breakout"]
    assert e["trades"] == 0 and e["hit_t1"] is None and e["expectancy_r"] is None and e["enough"] is False
    assert publish.planner_file([], "1.0.0")["stocks"] == []
