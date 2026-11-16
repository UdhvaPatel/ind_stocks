# Manual steps for you

The app is built. These are the things only you can do. Do section A in order to put it on GitHub;
section B can be done any time; section C is how to look at it on your own computer right now.

Status key: `[ ]` to do, `[x]` done (tick them yourself as you go).

Wherever you see `YOUR-USERNAME`, type your GitHub username.

---

## A. Put it on GitHub so it runs by itself (about 20 minutes, once)

After this, nothing depends on your computer. GitHub runs the jobs on its own schedule
(06:00 IST plan, 18:00 IST result, Sunday training) and hosts the website.

- [ ] **A1. Create the public site repository.**
  1. Go to https://github.com/new
  2. Repository name: `ind-stocks-site`
  3. Visibility: **Public** (GitHub Pages is free only for public repositories)
  4. Leave "Add a README", ".gitignore" and "licence" **unticked**
  5. Click **Create repository**

- [ ] **A2. Create the private vault repository** (holds raw price data that must not be published).
  1. Go to https://github.com/new
  2. Repository name: `ind-stocks-vault` (use exactly this name; the workflow looks for it)
  3. Visibility: **Private**
  4. Leave "Add a README" **unticked**
  5. Click **Create repository**

- [ ] **A3. Create an access token so the site's jobs can write to the vault.**
  1. Go to https://github.com/settings/personal-access-tokens/new
  2. Token name: `ind-stocks-vault-writer`
  3. Expiration: 1 year. **Put a reminder in your calendar to renew it**: when it expires the daily jobs stop.
  4. Repository access: **Only select repositories** → choose `ind-stocks-vault`
  5. Permissions → Repository permissions → **Contents: Read and write**
  6. Click **Generate token** and copy it (it is shown only once)

- [ ] **A4. Store the token as a secret in the site repository.**
  1. Open `ind-stocks-site` on GitHub → **Settings** → **Secrets and variables** → **Actions**
  2. Click **New repository secret**
  3. Name: `VAULT_TOKEN`   Value: the token from A3
  4. Click **Add secret**

- [ ] **A5. Turn on GitHub Pages.**
  1. Open `ind-stocks-site` → **Settings** → **Pages**
  2. Under **Build and deployment**, set **Source** to **GitHub Actions**

- [ ] **A6. Upload the raw data to the vault.** Open a terminal (PowerShell) and run these one at a time:
  ```
  cd D:\Projects\ind_stocks\vault
  git init -b main
  git add .
  git commit -m "vault: history"
  git remote add origin https://github.com/YOUR-USERNAME/ind-stocks-vault.git
  git push -u origin main
  ```

- [ ] **A7. Upload the app.** In the same terminal:
  ```
  cd D:\Projects\ind_stocks
  git add .
  git commit -m "Dalal Desk: first version"
  git remote add origin https://github.com/YOUR-USERNAME/ind-stocks-site.git
  git push -u origin main
  ```
  (The `vault` folder is deliberately left out of this upload.)

- [ ] **A8. Start it once by hand.**
  1. Open `ind-stocks-site` on GitHub → **Actions** tab
  2. If GitHub asks, click **I understand my workflows, go ahead and enable them**
  3. In the left list click **pipeline** → **Run workflow** → Job: **weekly** → **Run workflow**
  4. Wait for the green tick (about 10 minutes). The first run also publishes the website.

- [ ] **A9. Open your site.** `https://YOUR-USERNAME.github.io/ind-stocks-site/`
  From now on it updates itself. The first **live** result appears after the first trading day
  on which the 06:00 IST job committed a plan.

### If something goes wrong on GitHub

- A red cross in the **Actions** tab: click the run, then the red step, and send me the last 30 lines.
- "Resource not accessible" or the vault step fails: the token in A3/A4 is wrong or expired. Redo A3 and A4.
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

To refresh the data by hand on your computer (not needed once GitHub is running it):
```
python -m pipeline.run_eod --always      (evening job)
python -m pipeline.run_premarket         (morning job; only commits a plan before 08:45 IST on a trading day)
python -m pipeline.run_weekly            (Sunday training and backtest; takes about 8 minutes)
```

---

## D. Good to know

- **Name.** I called the site "Dalal Desk" (after Dalal Street). To rename it, tell me the name you want.
- **Make a plan page.** The second tab asks for an amount, a target for the day and a risk tolerance, then
  shows which of the published levels fit, or why none do and what would. Its figures are estimates from
  past behaviour, not promises. It needs `data/planner.json`, which every scheduled job now writes.
- **Weekly training.** Every Sunday at 10:00 IST the two direction models are retrained on all data up to
  that week. The Track record page has a "Weekly self-training" card that shows what they learned and how
  much their vote currently counts.
- **GitHub pauses schedules in a repository with no activity for 60 days.** The daily data commits count
  as activity, so this should not happen; if GitHub ever emails you about it, click the link to re-enable.
