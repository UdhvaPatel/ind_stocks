# Manual steps for you

The app is built. These are the things only you can do. Do section A in order to put it on GitHub;
section B can be done any time; section C is how to look at it on your own computer right now.

Status key: `[ ]` to do, `[x]` done (tick them yourself as you go).

---

## A. Put it on GitHub so it runs by itself (about 10 minutes, once)

After this, nothing depends on your computer. GitHub runs the jobs on its own schedule
(06:00 IST plan, 18:00 IST result, Sunday training) and hosts the website.

Your code repository is **`UdhvaPatel/ind_stocks`**. Set up and running on GitHub since 21 Nov 2026 (IST): the site is live at https://udhvapatel.github.io/ind_stocks/ and the daily jobs run by themselves. You no longer need the daily routine in section C.

- [x] **A0. Code uploaded** to https://github.com/UdhvaPatel/ind_stocks (branch `main`).
- [x] **A0b. Vault prepared** on your computer (`D:\Projects\ind_stocks\vault`, committed, not uploaded yet).

- [x] **A1. Make the repository public** (free GitHub Pages only works for public repositories).
  1. Open https://github.com/UdhvaPatel/ind_stocks/settings
  2. Scroll to the bottom, to **Danger Zone** → **Change repository visibility** → **Change visibility**
  3. Choose **Make public**, then confirm each prompt (GitHub asks you to type `UdhvaPatel/ind_stocks`
     and may ask for your password or a code from your phone)

- [x] **A2. Turn on GitHub Pages.**
  1. Open https://github.com/UdhvaPatel/ind_stocks/settings/pages
  2. Under **Build and deployment**, set **Source** to **GitHub Actions**

- [x] **A3. Publish the website now.**
  1. Open https://github.com/UdhvaPatel/ind_stocks/actions
  2. If GitHub asks, click **I understand my workflows, go ahead and enable them**
  3. In the left list click **pipeline** → **Run workflow** → Job: **deploy** → **Run workflow**
  4. Wait for the green tick (about 1 minute). Your site is then at
     **https://udhvapatel.github.io/ind_stocks/**
  From now on, every push that changes the site redeploys it by itself.

  The steps below let GitHub also *update the data* every day. Until they are done, keep running
  the daily routine on your own computer (section C) and push the result.

- [x] **A4. Create the private vault repository** (holds raw price data that must not be published).
  1. Go to https://github.com/new
  2. Repository name: `ind-stocks-vault` (exactly this; the workflow looks for it)
  3. Visibility: **Private**
  4. Leave "Add a README", ".gitignore" and "licence" **unticked**
  5. Click **Create repository**
  6. Tell me, and I upload the vault. (Or run this yourself in PowerShell:)
     ```
     cd D:\Projects\ind_stocks\vault
     git remote add origin https://github.com/UdhvaPatel/ind-stocks-vault.git
     git push -u origin main
     ```

- [x] **A5. Create an access token so the daily jobs can read and write the vault.**
  1. Go to https://github.com/settings/personal-access-tokens/new
  2. Token name: `ind-stocks-vault-writer`
  3. Expiration: 1 year. **Put a reminder in your calendar to renew it**: when it expires the daily jobs stop.
  4. Repository access: **Only select repositories** → choose `ind-stocks-vault`
  5. Permissions → Repository permissions → **Contents: Read and write**
  6. Click **Generate token** and copy it (it is shown only once). Do not paste it into a chat.

- [x] **A6. Store the token as a secret.**
  1. Open https://github.com/UdhvaPatel/ind_stocks/settings/secrets/actions
  2. Click **New repository secret**
  3. Name: `VAULT_TOKEN`   Value: the token from A5
  4. Click **Add secret**

- [x] **A7. Start the data jobs once by hand.**
  1. Open https://github.com/UdhvaPatel/ind_stocks/actions → **pipeline** → **Run workflow**
  2. Job: **weekly** → **Run workflow**, and wait for the green tick (about 10 minutes)
  From then on GitHub runs the 06:00 plan, the evening result and Sunday training by itself,
  and you can stop the daily routine in section C. Before pushing anything yourself after that,
  run `git pull` first, because GitHub will be adding a data commit every day.

- [ ] **A8. Stop anyone (including a mistake) rewriting history.** Do this for both repositories.
  1. Open https://github.com/UdhvaPatel/ind_stocks/settings/rules → **New ruleset** → **New branch ruleset**
  2. Name: `protect main`. Enforcement status: **Active**
  3. Target branches: **Add target** → **Include default branch**
  4. Tick **Restrict deletions** and **Block force pushes**. Leave everything else unticked
     (the daily jobs must still be able to push normally).
  5. Click **Create**. Repeat at https://github.com/UdhvaPatel/ind-stocks-vault/settings/rules
- [ ] **A9. Make sure GitHub emails you when a run fails.** Open https://github.com/settings/notifications,
  find **Actions**, and make sure email notifications are on ("Only notify for failed workflows" is fine).
  From now on the last morning and evening runs fail on purpose if the day's work is missing, so this email is your alarm.
- [ ] **A10 (optional). An outside alarm for days GitHub skips a run entirely.** Create a free check at
  healthchecks.io yourself (period 1 day, grace 12 hours), copy its ping URL, and add it as a repository secret named
  `HEALTHCHECK_URL` (same place as `VAULT_TOKEN`). If the pings stop, healthchecks.io emails you. Skip this if you prefer.

**Important: plans made on your computer no longer count as live.** Only plans written by GitHub's 06:00 IST job
(before the 09:15 open) are counted in the live record, because only those can be checked by anyone. Plans made with
`run_premarket` on your computer are labelled "not proven". So once GitHub runs the jobs, don't run them locally.

### If something goes wrong on GitHub

- A red cross in the **Actions** tab: click the run, then the red step, and send me the last 30 lines.
- "Resource not accessible" or the vault step fails: the token in A5/A6 is wrong or expired. Redo A5 and A6.
- The site shows "This data is out of date": a scheduled run was skipped. Open **Actions → pipeline → Run workflow** and run `eod`.
- A market holiday or special session is missing: see B1 below. For a special weekend session
  (for example Muhurat trading), run `premarket` by hand before the session and `eod` after it.

---

## B. Things only you can check (optional; they improve accuracy)

- [ ] **B1. NSE trading holidays.** Open the NSE holiday list for this year and next
  (nseindia.com → Resources → Exchange Communication → Holidays, "Trading holidays").
  Edit `config/holidays.yaml` so it lists every **weekday** holiday from today onward.
  I pre-filled two that I am fairly sure of (24 Nov 2026 Guru Nanak Jayanti, 25 Dec 2026 Christmas),
  marked `verified: false`. Change to `verified: true` once checked. Repeat each December.
  If you skip this nothing breaks: on an unlisted holiday a plan is issued and later voided as "no session".

- [ ] **B2. Your broker's intraday charges.**
  1. Find one recent **intraday** (same-day buy and sell) contract note from your broker.
  2. Open `config/costs.yaml`.
  3. Under `brokerage`, set `pct_per_order` and `max_per_order` to your broker's intraday rate
     (default: 0.03% of order value, capped at Rs 20 per order).
  4. Compare the note's STT, exchange charge, SEBI fee, stamp duty and GST with the file and fix any that differ.
  5. Change `verified: false` to `verified: true`.
  If you skip this, the app uses the defaults, which are typical for a discount broker.

- [ ] **B3. Decide whether charts may show rupee prices.**
  `config/publish.yaml` has `publish_prices: false`. With `false`, charts are drawn in percent
  (relative to the latest close) and no rupee price history is published; the plan card still shows
  yesterday's close and the plan levels in rupees.
  Change it to `true` only after you have read the NSE website terms and Yahoo's terms and are satisfied
  that showing 120 days of daily prices on a public page is allowed.

- [ ] **B4. Before sharing the link with anyone,** read section 12 of `PLAN.md`. The site is public, and I
  could not confirm how SEBI's rules apply to a tool like this. The site is marked "do not index" for
  search engines and carries a disclaimer on every page, but that is not legal clearance.

After changing any file in B1 to B3, upload the change:
```
cd D:\Projects\ind_stocks
git add .
git commit -m "config update"
git push
```

---

## C. Look at it on your own computer now

1. Open a terminal and run:
   ```
   cd D:\Projects\ind_stocks
   python -m http.server 8765
   ```
2. Open http://127.0.0.1:8765/web/ in your browser.
3. Press Ctrl+C in the terminal to stop.

The clock and every date on the site are India time (IST), even though your computer is on US Central time.

### Daily routine while you run it on your own computer

You are in US Central time. India is 11 hours 30 minutes ahead of US Central in winter
(10 hours 30 minutes ahead from March to early November, when the US is on daylight time).
Times below are for winter. Run each command in a terminal opened in `D:\Projects\ind_stocks`.

| When (US Central) | When (India) | Run this | What it does |
|---|---|---|---|
| **6:30 PM to 9:15 PM**, Sunday to Thursday evening | 06:00 to 08:45 the next morning, before the open | `python -m pipeline.run_premarket` | Writes down the plan for the coming Indian session. **This is the plan that gets scored.** After 9:15 PM Central it refuses, because the plan would no longer be written before the open |
| **After 6:30 AM**, Monday to Friday | after 18:00, once the market has closed | `python -m pipeline.run_eod` | Fetches the official closing prices, scores the morning's plan and drafts the next one |
| Sunday, any time | Sunday | `python -m pipeline.run_weekly` | Retrains the models (about 8 minutes) |

- If you miss the evening window, the plan for that session is simply "not issued". Nothing breaks.
- Running `run_eod` while the Indian market is still open (10:45 PM to 5:00 AM Central) is now safe:
  it ignores the half-finished day and waits for the close.
- Once the GitHub setup in section A is done, GitHub does all of this for you and you can stop.

To refresh the data by hand on your computer (not needed once GitHub is running it):
```
python -m pipeline.run_eod --always      (evening job)
python -m pipeline.run_premarket         (morning job; only commits a plan before 08:45 IST on a trading day)
python -m pipeline.run_weekly            (Sunday training and backtest; takes about 8 minutes)
```

---

## D. Good to know

- **Name.** I called the site "Dalal Desk" (after Dalal Street). To rename it, tell me the name you want.
- **Home page.** The site now opens on a simple Home page: choose a stock, see the plan for the next market
  day, and see how past predictions did in rupees. The detailed pages are under **More** (Pro view, Track
  record, Archive, How it works).
- **Paper trading.** On Home, press **I'd follow this plan**. **My journal** shows what would have happened after
  that market day closes. It is saved only in the browser you used, so a different phone or browser has its own journal.
- **Strategy research.** How it works now shows the test of 30 trading rules (none beat simply holding the stocks
  after costs). It re-runs by itself every Sunday on the newest data.
- **Help for newcomers.** First-time visitors see a "New here?" card on the Today page; "Got it" hides it
  for good on that browser. The round **?** button at the bottom right opens a plain-English glossary at any time.
- **Checking accuracy.** Open **Accuracy check** (third tab). Pick a stock, or "All 50 stocks together",
  and a period. Blue bars are what the tool predicted the morning before; dots are the real closing prices
  (green landed inside, red landed outside). Shaded days are live; the rest are a backtest replay. The page
  holds back its verdict until there are at least 10 live days. It updates every time you run `run_eod`.
- **Make a plan page.** The second tab asks for an amount, a target for the day and a risk tolerance, then
  shows which of the published levels fit, or why none do and what would. Its figures are estimates from
  past behaviour, not promises. It needs `data/planner.json`, which every scheduled job now writes.
- **Weekly training.** Every Sunday at 10:00 IST the two direction models are retrained on all data up to
  that week. The Track record page has a "Weekly self-training" card that shows what they learned and how
  much their vote currently counts.
- **GitHub pauses schedules in a repository with no activity for 60 days.** The daily data commits count
  as activity, so this should not happen; if GitHub ever emails you about it, click the link to re-enable.
