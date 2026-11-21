"""06:00 IST job: commit today's plan before the market opens.

    python -m pipeline.run_premarket [--force]

Order of work:
  1. catch up on any official session the evening job missed, and score it
  2. refresh overnight markets (the US close is known by now)
  3. build today's plan and append it to the ledger (only on a trading day,
     only before 08:45 IST, and only if the data is up to date)
  4. publish
Safe to run several times: a plan already in the ledger is never rewritten.
"""
from __future__ import annotations

import argparse

from . import jobs
from .http import Http


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="issue the plan even after 08:45 IST")
    args = ap.parse_args()

    status = {"sources": {}}
    nse, _ = jobs.safe(jobs.catch_up_nse, Http(min_interval=0.35), default={}, what="NSE catch-up")
    status["sources"]["nse"] = nse or "unavailable"
    yahoo, err = jobs.safe(jobs.refresh_yahoo, Http(min_interval=1.0), default=None, what="Yahoo refresh")
    status["sources"]["yahoo"] = yahoo or f"unavailable ({err})"

    engine = jobs.build_engine()
    scored = jobs.score_pending(engine)
    if scored:
        jobs.log(f"scored {scored}")
    plan_status, for_date = jobs.issue_plan(engine, force=args.force)
    if plan_status == "not_issued":
        status["pipeline_status"] = "stale"
        status["message"] = (f"No plan was issued for {for_date}: the data was not up to date "
                             "before the cut-off. The page shows the last good data.")
    elif yahoo is None or (yahoo and yahoo["failed"]):
        status["pipeline_status"] = "degraded"
        status["message"] = "Some overnight data could not be refreshed; the plan uses the last good values."
    jobs.publish_site(engine, plan_status, for_date, status)
    jobs.write_health("premarket", status)
    jobs.log(f"premarket done: plan for {for_date} is '{plan_status}'")


if __name__ == "__main__":
    main()
