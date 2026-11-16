"""One-off (and repeatable) history backfill.

    python -m pipeline.run_backfill --years 5

Idempotent: sessions already in the vault are skipped, so it can be re-run
after an interruption and it only downloads what is missing.
"""
from __future__ import annotations

import argparse
import json
from datetime import timedelta

from . import config, ingest, store, universe, validate
from .http import Http


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", type=float, default=config.universe_cfg()["nse_backfill_years"])
    ap.add_argument("--skip-yahoo", action="store_true")
    args = ap.parse_args()

    nse = Http(min_interval=0.35)
    yahoo = Http(min_interval=1.0)

    print("1/4 universe")
    uni = universe.refresh_universe(nse)
    symbols = [s["symbol"] for s in uni["stocks"]]
    print(f"  {len(symbols)} plan stocks, {len(store.tracked_symbols())} tracked symbols")

    end = config.today_ist()
    start = end - timedelta(days=int(365.25 * args.years))
    print(f"2/4 official NSE files {start} to {end}")
    counts = ingest.backfill_nse(nse, start, end)
    print(f"  {counts}")
    recovered = ingest.find_missing_sessions(nse)
    print(f"  recovered {len(recovered)} special sessions")

    if not args.skip_yahoo:
        print("3/4 Yahoo daily history")
        status = ingest.refresh_yahoo_daily(yahoo, ingest.all_yahoo_symbols(symbols),
                                            config.universe_cfg()["history_years"])
        failed = {k: v for k, v in status.items() if v != "ok"}
        print(f"  ok {len(status) - len(failed)}, failed {len(failed)} {failed or ''}")

    print("4/4 cross-validation NSE vs Yahoo")
    eod = store.load_nse_eod()
    reports = [validate.cross_check(sym, store.load_yahoo_daily(sym), store.load_events(sym),
                                    eod[eod["symbol"] == sym] if len(eod) else None)
               for sym in symbols]
    summary = validate.summarise(reports)
    out = store.vault() / "reports" / "validation.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"summary": summary, "symbols": reports}, indent=1), encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k != "worst"}, indent=1))
    for row in summary["worst"][:10]:
        print("  ", row)


if __name__ == "__main__":
    main()
