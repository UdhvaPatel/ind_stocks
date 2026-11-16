# Dalal Desk (Equity Timing Helper, India)

One-session plans for Nifty 50 stocks, written down before the market opens and scored
against official NSE data after the close. Educational decision support, **not investment advice**.

- `PLAN.md` is the design. Its section 15 records what the data showed and where the build differs.
- `steps.md` lists the manual steps for the owner (GitHub setup, things only a person can check).

## How it runs

Everything runs on a schedule in GitHub Actions (`.github/workflows/pipeline.yml`) and is served by
GitHub Pages. There are no live prices and no always-on server.

| Job | When (IST) | What it does |
|---|---|---|
| `premarket` | 06:00 to 08:00, Mon to Fri | Commits today's plan to the ledger (`data/ledger/`) before the open |
| `eod` | 18:00 to 22:00, Mon to Sat | Archives the official session, scores the day, publishes a draft for the next session |
| `weekly` | Sunday 10:00 | Retrains the direction models, rebuilds the 3-year walk-forward and the data-quality report |

All times shown on the site are India Standard Time, whatever the viewer's time zone.

## Layout

```
config/      model, costs, universe, holidays, publishing switches
pipeline/    Python: fetch, clean, statistics, forecast, weekly learner, plans, ledger, scoring, jobs
  tests/     93 tests, including "a historical replay equals the live run" (no look-ahead)
web/         the site (plain HTML, CSS and JavaScript modules; no build step)
data/        published JSON and the append-only prediction ledger (committed by the jobs)
vault/       raw vendor data; git-ignored here, kept in a separate private repository
```

## Run it on your own computer

```
pip install -r requirements.txt
python -m pytest pipeline/tests -q          # tests
python -m pipeline.run_backfill --years 5   # first time only: download history into vault/
python -m pipeline.run_weekly               # walk-forward, quality report, publish
python -m pipeline.run_eod --always         # evening job
python -m pipeline.run_premarket            # morning job
python -m http.server 8765                  # then open http://127.0.0.1:8765/web/
```

## What to expect from it

Measured on a 3-year walk-forward (37,182 forecasts, using only data available on each day):

- The 90% range for the close contained the real close about 90% of the time.
- Direction was right about 54% of the time, against 50% for always saying "up".
- **No one-session buy rule made money after realistic costs.** Most stocks show "no trade".

The live track record on the site is the number that matters; the backtest is labelled as such.
