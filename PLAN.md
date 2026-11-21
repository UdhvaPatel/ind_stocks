# Equity Timing Helper (India) - Project Plan

> Working title. Same idea as the currency tool, applied to Indian stocks: free data, a clear plan for the day, honest statistics, and a **public scorecard of how accurate the tool has actually been**.

**Status:** plan finalised and decisions locked (section 13); nothing built, and building starts only when the owner says so. Free-data feasibility was tested live on 15 Nov 2026 (results in section 2). Items still unverified are listed in Phase 0.

**Disclaimer:** this is decision-support software for learning and personal use. It is not investment advice. The project is hosted on GitHub Pages at a public URL (section 13); wording is neutral and written as suggestions to a third person, and section 12 must be read before sharing the link with anyone.

---

## Table of contents

1. [Summary and recommendation](#1-summary-and-recommendation)
2. [Free data sources: what works](#2-free-data-sources-what-works)
3. [The three modes and the market clock](#3-the-three-modes-and-the-market-clock)
4. [Architecture](#4-architecture)
5. [Statistics catalogue](#5-statistics-catalogue)
6. [Decision engine and trade plans](#6-decision-engine-and-trade-plans)
7. [Prediction ledger and accuracy measurement](#7-prediction-ledger-and-accuracy-measurement)
8. [Data model and JSON contracts](#8-data-model-and-json-contracts)
9. [UI plan](#9-ui-plan)
10. [Repository layout](#10-repository-layout)
11. [Roadmap, acceptance criteria and test plan](#11-roadmap-acceptance-criteria-and-test-plan)
12. [Risks, compliance and terms of use](#12-risks-compliance-and-terms-of-use)
13. [Decisions (locked)](#13-decisions-locked)
14. [Appendix](#14-appendix)

---

## 1. Summary and recommendation

### 1.1 What you asked for, restated

| Time of day (IST) | What the page should do |
|---|---|
| Before the market opens (for example 6:00 AM) | Show **today's plan** built from previous data: the call and "Your move, step by step", like the currency page |
| While the market is open | Keep showing the **same morning plan** (levels, stop, target, exit-by time, rupee scenarios, statistics). **No live prices**; a banner says the result arrives after the close |
| After the close (official data, usually about 6 PM or later) | Show **today's result**, compare it with what the tool predicted, update the **accuracy score**, and publish a draft plan for the next trading day |
| Any past day | A "previous page" showing what was predicted then, what happened, and measured accuracy |

**Horizon (locked): one trading session.** The plan for trading day D is built from data up to D-1 and committed before the open. Nothing is held overnight. After the close, the real day D is compared with the plan and scored (timeline and calendar example in 13.1).

### 1.2 The honest framing (most important design decision)

Short-term stock prices are close to a random walk. A tool that claims to "predict" them will fail, and the scoreboard will show it. So the product is built around three promises that **can** be kept and **can** be measured:

1. **Scenarios, not prophecy.** "From days that looked like today, the session's close ended between -1.9% and +2.1% versus the previous close nine times out of ten." That is a statement about history and it can be scored.
2. **Pre-committed plans.** Every plan (trigger, stop, target, holding time) is written down and timestamped **before** the market opens, so nobody (including you) can fix it afterwards.
3. **A scoreboard that is allowed to say "no edge".** Accuracy is measured against naive baselines with confidence intervals. If the tool has no skill, the page says so.

This is also what makes the project credible: the accuracy page is the product.

### 1.3 Recommended approach in one paragraph

Use **free official NSE end-of-day files** plus **Yahoo Finance's unofficial chart endpoint** (adjusted prices, 5-minute bars, indices). Run the heavy analysis in **Python on GitHub Actions** on a schedule, publish the results as **static JSON on GitHub Pages** (public repository, derived analytics only; raw archives live in a second, private repository), and keep every prediction in an **append-only ledger inside the public repository** (the commit history is a tamper-evident timestamp). **No live data is used.** The site is updated only by scheduled jobs (a plan before the open, a result after the close), so it works from any device and nothing depends on your PC being on. The browser only renders; all logic lives in one place (Python).

### 1.4 What carries over from the currency project

| Reuse | Notes |
|---|---|
| Motion principles, hover and scroll behaviour | Reused as ideas only; the visual design is new: an Indian trading-app look (section 9.4) |
| "Where today sits in history" statistics | Percentiles, ranks, z-scores, RSI, Bollinger, volatility |
| "Odds of waiting" curve | Becomes the **analog forward curve** (what happened after similar days) |
| Early trigger, touch probability, honesty check | Core of the stock trade plan |
| Action plan component ("Your move, step by step") | Same component, new content |
| One lesson | In the currency project the logic was written twice (Apps Script and browser) and needed a parity test. Here the logic lives **only in Python**; the browser never recomputes decisions |

---

## 2. Free data sources: what works

All results below were tested with real requests on **15 Nov 2026** unless marked otherwise.

### 2.1 Source matrix

| Source | What it gives | Free? | Tested | Browser can call it directly? | Role |
|---|---|---|---|---|---|
| **NSE CM UDiFF Bhavcopy** `nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_YYYYMMDD_F_0000.csv.zip` | Official end-of-day OHLC, previous close, volume, turnover, trades for every NSE security (about 3,700 rows; 2,744 in series EQ) | Yes, no key | **Yes**: 200 on trading days, 404 on a Saturday and on the 20 Oct 2026 market holiday. Reliance close matched Yahoo exactly (1339.70) | No (no CORS header) | **Primary official EOD source** and cross-check |
| **NSE security-wise delivery file** `.../products/content/sec_bhavdata_full_DDMMYYYY.csv` | Same plus **delivery quantity and delivery %** (`DELIV_PER`) | Yes | **Yes** (200, 400 KB) | No | Participation statistic |
| **NSE index closes** `.../content/indices/ind_close_all_DDMMYYYY.csv` | All index OHLC with **P/E, P/B, dividend yield** | Yes | **Yes** | No | Index levels and valuation percentile |
| **NSE constituent lists** `.../content/indices/ind_nifty50list.csv` (and `ind_niftynext50list.csv`) | Company, industry, symbol, ISIN | Yes | **Yes** (50 rows) | No | Universe and sector mapping |
| **Yahoo Finance chart endpoint** `query1.finance.yahoo.com/v8/finance/chart/RELIANCE.NS?range=10y&interval=1d&events=div\|split` | Daily bars back 10 years (2,472 rows), **adjusted close**, **dividend and split events**, 5-minute bars (75 per day, 09:15 to 15:30 IST), indices `^NSEI`, `^NSEBANK`, `^BSESN`, `^INDIAVIX`, BSE symbols (`.BO`), global indices, crude, USD/INR | Yes, no key. **Unofficial**, personal-use terms (see 12.3) | **Yes** | **No** (no CORS header) | **Primary history source** (adjusted) and the post-close 5-minute archive |
| **Google Sheets `GOOGLEFINANCE`** | `NSE:RELIANCE` price and daily history | Yes | From search only (not tested here). Reported delay up to about 20 minutes. BSE coverage reported unreliable | n/a (runs in Sheets) | Third cross-check or no-code fallback |
| Angel One SmartAPI | Historical candles for NSE/BSE incl. indices | Free with an Angel One account | From search only (forum post about 2 years old) | n/a | Optional later: needs login and secret handling |
| Upstox API v3 historical candles | Daily data from year 2000, minute data from 2022 | Free on all plans per Upstox docs | From search only. Licensing for personal use not confirmed | n/a | Optional later |
| ICICI Breeze, Dhan, Fyers, Zerodha Kite | Broker APIs | Account required; terms differ | Not checked | n/a | Not needed for v1 |

### 2.2 Not usable (tested)

| Source | Result |
|---|---|
| `www.nseindia.com/api/...` (live quote, holiday master) | **403 Access Denied** / redirect. Blocked for scripts. Do not rely on it, and do not try to evade it |
| Stooq | Returned a web page, not data |
| TrueData and similar | Paid |

### 2.3 Key consequences for the design

1. **Nothing is callable from the browser.** NSE files and Yahoo both lack CORS headers. A server-side step is mandatory: GitHub Actions does all fetching on a schedule and publishes static JSON. There is no live component.
2. **Two independent sources exist for end-of-day data** (NSE official and Yahoo), so every day can be **cross-validated**: close prices must agree within a tolerance, otherwise the pair is flagged. This is the main data-quality feature.
3. **Official NSE data is unadjusted.** Splits and bonuses create fake crashes in unadjusted prices. Use Yahoo's adjusted close (with split events) for statistics; use NSE files for validation, volumes, delivery and the official daily OHLC used to score predictions.
4. **The trading calendar needs no API.** A weekday where the NSE file returns 404 is a holiday (confirmed for 20 Oct 2026). Special Saturday sessions and Muhurat trading also exist, so the calendar is built from data, not from "Monday to Friday".
5. **Valuation is free for indices** (P/E, P/B, yield percentile), not for single stocks.
6. **Not available free and reliably:** results dates / corporate announcements, F&O open interest and option chains, circuit-limit data, Gift Nifty. The plan does not depend on them; the UI says so ("event risk not modelled").

### 2.4 Fallback chain

```
History:   Yahoo adjusted (primary)  ->  NSE bhavcopy (unadjusted; adjust with Yahoo split events)  ->  last good snapshot (clearly labelled stale)
Intraday archive (after the close):  Yahoo 5m bars  ->  no bars: stop-first rule, flagged "intrabar ambiguous"
Calendar:  NSE file 200/404           ->  hard-coded NSE holiday list per year (committed to the repo)
```

---

## 3. The three modes and the market clock

### 3.1 Correct market hours (please note)

Your times are close but the exchange runs on slightly different clocks (from my own knowledge; verify against the current NSE circular in Phase 0):

| IST | NSE session |
|---|---|
| 09:00 to 09:15 | Pre-open (order entry, matching, buffer) |
| **09:15 to 15:30** | **Normal trading** (the price you can really trade) |
| 15:40 to 16:00 | Post-close session |
| After about 17:30 to 18:30 | Official end-of-day files appear (**exact time to be measured in Phase 0**) |

Because the exact publication time of the official files is unknown, the page does **not** switch to "result" at a fixed clock time. It switches when the data says the file is ready.

### 3.2 Mode state machine

| Mode | When (IST, trading day) | The page shows | Data it uses |
|---|---|---|---|
| **PLAN** | From the plan commit (about 06:00) until the official result is processed, **including while the market is open** | Today's plan: the call, action plan, trigger / stop / target, rupee scenarios, overnight context (US close, Asia morning, crude, USD/INR). While the market is open a banner says: no live prices, result after the close | Previous official close plus overnight context; plan committed at about 06:00 |
| **RESULT** | From the moment the official file for today is processed (about 18:00 or later) until the next plan is committed | Today's actual vs predicted, plan outcome in rupees, updated accuracy, **draft plan for the next trading day** | NSE official OHLC, plus archived 5-minute bars for the order of events |
| **CLOSED** | Weekends, holidays | Last result and the plan for the next trading day (dated) | Last snapshot |

Rules: the mode comes from `meta.json`: PLAN while `last_eod_date` is earlier than today's trading date, RESULT once it equals today, CLOSED on non-trading days. The IST clock (`Intl` with `Asia/Kolkata`) only changes banner wording ("market open", "result expected after about 18:00"). If the pipeline is late or failed, the page falls back to the last good data and shows a visible banner. No silent staleness.

### 3.3 Scheduling (GitHub Actions cron is UTC; IST = UTC + 5:30)

| Job | IST | UTC cron | What it does |
|---|---|---|---|
| `premarket` (retry ladder) | 06:00, 06:30, 07:00, 07:30, 08:00 Mon to Fri | `30 0`, `0 1`, `30 1`, `0 2`, `30 2` (minute hour, UTC, Mon to Fri) | Idempotent: the first run that succeeds first processes any previous-day result still pending (a catch-up if the evening runs failed), then pulls overnight context, builds the plan for today and commits it to the ledger. Later runs exit quietly. After 08:45 IST nothing new is issued (the day is shown as "not issued"). The holiday check uses the committed holiday list, because the NSE file test is only possible after the close |
| `eod` (retry ladder) | 18:00, 18:30, 19:00, 20:00, 22:00 Mon to Sat | `30 12`, `0 13`, `30 13`, `30 14`, `30 16` | Idempotent: if today's file exists and is not yet processed, ingest it, archive the day's 5-minute bars, score today's predictions (official numbers), build the draft plan for the next trading day, commit. Otherwise exit quietly |
| `weekly` | Sun 10:00 | `30 4 * * 0` | Refresh universe, rebuild calibration, walk-forward backtest, data-quality report |
| (deploy step) | after every job above | n/a | Each job that changes `data/` ends by deploying GitHub Pages inside the same workflow run (a push made with the default token does not trigger a second workflow) |

GitHub's scheduler can start jobs minutes late and occasionally skips them, which is why `eod` is a ladder of retries rather than one run, and why each run decides what is pending instead of assuming the time.

---

## 4. Architecture

### 4.1 Diagram

```
                 +-------------------- GitHub Actions (Python) --------------------+
 NSE archives -->|  fetch_nse -> validate  \                                        |
 (EOD, delivery, |                          >-- clean -> features -> forecast ->     |
  indices, lists)|  fetch_yahoo (adjusted) /          plans -> ledger -> score ->    |--> data/*.json
 Yahoo ----------|                                     publish                      |    (committed to git)
                 +------------------------------------------------------------------+         |
                                                                                              v
 Browser  <------------- GitHub Pages (static web/ + data/*.json) <--------------------+
```

### 4.2 Why this and not the Sheets pipeline

| | **Locked: Actions + Python + GitHub Pages** | Alternative: Apps Script + Sheets (like currency) |
|---|---|---|
| Heavy statistics and walk-forward backtests | Easy (pandas, numpy) | Hard: 6-minute execution limit, no libraries |
| No-CORS sources | Solved server-side; JSON is same-origin on Pages | Solved by the web app |
| Tamper-evident prediction history | **Git commit timestamps** | Sheet edit history (editable by you) |
| Visibility of raw data | JSON/CSV in repo | Spreadsheet you can open |
| Testing | Normal unit tests, golden files | Mock Google services |
| Your existing knowledge | New (Python, Actions) | Already known |

Decision (locked): **everything runs as scheduled batch jobs in Actions, with no live data and no always-on component** (the same hands-off behaviour as the currency project's triggers). The Sheets option is rejected.

### 4.3 Where the analysis runs

All logic (cleaning, statistics, forecasts, plans, scoring) is **Python only**. The browser applies two harmless transformations on stored results: rupee scaling for the user's capital and costs, and mode logic. This removes the duplicate-logic problem from the currency project.

### 4.4 Free-tier budget

| Resource | Free limit (verify) | Expected use |
|---|---|---|
| GitHub Actions | Unlimited minutes on public repos, 2,000 min/month on private | About 10 to 20 short runs per trading day. The site repo is public, so minutes are unlimited; the private vault repo only receives one small archive commit a day |
| GitHub Pages | Free for public repos; site up to about 1 GB, soft bandwidth limit about 100 GB/month | Static site; derived data in the repo stays under 50 MB |
| Yahoo / NSE | Unpublished limits | About 60 symbols x 2 requests per day, polite spacing (1 request per second or slower), retries with back-off |

### 4.5 Hosting on GitHub Pages, with no PC of yours involved (locked)

Two repositories:

| Repo | Visibility | Holds |
|---|---|---|
| `ind_stocks` (planned as `ind-stocks-site`) | **Public** (GitHub Pages on the free plan requires it) | Code, config, workflows, `web/`, the published `data/` (derived analytics, plans, scores) and the prediction ledger |
| `ind-stocks-vault` | **Private** | Raw archives that must not be redistributed: 5-minute bars and any raw price snapshots. Reached by the pipeline through a fine-grained token stored as an Actions secret (access to the vault only) |

How it runs:

- Every scheduled job runs in GitHub Actions on the public repo (unlimited minutes). It fetches fresh raw data from NSE and Yahoo, reads the vault for the intraday profile, writes only derived JSON to the public repo, appends the 5-minute archive to the vault, and deploys Pages.
- **Phone and laptop:** open the Pages URL anywhere. Capital, risk and settings stay in that browser only.

What "public" means here:

- A GitHub Pages site is public even when built from a private repo (only Enterprise Cloud can restrict access). Anyone with the link, or who finds it, can read the plans.
- The site adds `noindex` and `robots.txt` so search engines skip it, and carries the disclaimer on every page. This lowers discovery; it is not access control.
- Nothing secret goes in the public repo: no tokens, no personal data, no raw vendor series (see 12.3).
- If you later want real access control while staying on free tiers, the option is Cloudflare Pages with Cloudflare Access in front of a private repo.

---

## 5. Statistics catalogue

Computed per stock and index on adjusted daily data (252 trading days a year, weekends excluded). "Favourable" is always from the viewpoint of a **buyer** unless the user marks a holding (then sell-side wording).

### 5.1 Level and position

| Statistic | Definition |
|---|---|
| Percentile of close | Rank within the last 20 / 60 / 252 days |
| Distance from 52-week high and low | Percent and days since |
| Drawdown | Current decline from the running peak; depth and duration of the last 5 drawdowns |
| z-score | Versus 20 / 60-day mean |
| Range position | Where today sits in the 20 / 60 / 252-day range |

### 5.2 Trend

| Statistic | Definition |
|---|---|
| SMA 20 / 50 / 200 and price distance | Trend state: above all, mixed, below all |
| Cross state | 50 over 200, days since the last cross |
| Slope and R² | Log-price regression over 20 and 60 days |
| ADX (14) | Trend strength |
| Donchian breakout | Close above 20-day high / below 20-day low |
| MACD (12, 26, 9) | Momentum direction |

### 5.3 Momentum

RSI(14), rate of change over 5 / 21 / 63 / 126 / 252 days, "12-1 momentum" (12-month return excluding the last month), stochastic(14).

### 5.4 Volatility and range

| Statistic | Definition |
|---|---|
| Realised volatility | 10 / 21 / 63 days, annualised |
| ATR(14) and ATR% | Average true range, used for stops and sizing |
| Range volatility | Parkinson and Garman-Klass (use high/low) |
| Volatility ratio | 21-day over 63-day (expansion or squeeze) |
| Bollinger %B and bandwidth | Squeeze detection |
| India VIX level and percentile | Market-wide regime (calm, normal, stressed) |

### 5.5 Participation (the Indian-market edge over currency)

| Statistic | Definition |
|---|---|
| Volume versus 20-day average | Spike ratio |
| Turnover rank | Liquidity tier (decides whether a plan is allowed at all) |
| **Delivery %** | From `sec_bhavdata_full`; versus own 60-day average (high delivery on up days suggests real buying) |
| Up-volume ratio, OBV | Accumulation / distribution |

### 5.6 Gaps and intraday structure

| Statistic | Definition |
|---|---|
| Overnight gap distribution | Open versus previous close; gap-up/down frequency |
| Gap fill probability | Share of gaps that were closed within the day, by gap size |
| Previous day high / low / close, pivot points | Reference levels |
| Opening range (first 15 / 30 minutes) | From stored 5-minute bars |
| Intraday volatility profile | Variance by 5-minute slot (U-shaped); built from stored bars over time (Yahoo 5m history is limited to about 60 days, so the tool **accumulates its own archive**) |

### 5.7 Relative and market context

| Statistic | Definition |
|---|---|
| Relative strength vs Nifty 50 | Ratio percentile, 21 and 63-day outperformance |
| Beta and correlation | 252-day, against Nifty |
| Sector relative | Versus the stock's sector peers (sector from the NSE list) |
| Breadth | Share of Nifty 50 above their 50-day average; advance/decline from the full bhavcopy |
| Index valuation | Nifty P/E and P/B percentile since the data begins (from `ind_close_all`) |
| Overnight context | S&P 500, Nasdaq, Nikkei, Hang Seng changes; Brent crude; USD/INR (links to the currency project); all from Yahoo |

### 5.8 Risk

Historical VaR 95%, CVaR, worst day / week, skewness, kurtosis, maximum drawdown, downside deviation, probability of a down day after a down day (lag-1 behaviour).

### 5.9 Forward-looking distributions (conditional, not predictions)

For the **one-session horizon** (previous close to the close of the trading day; locked in section 13), using **analog days** (past days in the same stock with a similar state: percentile band, trend state, volatility regime) and falling back to all days when fewer than 60 analogs exist:

| Output | Meaning |
|---|---|
| Quantiles p05, p25, p50, p75, p95 | Best and worst cases in percent |
| P(up), mean | Probability of a gain, average result |
| **MFE and MAE** | Maximum favourable / adverse excursion during the hold: tells you how far a stop must be and how high a target is realistic |
| Touch probabilities | P(price touches +x% or -y% during the session) and the typical time of day of the touch |
| Volatility scaling | Distances are scaled by current ATR so a calm stock and a wild stock get appropriately different bands |
| Sample size | Always displayed |

### 5.10 Honesty statistics (shown on every plan)

| Statistic | Why |
|---|---|
| Edge versus baseline | Do similar days beat all days? If not, the plan says "no timing edge" |
| t-statistic and sample size | Guards against reading noise as signal |
| Parameter stability | Does the result survive nearby settings? |
| Data quality flags | Source disagreement, stale bars, adjustment events, thin liquidity |
| Event-risk caveat | "Results dates and news are not modelled" |

---

## 6. Decision engine and trade plans

### 6.1 Setup score (0 to 100)

A transparent composite, shown with its parts (not hidden):

```
setup = 100 * ( 0.30 * trend_alignment      (price vs SMA50/200, slope, ADX)
              + 0.25 * level_quality        (not extended: percentile / z / %B in a sensible band)
              + 0.20 * momentum_health      (RSI band, ROC, relative strength vs Nifty)
              + 0.15 * participation        (volume, delivery %)
              + 0.10 * risk_regime )        (volatility ratio, India VIX regime, drawdown state)
```

Weights are judgement, **not fitted**, and the page says so. Phase 5 uses the walk-forward results to test whether the score carries any information, and the weights are only changed through a new model version (section 7.6).

### 6.2 Calls (wording is a design choice, see 13 and 12)

| State | Condition (first match) | Plan type |
|---|---|---|
| **AVOID / NO TRADE** | Illiquid, data flags, or no edge detected and setup < 40 | No plan. Explains why |
| **WAIT FOR TRIGGER** | Setup 40 to 65, or extended price | Entry only if a level is reached ("breakout above X" or "pullback to Y") |
| **BUY ZONE** | Setup 65 to 80 | Staged entry (for example half at the zone, half on confirmation) |
| **STRONG SETUP** | Setup > 80 and participation confirms | Full planned entry with stop and target |
| **HOLD / MANAGE** | User has marked a holding | Hold, trail stop, trim at target (v1.5; not in v1) |
| **REDUCE / EXIT** | Stop broken, trend failed, or distribution signs | Exit levels and tax-aware note (v1.5; not in v1) |

Time-based wording is intraday: "do not enter after 14:30" or "let the first 15 minutes settle" is derived from the stored **intraday profile** (when in the session the typical favourable move happens), not guessed. Plans are long-only in v1; an unfavourable day simply has no plan.

### 6.3 Plan card (what the user sees)

Every plan contains:

| Field | How it is derived |
|---|---|
| **Entry** | Breakout trigger: above yesterday's high (or 20-day high) plus 0.1 ATR; or pullback zone: SMA20 / lower Bollinger band / prior support; with an **expiry** (cancel if not triggered by 14:30 IST) |
| **Stop** | Entry minus 0.8 to 1.2 daily ATR, or below the previous session's low, whichever is closer (pre-registered; changed only through a new model version); gap-through is assumed to fill at the open (worse) |
| **Targets** | T1 = 1.5R, T2 = 2.5R, or the MFE quantile if smaller; R = entry minus stop |
| **Holding period** | Exit within the same session: time stop at 15:15 IST, before the usual broker intraday square-off window (verify with your broker). Nothing is held overnight |
| **Position size** | Capital x risk% (default 1%) / (entry minus stop), rounded to whole shares, capped by liquidity |
| **Rupee scenarios** | From simulating this exact rule on this stock's own history (6.4), after costs: **worst case (p05), typical (p50), best case (p95)**, probability of profit, expected value, worst drawdown while held |
| **Cancel conditions** | Gap beyond the stop, VIX spike, data flag |

### 6.4 Rule backtests ("full statistics" for a plan)

For each plan type and stock, replay the rule over the whole history with realistic fills:

| Metric | Notes |
|---|---|
| Trades, win rate, average win, average loss | Per plan type |
| Expectancy (in R and in rupees), profit factor | After costs |
| Maximum drawdown, longest losing streak | Equity curve of the rule |
| Average hold, MFE, MAE | Used for stops and targets |
| Monte Carlo of trade sequences (1,000 resamples) | Gives the **worst / typical / best** outcome range for the user's capital instead of one backtest path |
| Walk-forward (expanding window, refit monthly) | Out-of-sample version of everything above; **only this version is shown as evidence** |

Fill rules: breakout buys fill at max(trigger, open); stops that gap fill at the open; if stop and target are both inside one daily bar the **stop is assumed first** (conservative) unless stored 5-minute bars prove otherwise; flagged as "intrabar ambiguous". From launch day the pipeline archives every session's 5-minute bars, so live scoring resolves the stop-versus-target order exactly; older backtest days keep the stop-first rule, which is why live results are the evidence that matters.

### 6.5 Costs and tax (configuration, not constants)

Defaults below are from my own knowledge and **must be checked against your broker's contract note and current rules**; they live in `config/costs.yaml`:

| Item | Default to verify |
|---|---|
| Brokerage | Your broker's plan (delivery often zero) |
| STT | Intraday (applies to every v1 plan): 0.025% on sell. Delivery (v1.5 only): 0.1% on buy and sell |
| Exchange transaction charge | About 0.003% of turnover (NSE cash) |
| SEBI fee | About Rs 10 per crore |
| Stamp duty | About 0.003% on buy (intraday rate; delivery is 0.015%) |
| GST | 18% on brokerage + exchange charge + SEBI fee |
| Depository charge | Not charged on same-day trades (only the v1.5 holdings feature would use it) |
| Slippage | 0.05% to 0.15% by liquidity tier |
| Income tax | Same-day trades are generally treated as speculative business income taxed at your slab rate, not as capital gains (verify with a tax professional). Optional estimate only |

The UI shows gross and net numbers separately so you can see how much cost eats a small edge.

**Locked (Decision 10): the most realistic, conservative profile**, because understating costs is the easiest way to overstate accuracy:

- Intraday (same-day) rates for every plan, with all statutory charges verified in Phase 0 against current NSE, SEBI and broker schedules rather than left at the defaults above.
- Brokerage default: the lower of Rs 20 or 0.03% per executed order, on both legs (a typical discount-broker intraday plan). Editable in `config/costs.yaml` for your broker.
- Slippage measured, not assumed: calibrated per stock from stored 5-minute bars (typical bar range and volume at the entry time), with the liquidity-tier values above as a floor. Applied on entries and on stop exits (stops fill worse than the level).
- A touch is not a fill: an entry needs price to trade through the level by one tick. This lowers the trigger rate but removes phantom fills.
- Gap-through fills at the open.
- The same cost code is used in the backtest, the live ledger and the rupee scenarios.

### 6.6 After-the-close replay (no live data)

The tool never tracks the day while the market is open and never issues new predictions intraday (this avoids hindsight). After the official file is processed it replays the morning plan against what happened:

| Output | Method |
|---|---|
| Outcome stamp | Not triggered / Triggered / Stopped / T1 hit / T2 hit / Time exit |
| Fill prices and times | From the archived 5-minute bars (an entry needs a trade through the level; stops that gap fill at the open). If bars are missing: official OHLC with the stop-first rule and an "intrabar ambiguous" flag |
| Rupee result | Gross and net of the cost model (6.5), for the capital set in the UI |
| Claim scoring | Close-return range, open gap, touch levels, direction (section 7.2) |
| Data stamp | "Official NSE data of DD-MMM-YYYY, processed at HH:MM IST" |

Alerts: none in v1 (locked). Telegram can be reconsidered after Phase 8, because it needs a scheduler more reliable than Actions cron.

### 6.7 Sell side (if you already own the stock) - deferred to v1.5

The user can enter shares and average price (stored only in the browser). The plan then shows: hold / trim / exit levels, trailing stop, unrealised profit, holding period (short or long term), and an estimated tax effect. Nothing is sent anywhere.

---

## 7. Prediction ledger and accuracy measurement

This section is the core of the project.

### 7.1 What gets recorded

Every plan is an **immutable record** written before the market opens and committed to git (the commit time is the timestamp; the pre-market commit happens before 09:00 IST).

```json
{
  "id": "2026-11-16|RELIANCE|v1.0",
  "symbol": "RELIANCE", "for_date": "2026-11-16", "made_at": "2026-11-16T00:31:12Z",
  "model_version": "1.0.0", "data_hash": "sha1-of-input-rows",
  "inputs": {"last_close": 1339.7, "atr14": 21.4, "setup": 71, "vix": 15.5},
  "claims": {
    "dir_next_day":  {"p_up": 0.54},
    "range_1d":      {"p05": -1.9, "p50": 0.1, "p95": 2.1},
    "open_gap":      {"p05": -0.9, "p50": 0.0, "p95": 1.0},
    "touch":         [{"level": 1362.5, "p": 0.38}, {"level": 1318.0, "p": 0.31}]
  },
  "plan": {"type": "breakout", "entry": 1353.0, "cancel_after": "14:30", "stop": 1331.0, "t1": 1386.0, "t2": 1395.0,
           "exit_by": "15:15", "shares": 45, "scenarios_rs": {"p05": -1050, "p50": 380, "p95": 1750}}
}
```

Rules: records are **append-only** (a pre-market refresh adds `v2` of the same day; both are kept and both are scored); a model change creates a new `model_version` and scores are never mixed across versions; nothing is ever edited or deleted.

### 7.2 What is scored, and how

| Claim | Resolution (official NSE OHLC, adjusted for corporate actions) | Metric |
|---|---|---|
| Direction next day | Close above previous close? | **Brier score**, log loss, hit rate **vs base rate**; calibration by confidence bucket |
| Close range and open gap | Realised close return (versus previous close) and realised gap inside p05..p95? | **Coverage** (target 90%), pinball loss, interval width efficiency |
| Touch levels | Did the day's high/low touch the level? | Calibration: predicted touch probability vs realised frequency |
| Plan outcome | Not triggered / stopped / T1 / T2 / time exit, with fills per 6.4 | R-multiple, rupees after costs, win rate, expectancy |
| Regime label | Was the session's realised high-low range inside the predicted band? | Hit rate |

### 7.3 Baselines (a model is only good relative to something)

| Baseline | Used for |
|---|---|
| Always predict "up" (base rate) | Direction |
| Yesterday's ATR-scaled band | Range |
| Random entry with the **same** stop, target and hold | Plan outcome (percentile rank of the plan versus 1,000 random entries) |
| Buy and hold Nifty / the stock over the same period | Overall comparison |

Reported as **skill score** `1 - loss_model / loss_baseline` (above 0 means better than baseline).

### 7.4 What the scoreboard shows

| Block | Content |
|---|---|
| Headline | "Direction: 53% (95% CI 47% to 59%, n = 180) against a 51% base rate: no reliable edge yet" (text adapts to the numbers) |
| Calibration chart | Predicted probability versus realised frequency, in bins, with bin sizes |
| Coverage | Realised share inside the 90% range, rolling 20 / 60 / all days |
| Plan results | Trigger rate, win rate, average R, equity curve versus buy and hold |
| By symbol, by regime, by confidence | Where the tool works and where it does not |
| Sample-size guard | Percentages are replaced by "too early (n < 30)" until enough predictions exist; confidence intervals are always shown (Wilson for rates; day-clustered bootstrap for pooled results, because stocks on the same day move together and are not independent samples) |
| Live versus backtest | Two clearly separated tabs (7.5) |

### 7.5 Backtest history versus live history

On day one the live ledger is empty, so the "previous page" would be blank. To avoid that **and** avoid fooling anyone:

| Track | Source | Label |
|---|---|---|
| **Walk-forward backtest** | The same code replayed over 3 to 5 past years with an expanding window, using **only data available at each date** | "Backtest (not live)" with survivorship-bias warning (current Nifty constituents) |
| **Live** | Real pre-market commits from launch day onward | "Live (out of sample)" is the number that matters |

### 7.6 Anti-cheating and bias controls

| Risk | Control |
|---|---|
| Look-ahead | A test truncates history at date D and checks predictions are identical to those made with the full file |
| Silent re-tuning | Weights live in `config/model.yaml` with a version; changing them bumps `model_version`; scores are per version |
| Survivorship | Flagged on backtests; universe changes are logged |
| Multiple testing | Few, pre-registered plan types; the number of variants tried is recorded and shown |
| Overfitting | Only walk-forward results are shown as evidence |
| Corporate actions | All returns from adjusted prices; actual events stored; scoring uses the adjusted series |
| Costs ignored | All plan results are net of the cost model |
| Missing days | A day with no prediction is shown as "not issued", never silently skipped |

### 7.7 Realistic expectations (write this on the page)

Next-day direction hit rates for any honest method hover around 50 to 55%. The value of the tool is expected to be in **risk framing** (sizing, stops, knowing the range) and discipline, not in beating the market. If live skill is zero the scoreboard will show it, and that is a valid and useful result.

---

## 8. Data model and JSON contracts

### 8.1 Published files (`data/`)

| File | Content | Approx. size |
|---|---|---|
| `meta.json` | `generated_at`, `last_eod_date`, `plan_for_date`, `pipeline_status`, `model_version`, data-source status, holiday flag | 1 KB |
| `universe.json` | Symbols, names, sector, liquidity tier | 15 KB |
| `market.json` | Index levels, VIX, breadth, overnight context, valuation percentiles | 10 KB |
| `symbols/{SYM}.json` | Latest statistics, plan (6.3), forward curves, analog summary, rule-backtest summary, 120-day compact series (rebased to 100 until the terms check in 12.3 clears raw prices) | 40 to 60 KB each |
| `days/{YYYY-MM-DD}/summary.json` | For that day: every symbol's plan, outcome, and score | 100 KB |
| `ledger/predictions-{YYYY-MM}.jsonl` | The immutable records (7.1) | 1 to 2 MB a month |
| `scores/{YYYY-MM}.json` | Resolved scores | small |
| (private vault repo) `bars5m/{YYYY-MM-DD}.csv.gz` | Archived 5-minute bars; resolves stop-versus-target order and builds the intraday profile. **Not published** (raw vendor data) | about 50 KB a day |
| `track.json` | Aggregated scoreboard (live and backtest separately) | 50 KB |

Budget for 60 symbols: about 5 MB current + about 3 MB a month of history. A year stays well under 50 MB.

### 8.2 Contract rules

All numbers are plain JSON numbers (no strings); missing is `null`; every file carries `model_version` and `generated_at`; field names are stable (changes bump a `schema` field and the UI refuses unknown schemas with a clear message).

---

## 9. UI plan

### 9.1 Pages

| Page | Content |
|---|---|
| **Today** (default) | Mode banner with the IST clock and session progress; capital and risk-per-trade fields (default Rs 1,00,000 and 1%, editable, stored in the browser only); symbol search (Nifty 50 stocks and indices in v1); the call; score dial; "Your move, step by step"; plan card; rupee scenarios; chart with level lines and the forward cone; analog curve; statistics cells; Pro metrics; Nifty 50 heatmap; watchlist |
| **Track record** | Scoreboard (7.4) with live / backtest tabs |
| **Day archive** | Date picker and `?date=YYYY-MM-DD&symbol=...`: what was predicted at 6 AM that day, what happened, the score |
| **How it works / limits** | Plain-language method, data sources, costs, disclaimers |

### 9.2 Mode-specific layout

| Mode | Hero | Key components |
|---|---|---|
| PLAN | "Today's plan for RELIANCE" | Action plan steps with times, overnight context strip, static level ladder (entry, stop, targets, previous high/low), rupee scenarios |
| RESULT | "Plan vs reality" | Predicted vs actual OHLC overlay, outcome stamp (Target / Stopped / Not triggered / Time exit), rupee result, updated accuracy ring, tomorrow's plan |

### 9.3 Components specific to stocks

| Component | Description |
|---|---|
| **Level ladder** | Vertical scale with stop, entry, T1, T2 and the previous high/low; zones shaded (loss, entry, profit). At RESULT the actual high, low and close are marked on it |
| **Market clock** | IST time and a session bar (pre-open, open, closed) with the next scheduled update (06:00 plan, result after about 18:00). No moving prices |
| **Candle strip** | Last 20 sessions as small candles with the plan levels drawn across |
| **Outcome stamp** | At RESULT, a stamp animates onto the plan card (Target hit / Stopped / Not triggered) |
| **Calibration chart, coverage gauge, equity curve** | Scoreboard visuals |
| **Nifty 50 heatmap** | Tiles coloured by setup score; hover shows the call and ATR; click opens the symbol |
| **Rupee scenario bar** | Worst / typical / best on one axis for the user's capital |

### 9.4 Design and motion

**Locked (Decision 8): the app should feel like an Indian stock-market app** (the family of Zerodha Kite, Groww, Dhan and the NSE / Moneycontrol screens), not an editorial page. Design brief:

- **Indian conventions:** rupee sign with lakh/crore grouping (`en-IN`, for example 1,00,000), prices to two decimals, dates as DD-MMM-YYYY, 24-hour IST clock, tickers written as `NSE: RELIANCE`.
- **Colour:** green for up, red for down (the Indian convention), one blue accent, neutral surfaces; light and dark themes. Colour is never the only signal (arrows and signs too).
- **Layout:** a top index strip (NIFTY 50, SENSEX, BANK NIFTY, INDIA VIX with value, change and % change) and a ticker tape; a left **market watch** list (LTP, change, % change, tiny sparkline); a centre chart with plan levels; a right **order-ticket style plan panel** (if-then entry, quantity, stop, target, charges breakdown); bottom tabs in the style of Positions / Orders for plan status and the day's log.
- **Typography and density:** compact, data-dense, tabular numerals, hairline borders. Sans-serif UI font rather than serif.
- **Market-depth style table** for the level ladder (levels, distance, probability of touch).
- **Session feel without live data:** the market-clock strip and index strip show the last official close; nothing ticks.

Motion ideas (all `transform` and `opacity` only, reduced-motion respected):

| Moment | Motion |
|---|---|
| Intro | Candles draw themselves across the screen, the market clock sweeps from pre-open to close and lands on "now", wordmark rises word by word, then the curtain parts |
| Mode change | The mode banner morphs (PLAN to RESULT) with the clock hand moving, never a hard swap |
| Level ladder | At RESULT the actual high, low and close slide into place; a level that was crossed pulses once |
| Outcome stamp | Scales in with a short overshoot, then settles |
| Heatmap | Tiles ripple in from the top-left; hover raises a tile and shows its call |
| Scoreboard | Rings and bars fill on scroll; calibration points appear one by one |
| Numbers | Rolling digits for prices and rupee amounts |

### 9.4b Tone of voice

Educational and neutral: "If the price reaches 1,352, this plan would enter" rather than "Buy now". Locked (Decision 5): neutral if-then wording, written as a note to a third person (section 13).

### 9.5 Accessibility and phone use

Colour is never the only signal; every status has text and an icon; full keyboard use; a 390 px layout is designed first (the site is reachable from the phone anywhere, with no PC running).

---

## 10. Repository layout

```
ind_stocks/
  PLAN.md                         this file
  config/
    model.yaml                    weights, thresholds, horizons, model_version
    costs.yaml                    brokerage, STT, charges, slippage, tax (verify)
    universe.yaml                 index lists to track
    holidays-2026.yaml            backup holiday list
  pipeline/                       Python
    fetch_nse.py  fetch_yahoo.py  calendar.py  validate.py  clean.py
    features.py   forecast.py     plans.py     backtest.py  ledger.py
    score.py      publish.py       run_premarket.py  run_eod.py  run_weekly.py
    tests/                        unit tests and golden files
  web/                            index.html styles.css app.js  (render only)
  data/                           published JSON and ledger (committed)
  .github/workflows/              premarket.yml  eod.yml  weekly.yml  (each ends with the Pages deploy step)
  README.md
```

---

## 11. Roadmap, acceptance criteria and test plan

Effort estimates are rough and assume part-time work.

| Phase | Work | Done when | Rough effort |
|---|---|---|---|
| **0. Feasibility spikes** | See 11.1 | Every unknown in 11.1 has a measured answer written down; go / no-go on each source | 1 day |
| **1. Data foundation** | Fetchers for NSE and Yahoo, cross-validation, calendar from data, corporate-action handling, universe, daily snapshot files | 60 symbols x 5 years load; NSE and Yahoo closes agree within 0.1% on 99% of days (disagreements listed); a split/bonus day shows no fake crash | 2 to 3 days |
| **2. Statistics and forecasts** | Everything in section 5 as pure functions with tests; analog forward curves; touch probabilities | Hand-checked against a spreadsheet for 3 stocks; no look-ahead (truncation test passes) | 4 to 6 days |
| **3. Plans and rule backtests** | Plan generator, fills, costs, Monte Carlo, walk-forward | A plan's rupee scenarios reproduce from raw data; costs reconcile with a sample contract note | 4 to 5 days |
| **4. Ledger and scoring** | Append-only ledger, resolver, baselines, skill scores, Wilson intervals, calibration | Re-running scoring gives identical numbers; a deliberately wrong model scores worse than baseline | 3 days |
| **5. Walk-forward history** | Backtest track 3 to 5 years; test whether the score has any information | Report written, including a null result if that is the truth; weights decision made here | 2 to 3 days |
| **6. UI: PLAN and RESULT** | Today page, action plan, plan card, scenarios, day archive, scoreboard | Runs from sample JSON; phone layout verified | 5 to 7 days |
| **7. Intraday archive and replay** | Fetch and archive 5-minute bars after the close (vault repo), resolve plan outcomes and fills from them, build the intraday profile | A past session's outcome reproduces from archived bars; missing bars fall back to the stop-first rule and are flagged | 2 days |
| **8. Hardening** | Expert-tester pass (11.2), accessibility, performance, docs; optional alerts | No open critical bugs; Lighthouse above 90 on mobile | 3 to 4 days |
| **Total** | | | about 4 to 6 weeks part-time |

### 11.1 Phase 0: questions to answer by measurement

| Question | How to measure | Why it matters |
|---|---|---|
| At what time do the NSE EOD files appear? | Poll the file URLs every 5 minutes on 5 trading days and record the first 200 | Sets the `eod` retry ladder and the RESULT switch |
| Does Yahoo work from **GitHub Actions** IPs (daily bars and post-close 5-minute bars)? | Run the same requests from a workflow for a few days; log 429 / 403 | Shared cloud IPs are sometimes throttled; if so, add back-off and a later ladder step, with NSE files as the daily-data fallback |
| From what time are the full session's 5-minute bars available on Yahoo after the close? | Fetch at 16:00, 18:00 and 20:00 for 5 days and count bars (75 per session) | Sets when the archive step can run inside `eod` |
| Do NSE and Yahoo agree on adjusted history? | Compare closes across split/bonus dates | Validates the adjustment approach |
| Are there missing days or bad prints in Yahoo? | Compare to NSE for 3 years x 60 symbols | Defines the data-quality rules |
| What do the NSE files and Yahoo terms allow? | Read the terms pages (12.3); ask NSE's data mailbox if unclear | Decides whether the site can be public |
| Do holiday and special-session days behave as expected? | Cover 2024 to 2026 holidays, Muhurat day, special Saturdays | Calendar logic |
| Exact intraday rules for stops and gaps | Review with real examples | Fill assumptions in 6.4 |
| Current statutory charges and your broker's intraday schedule, square-off time | Read NSE, SEBI and broker pages; reconcile one real contract note | Locked cost model (6.5) |
| Do scheduled workflows keep running on a public repo (GitHub disables them after 60 days without repository activity), and how late does cron start? | Observe for 2 weeks; confirm the pipeline's own commits count as activity | Keep-alive step and the retry ladders in 3.3 |
| How complete are Yahoo's 5-minute bars for all 50 stocks over a full session? | Count bars per symbol per day for 10 days | Intraday profile and stop-versus-target resolution |

### 11.2 Expert-tester checklist (run before every release)

| Area | Checks |
|---|---|
| Data | File 404 on holiday; Yahoo 429 and 503 retries; truncated zip; empty CSV; a symbol renamed or delisted; stock split and bonus days; very low-priced and very high-priced stocks; stale bars; duplicate rows; a day where NSE and Yahoo disagree |
| Time | IST clock vs the user's local clock (test in a UTC and a US time zone); mode switches driven by `meta.json` (plan committed, result processed, late pipeline); weekend and holiday modes; pipeline late on a trading day |
| Logic | Look-ahead truncation test; idempotent runs (twice = same result); plan prices are valid ticks; stop always below entry; shares integer and affordable; costs reconcile; Monte Carlo reproducible with a fixed seed |
| Ledger | Append-only (a test fails if an old line changes); versions never mixed; every issued prediction eventually gets a score or an explicit reason |
| UI | Every mode on 390 px and desktop; light and dark; keyboard-only; reduced motion; no NaN / undefined anywhere; very large and tiny capital values; a symbol with no plan; offline and slow network; rapid symbol switching (last request wins); stale-data banner |
| Security and privacy | No secrets in the repo; holdings and capital stored only in the browser; no analytics by default |
| Performance | Page JSON under 150 KB per symbol view; first view under 2 s on 4G |

---

## 12. Risks, compliance and terms of use

### 12.1 Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| Yahoo changes or blocks the endpoint (unofficial) | History and intraday stop | NSE bhavcopy fallback (needs adjustment from the last good split table), cached snapshots, a clear stale banner; broker APIs as a later alternative |
| NSE changes file names or blocks scripts | EOD ingest fails | Retry ladder, alerting on pipeline failure (Actions email), manual-run workflow |
| GitHub cron delays or skips | Late plan | The pre-market job is scheduled early (06:00) with a safe margin; a later retry exists; the page shows when the plan was made |
| No predictive skill | Product disappoints | That is an allowed outcome; the scoreboard shows it; the product's value is risk framing |
| Overfitting | False confidence | Walk-forward only, few plan types, versioned weights |
| Survivorship bias in backtests | Flattering history | Label it; prefer live results |
| Users treat plans as advice | Financial loss, regulatory trouble | Wording, disclaimers, section 12.2 |
| Delayed intraday data | Stale triggers | Show data age; the plan is a pre-set level, not a tick chaser |
| Public repo size growth | Slow clones and Pages limits | Monthly sharded ledger; raw 5-minute bars live in the private vault, not here |
| Public site with no access control | Anyone can read the plans; regulatory and data-terms exposure | Mitigations in 12.2 and 12.3; derived data only; check before sharing the link |
| Scheduled workflows paused (60-day inactivity) or started late | Missing plans | Retry ladders, keep-alive step; the day shows "not issued" |

### 12.2 India-specific regulation (important)

SEBI regulates **research analysts** and **investment advisers**. Publicly issuing buy/sell recommendations to others can fall under these regimes, and SEBI has tightened rules on unregistered "finfluencers". My search confirmed the general direction (registration and disclosure requirements, restrictions on regulated entities dealing with unregistered influencers) but **did not confirm specifics for an automated tool**, so this needs a proper check before sharing the site with anyone.

**Locked (Decision 1): the site is hosted publicly on GitHub Pages**, so stance 1 no longer fully applies: anyone with the URL can open it. Mitigations: stance 2 wording (neutral if-then, written as suggestions to a third person), prominent disclaimers, `noindex` and `robots.txt` so search engines skip it, no promotion, no personalised advice. I cannot confirm whether a public automated tool of this kind falls under SEBI rules, so get a proper check before sharing the link with anyone. Options, in order of safety:

1. **Personal use only** (site not shared). Lowest risk.
2. **Educational what-if tool**: neutral wording ("if price reaches X, this plan would enter"), no named stock "calls" to the public, prominent disclaimers, no personalised advice, no promise of returns, accuracy shown honestly.
3. **Public recommendations**: speak to a SEBI-registered adviser or lawyer first. Do not do this without that.

### 12.3 Terms of use of the data

| Source | Known | Action |
|---|---|---|
| Yahoo Finance | No official API; the widely used wrapper states the data is for **personal use**; commercial or redistribution use is restricted; rate limits unpublished (reports of throttling in 2026) | Treat as personal / research use. If the site is public, publish **derived analytics, not raw price series**, or keep the site private. Read the current terms in Phase 0 |
| NSE files | Free to download; I found no statement of the terms for automated download or redistribution | Check NSE's website terms and, if unclear, ask the data mailbox listed on NSE's site. Same publishing rule as above |

Note: GitHub Pages on the free plan needs a **public** repository, and a Pages site is public even when built from a private repo (only Enterprise Cloud can restrict access). So the published site carries **derived analytics only** (plans, levels, outcomes, scores, statistics). Raw price series and the 5-minute archive stay in the private vault repo. Whether the 20-session candle strip and the scored session's OHLC may be shown is decided by the Phase 0 terms check; until cleared, charts use series rebased to 100 and percent moves.

---

## 13. Decisions (locked 14 Nov 2026)

| # | Decision | Locked choice | Where it shows up |
|---|---|---|---|
| 1 | Audience and hosting | **Hosted on GitHub Pages (public URL); works with no PC of yours running.** Derived analytics only; neutral wording written as suggestions to a third person; mitigations in 12.2 | 1.3, 4.5, 12 |
| 2 | Backend | **GitHub Actions + Python** (public site repo + private vault repo), GitHub Pages for hosting | 3.3, 4 |
| 3 | Trading style | **One-session swing.** A plan for trading day D is built from data up to D-1; after the close it is compared with the real day D and scored (13.1) | 3, 5.9, 6, 7 |
| 4 | Universe for v1 | **Nifty 50 stocks + Nifty 50, Bank Nifty, Sensex and India VIX as context.** Next 50 only after Phase 5 | 5, 8 |
| 5 | Wording | **Neutral if-then** ("if price trades through X, this plan would enter") | 6.2, 9.4b |
| 6 | Holdings (sell side) | **v1.5** | 6.7 |
| 7 | Alerts | **None** | 6.6 |
| 8 | Look and feel | **An Indian stock-market app** (index strip, ticker tape, market watch, order-ticket style plan panel, green up / red down, lakh-crore formatting) | 9.4 |
| 9 | Capital and risk per trade | **Editable in the UI**, default Rs 1,00,000 and 1% risk, stored in the browser only | 9.1 |
| 10 | Cost model | **The most realistic, conservative profile**: intraday charges in full, measured slippage, "a touch is not a fill" | 6.5 |
| 11 | Live data | **None.** The site updates by schedule only: the plan before the open and the result after the official file (about 18:00 or later). No live prices, no quote endpoint, no Cloudflare | 3.2, 3.3 |

### 13.1 What "one session" means

Timeline of one trading day D (IST):

| Time | What happens |
|---|---|
| About 06:00 (retries to 08:00) | The **scored plan for D** is committed to the ledger, built from official data through D-1 plus overnight context |
| 09:15 | Market opens. The page still shows the morning plan; no live prices and no new predictions |
| 14:30 | Entries that have not triggered are cancelled |
| 15:15 | Time exit for any open plan (final) |
| 15:30 | Market closes |
| About 18:00, retries to 22:00 | The official NSE file arrives. The **official result** and accuracy are published. A **draft plan for D+1** is published (shown, but not scored; the 06:00 plan is the scored one because it includes overnight context) |

Calendar example. 14 Nov 2026 is a Saturday, so the page is in CLOSED mode: it shows Friday 13 Nov's result and the plan for Monday 16 Nov. On Monday 16 Nov at 06:00 the scored plan is made from data through Friday 13 Nov. After the Monday close the page shows what really happened on 16 Nov against that plan, plus the updated accuracy, and then the draft plan for Tuesday 17 Nov.

### 13.2 Consequences of these decisions

- **Only one horizon.** The 3, 5, 10, 21 and 63-day forecasts are dropped. Longer lookbacks (trend, momentum) remain as inputs.
- **Long-only in v1.** Unfavourable days simply have no plan. Intraday short selling would need its own rule set; revisit in v1.5.
- **The opening gap is unknown at 06:00** (Gift Nifty is not available free). Plans are conditional levels, the gap is a scored distribution, and a plan is cancelled if the open gaps beyond the stop.
- **5-minute bars are archived from launch day**, because Yahoo keeps only about 60 days of them and stop-versus-target order inside a session can only be settled with them.
- **Faster evidence.** About 50 predictions a day instead of a handful. Because stocks move together, the effective sample is smaller; confidence intervals use day-level resampling. Rough estimate: coverage and calibration of ranges become readable within about a month of live days; a firm verdict on direction needs roughly 3 to 5 months.
- **Costs bite harder.** A one-session edge is small, so intraday charges and slippage can erase it; gross and net are always shown side by side.
- **Hosting adds some work.** Two repositories with a token between them, the Pages deploy step in every job, and the public-site safeguards in 12 add roughly 3 to 4 days. New total: about 5 to 6 weeks part-time.

### 13.3 Assumptions to confirm before building

1. **Public repo is acceptable.** GitHub Pages is free only for public repositories. The published data is derived analytics only; raw data goes to a private vault repo. If you want the site itself private, the route is Cloudflare Pages with Access, not GitHub Pages.
2. **No live data.** During market hours the page shows only the morning plan with a banner. The result appears once the official NSE file is processed (usually 18:00 or later; retries to 22:00; if the file is later still, the next 06:00 run catches up).
3. **Sharing the link:** nothing in this plan clears the site for promotion or for sharing with others. Read 12.2 and 12.3 first.
4. The evening draft for D+1 is unscored; only the 06:00 plan is scored.

---

## 14. Appendix

### 14.1 Verified endpoints (15 Nov 2026)

```
NSE bhavcopy (UDiFF):   https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_YYYYMMDD_F_0000.csv.zip
NSE delivery:           https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_DDMMYYYY.csv
NSE index closes:       https://nsearchives.nseindia.com/content/indices/ind_close_all_DDMMYYYY.csv
Nifty 50 list:          https://nsearchives.nseindia.com/content/indices/ind_nifty50list.csv
Nifty Next 50 list:     https://nsearchives.nseindia.com/content/indices/ind_niftynext50list.csv
Yahoo daily + events:   https://query1.finance.yahoo.com/v8/finance/chart/RELIANCE.NS?range=10y&interval=1d&events=div|split
Yahoo intraday 5m:      https://query1.finance.yahoo.com/v8/finance/chart/TCS.NS?range=1d&interval=5m
Indices on Yahoo:       ^NSEI (Nifty 50)  ^NSEBANK  ^BSESN (Sensex)  ^INDIAVIX
Not usable:             https://www.nseindia.com/api/*  (403 / redirect for scripts)
```

### 14.2 Bhavcopy columns used

`TradDt, TckrSymb, SctySrs (filter EQ), OpnPric, HghPric, LwPric, ClsPric, LastPric, PrvsClsgPric, TtlTradgVol, TtlTrfVal, TtlNbOfTxsExctd, ISIN`. Delivery file adds `DELIV_QTY, DELIV_PER`. Index file adds `P/E, P/B, Div Yield`.

### 14.3 Worked example of the 6 AM plan (illustrative numbers, not real advice)

> **RELIANCE, plan for Mon 16 Nov (committed 06:01 IST).** Setup 71/100, trend above SMA50 and SMA200, daily ATR 21.4 (1.6%), delivery % above average, overnight US markets flat.
> **If-then plan:** if price trades through **1,353** (Friday's high of 1,350.70 plus 0.1 ATR) before **14:30**, this plan would enter; otherwise it is cancelled.
> **Stop** 1,331 (about 1 ATR, risk 22 per share). **Target 1** 1,386 (1.5R). **Target 2** 1,395 (capped by the typical favourable excursion). **Time exit** 15:15.
> **With Rs 1,00,000 and 1% risk (Rs 1,000):** 45 shares (about Rs 60,885). After costs and slippage: worst case (5th percentile) -Rs 1,050, typical +Rs 380, best case (95th) +Rs 1,750. Probability of profit 52%, trigger rate 61%. This rule on this stock: 340 historical triggered sessions, expectancy +0.08R, max drawdown -7R.
> **Honesty check:** similar days beat all days by +0.05% over the session (t = 1.1): weak evidence. Live accuracy of this plan type so far: not enough data (n = 11).
>
> **That evening (RESULT):** actual high 1,361, low 1,338, close 1,356 (+1.2%). Entry triggered at 1,353.05; neither stop nor target was hit; time exit at 15:15 near 1,357, about +Rs 120 net. The close fell inside the predicted 90% range (covered); the direction call (54% up) was right. Accuracy updated, and the draft plan for Tuesday is shown.

### 14.4 Sources consulted

- [Angel One SmartAPI: free historical data release note](https://smartapi.angelone.in/smartapi/forum/topic/4012/release-note-free-historical-data-access-for-indices-nse-nfo-bse-bfo-mcx-and-cds-with-smartapi)
- [ICICI Breeze API](https://www.icicidirect.com/futures-and-options/api/breeze)
- [Upstox: Historical Candle Data V3](https://upstox.com/developer/api-documentation/v3/get-historical-candle-data) and [Upstox backtesting docs](https://upstox.com/developer/api-documentation/backtesting)
- [NSE circular on the Bhavcopy change (community discussion)](https://tradingqna.com/t/has-nse-changed-bhavcopy-location/169551) and [NSE forms and formats](https://www.nseindia.com/static/resources/forms-formats-members)
- [Google Sheets and NSE/BSE prices (Sheetaki)](https://sheetaki.com/get-nse-and-bse-real-time-prices-google-sheets/)
- [SEBI finfluencer rules (Upstox news)](https://upstox.com/news/market-news/financial-regulations/sebi-tightens-rules-for-unregistered-finfluencers-bars-registered-entities-from-dealing-with-them/article-113724) and [Nishith Desai analysis](https://nishithdesai.com/research-and-articles/hotline/technology-law-analysis/securities-market-regulators-continued-quest-against-unfiltered-financial-advice-15193)
- [yfinance README (personal-use statement)](https://cdn.jsdelivr.net/gh/ranaroussi/yfinance@main/README.md) and [Yahoo Finance API in 2026 overview](https://python.plainenglish.io/yahoo-finance-api-in-2026-is-there-still-an-official-api-633d2b89a85d)

Third-party summaries were used for some points (marked "from search only" in section 2). Verify any limit, price or rule against the provider's own documentation before depending on it.

### 14.5 Disclaimer

This project is for information, education and decision support only and is not investment advice, a research report, or a recommendation to buy or sell any security. Markets carry risk of loss. Past behaviour does not guarantee future results. The tool's own accuracy is measured and published, and may be no better than chance.

---

## 15. Build findings and deviations (added during the build, 15 Nov 2026)

What the real data showed, and where the build differs from the sections above. Where this section and an earlier one disagree, this section is what was built.

### 15.1 Findings

| Topic | Finding | Consequence |
|---|---|---|
| NSE holiday file | On a holiday `sec_bhavdata_full` answers 200 but serves the previous session's rows | The date inside the file is always checked. `sec_bhavdata_full` (from Jan 2020) is the primary official file; the UDiFF bhavcopy is not used |
| Special sessions | Seven weekend sessions in 5 years (Muhurat, budget day, special Saturdays) | Detected from the data: if most stocks' "previous close" differs from the last archived close, the days in between are probed |
| Corporate actions | Yahoo's event list misses bonuses and demergers, and for Trent it adjusted only part of the history | The adjustment factor is measured from official close / Yahoo close, a step is believed only if the official overnight move supports it, and any remaining overnight drop over 25% is treated as an estimated corporate action (Tata Motors demerger) |
| Source agreement | After that, NSE and Yahoo closes agree within 0.1% on 99.3% of 59,000 comparisons; 53 Yahoo bad prints | Official prices win wherever both exist |
| Direction | "Similar days" carry no information about next-session direction. The overnight S&P 500 move does: 53.6% correct against 50.5% for "always up" over 37,182 walk-forward forecasts | Direction probability = base rate + overnight shift, shrunk toward 50% by a walk-forward calibration |
| Ranges | The raw 90% close range covered 88% | A walk-forward (conformal) width correction brings it to 89.6%; the same is done for the gap and the session range, and touch probabilities get a straight-line recalibration |
| Plan rules | Breakout: -0.21 R per trade after costs. Pullback: -0.11 R. Both negative on all 50 stocks over 10 years. Gap-down reversal: about +0.06 R with a confidence interval that includes zero | **No one-session long rule has a reliable edge after costs.** The call is "no trade" unless a rule's own record on that stock is positive after shrinking toward the all-stock record |
| Setup score | Rule results are flat across setup-score bands | The score is shown as descriptive "trend health" only; it does not drive the call |

### 15.2 Deviations from sections 6 and 10

- **Calls (6.2):** `FAVOURABLE` (rule record positive and unlikely to be luck), `NEUTRAL` (positive but weak evidence), `NO_TRADE` (no tested edge, illiquid, data flag, or not enough history). When the call is `NO_TRADE`, levels are still shown as reference, with each rule's measured record next to them.
- **Plan types (6.3):** three rules are tracked every day so the live ledger keeps testing all of them: `breakout`, `pullback`, `gap_reversal`. Parameters are in `config/model.yaml`, with the count of variants examined.
- **Baseline (7.3):** plan rules are compared with not trading (zero) and with a naive "buy at every open, 1 ATR stop, sell at the close" rule, instead of random entries.
- **Files (10):** `calendar.py` is `tradingcal.py` (avoids shadowing Python's own module). Added `engine.py` (one code path for live and replay), `decide.py`, `setupscore.py`, `costs.py`, `dataset.py`, `store.py`, `ingest.py`, `jobs.py`, `replay.py`, `walkforward.py`, `http.py`.
- **Price history (12.3):** `config/publish.yaml` has one switch, `publish_prices`. While it is `false`, charts are published in percent relative to the latest close.

### 15.3 Added after the plan was written (owner requests, 15-16 Nov 2026)

- **Weekly self-training (`learner.py`).** A ridge logistic regression and gradient-boosted trees are retrained for each week on every stock-day whose outcome was known before that Monday, and predict the chance of an up close. A gate (non-negative least squares over the previous 250 sessions of out-of-sample forecasts) decides how much each source counts; a model that has not helped gets weight zero. Measured on the 3-year walk-forward: direction hit rate 54.0% (53.6% without the models), Brier skill +0.86% with a day-clustered interval that excludes zero. Either model alone was no better than the simple overnight signal. `data/learning.json` logs each training week.
- **India time everywhere.** The site formats every clock and date in Asia/Kolkata regardless of the viewer's time zone. Pipeline times are IST; GitHub cron is UTC.
- **Site name and files.** The site is called "Dalal Desk". `web/` holds `index.html`, `styles.css`, `app.js` and `js/` (core, charts, today, track, archive, how). There is no build step.
- **"Make a plan" page (`web/js/plan.js`, second in the navigation).** Three inputs: investment amount, target earnings for the planned session, and risk tolerance (the share of the amount that may be lost). It sizes the already-published levels for that money and reports whether the three fit together. If they do, it lists up to 8 stocks (one rule each) with buy and sell conditions, holding period, best case, loss at the stop, and chances read from each rule's past results. If they do not, it says why and offers alternatives (a lower target, the most the amount could earn and the risk that needs, the amount and risk the target would need). It forecasts nothing new: the pipeline publishes `data/planner.json` (levels plus each rule's record, built from the symbol files) and the arithmetic is in `web/js/planlogic.js`. This extends the browser's role in 4.3 from rupee scaling to sizing and screening; decisions about calls still live only in Python. Estimates include charges and slippage and are labelled as estimates.
- **Newcomer guidance and extra statistics (16 Nov 2026).** A dismissible welcome card with four steps, a Help button with a searchable glossary, an "In plain words" card with a traffic-light verdict for each stock, a side-by-side table of the three rules, a "market at a glance" card (advancers and decliners, biggest movers, average swing, how many stocks lean up), and a summary strip on the plan page. These only count and describe published numbers (`web/js/insight.js`); they decide nothing. Motion added: a longer intro with skip, page-change progress bar, loading placeholders, a pointer-following highlight on cards, button ripples. All of it is turned off when the viewer asks for reduced motion.
- **"Accuracy check" page (`web/js/accuracy.js`, third in the navigation, 16 Nov 2026).** Draws each day's predicted 90% close range (as a bar, in rupees or %) against the real close (a dot: green inside, red outside; plus the real price line), with live days shaded, a day-by-day strip, the last 15 days in a table, and plain-language verdicts. A whole-market view charts, per day, the share of the 50 closes inside their range against the share of up/down leans that were right. Data: `data/compare.json`, rebuilt by every publish from the day pages (`publish.compare_file`); arithmetic in `web/js/comparelogic.js`. No verdict is given before 10 separate sessions, because stocks on one day move together.
- **Simple Home page (`web/js/home.js`, default route, 21 Nov 2026).** For first-time visitors: choose a stock, see the next-day plan in plain words and rupees (for ₹10,000 / ₹50,000 / ₹1,00,000 or a typed amount), what following the last session's plan would have earned, and how many of the last 20 predictions were correct. The detailed pages moved under a "More" menu ("Today" is now "Pro view"). Money for past days is the amount times the plan's net % return after charges, which `compare.json` now carries for all three rules (`publish.compare_file`; day pages carry `ret_pct` per rule from the next weekly run). Arithmetic in `web/js/homelogic.js`.
- **Multi-day swing research (`pipeline/research.py`, 21 Nov 2026).** Six well-known long rules (RSI(2) dip, three down days, weakest of the week, 20-day breakout on volume, six-month momentum, sharp one-day drop) held 2, 3 and 5 sessions (test 1, pre-registered), then 10 and 20 sessions (test 2, added after test 1 failed and reported separately): 30 variants. Full delivery costs (about 0.39% per round trip on liquid stocks, `delivery:` in `config/costs.yaml`); each trade compared with holding the same 50 stocks over the same days; discovery 2017-2020, validation 2021 onward; pass = mean excess > 0 with Newey-West t >= 2 in both periods. **Result: none passed.** Before costs every rule was within about ±0.3% of holding per trade; after costs all trailed holding in at least one period. A positive-control test confirms the method detects a planted edge. Re-run every Sunday by `run_weekly` (same rules, nothing re-tuned) into `data/research.json`; shown on How it works and summarised on Home.
- **Paper-trading journal (`web/js/journal.js`, "My journal").** "I'd follow this plan" on Home stores the plan in the visitor's browser only; after the session is scored, the journal shows what it would have earned (amount × the plan's net % return from `compare.json`), with totals, a running result chart, CSV download and a two-step clear.
- **Unfinished-session guard.** Yahoo lists today's bar during Indian market hours; `dataset.finished_only` drops Indian vendor rows dated after `config.last_finished_session_day()` (today only from 15:45 IST).
- **Website tests.** `web/tests/*.test.mjs` run under Node with a small stand-in for the browser (no dependencies); `pipeline/tests/test_web.py` runs them from pytest. They cover the planner and a fixed bug where switching rule tabs on the Today page left the redrawn cards invisible.
- **Scheduling.** One workflow, `.github/workflows/pipeline.yml`, carries all three schedules and deploys Pages in the same run; `tests.yml` runs the test suite on code changes.
