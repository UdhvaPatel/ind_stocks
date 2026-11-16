"""Sunday job: refresh the universe, rebuild the walk-forward track and the quality report.

    python -m pipeline.run_weekly
"""
from __future__ import annotations

from . import jobs, ledger, universe
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

    version = engine.mcfg["model_version"]
    for_date = engine.calendar.next_trading_day(engine.last_session)
    plan_status = "scored" if ledger.has_plan_for(for_date, version) else "draft"
    jobs.publish_site(engine, plan_status, for_date, status)
    jobs.log("weekly done")


if __name__ == "__main__":
    main()
