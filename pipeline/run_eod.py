"""Evening job (retry ladder from 18:00 IST): today's result and tomorrow's draft plan.

    python -m pipeline.run_eod [--always]

If the official file for the latest session is already processed and nothing
is waiting to be scored, the job exits without touching any file. Otherwise it
archives the session, scores that day's predictions against the official
prices, and publishes the result together with a draft plan for the next
session (the scored plan is committed by the 06:00 job).
"""
from __future__ import annotations

import argparse

from . import jobs, ledger, replay, store
from .http import Http


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--always", action="store_true", help="publish even if nothing new arrived")
    args = ap.parse_args()

    before = store.open_days()
    status = {"sources": {}}
    nse, err = jobs.safe(jobs.catch_up_nse, Http(min_interval=0.35), default=None, what="NSE catch-up")
    status["sources"]["nse"] = nse or f"unavailable ({err})"
    new_days = [d for d in store.open_days() if d not in before]

    unscored = len(ledger.load()) - len(jobs.load_scores())
    if not new_days and unscored <= 0 and not args.always:
        jobs.log("nothing new: official file not published yet or already processed")
        return

    yahoo_http = Http(min_interval=1.0)
    yahoo, err = jobs.safe(jobs.refresh_yahoo, yahoo_http, default=None, what="Yahoo refresh")
    status["sources"]["yahoo"] = yahoo or f"unavailable ({err})"
    bars, err = jobs.safe(replay.archive_recent, yahoo_http, default=None, what="5-minute archive")
    status["sources"]["bars5m"] = bars if bars is not None else f"unavailable ({err})"

    engine = jobs.build_engine()
    scored = jobs.score_pending(engine, replay.plan_results)
    plan_status, for_date = jobs.issue_plan(engine)
    if plan_status == "not_issued":
        plan_status = "draft"                 # an evening run never issues; it only drafts
    jobs.publish_site(engine, plan_status, for_date, status)
    jobs.log(f"eod done: new sessions {[d.isoformat() for d in new_days]}, scored {scored}, "
             f"draft plan for {for_date}")


if __name__ == "__main__":
    main()
