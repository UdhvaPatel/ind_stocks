"""Sunday job: refresh the universe, rebuild the walk-forward track and the quality report.

    python -m pipeline.run_weekly
"""
from __future__ import annotations

from . import config, jobs, ledger, publish, research, universe
from .costs import cost_cfg
from .http import Http


def main() -> None:
    status = {"sources": {}}
    _, err = jobs.safe(universe.refresh_universe, Http(min_interval=0.35), what="universe refresh")
    if err:
        status["sources"]["universe"] = f"unavailable ({err})"
    nse, _ = jobs.safe(jobs.catch_up_nse, Http(min_interval=0.35), default={}, what="NSE catch-up")
    status["sources"]["nse"] = nse or "unavailable"
    yahoo, err = jobs.safe(jobs.refresh_yahoo, Http(min_interval=1.0), default=None, what="Yahoo refresh")
    status["sources"]["yahoo"] = yahoo or f"unavailable ({err})"

    engine = jobs.build_engine()
    jobs.score_pending(engine)
    agg = jobs.run_backtest(engine)
    jobs.log(f"backtest: {agg['scored']} predictions over {agg['days']} sessions")
    quality = jobs.quality_report(engine)
    jobs.log(f"quality: {quality['cross_check']}")
    # The pre-registered swing research, re-run on the latest data (same rules, nothing re-tuned).
    try:                                               # research must never stop the weekly job
        found = research.combined(engine.ds.frames, cost_cfg())
        publish.write_json(config.DATA_DIR / "research.json", found, indent=1)
        jobs.log(f"research: {found['variants_tested']} variants, passed {found['passed'] or 'none'}")
    except Exception as exc:                           # noqa: BLE001 - logged and skipped
        jobs.log(f"research skipped: {type(exc).__name__}: {exc}")

    version = engine.mcfg["model_version"]
    for_date = engine.calendar.next_trading_day(engine.last_session)
    plan_status = "scored" if ledger.has_plan_for(for_date, version) else "draft"
    jobs.publish_site(engine, plan_status, for_date, status)
    jobs.log("weekly done")


if __name__ == "__main__":
    main()
