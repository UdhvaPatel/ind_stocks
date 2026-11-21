"""Dead-man's switch: fail loudly when the site has fallen behind.

    python -m pipeline.check_fresh --job eod        (last evening run, 22:00 IST)
    python -m pipeline.check_fresh --job premarket  (last morning run, 08:00 IST)

GitHub emails the repository owner when a run fails, so a skipped or broken day no
longer goes unnoticed (as 17-20 Nov 2026 did). It reads only meta.json and the ledger.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date

from . import config, ledger


def problems(job: str, meta: dict, today: date) -> list[str]:
    out = []
    session_today = bool(meta.get("today_is_session")) and meta.get("today_ist") == today.isoformat()
    if job == "eod" and session_today and meta.get("last_eod_date") != today.isoformat():
        out.append(f"today ({today}) was a trading day but the latest processed session is {meta.get('last_eod_date')}: "
                   "the official NSE file was not ingested by the last evening run")
    if job == "premarket" and meta.get("plan_for_date") == today.isoformat():
        if not ledger.has_plan_for(today, meta.get("model_version")):
            out.append(f"no plan for today ({today}) was committed to the ledger by the last morning run")
    if meta.get("pipeline_status") not in (None, "ok"):
        out.append(f"pipeline status is '{meta.get('pipeline_status')}': {meta.get('message')}")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", choices=["eod", "premarket"], required=True)
    args = ap.parse_args()
    meta = json.loads((config.DATA_DIR / "meta.json").read_text(encoding="utf-8"))
    found = problems(args.job, meta, config.today_ist())
    if found:
        for p in found:
            print("::error::" + p)
        sys.exit(1)
    print(f"{args.job}: up to date")


if __name__ == "__main__":
    main()
