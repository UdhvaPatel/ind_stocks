"""Steps shared by the scheduled jobs (premarket, eod, weekly).

Every step is idempotent: running a job twice gives the same files, and a job
that finds nothing to do exits without changing anything.
"""
from __future__ import annotations

import json
import os
from datetime import date, datetime, time, timedelta, timezone

from . import config, dataset, ingest, ledger, publish, score, store, universe, validate, walkforward
import numpy as np

from . import learner
from .engine import CALIB_WINDOW, Engine
from .http import FetchError, Http

ISSUE_CUTOFF = time(8, 45)          # IST: after this no new plan is issued for today
MARKET_OPEN = time(9, 15)           # IST: not even a forced run may issue a plan after this


def log(msg: str) -> None:
    print(f"[{config.now_ist():%H:%M:%S}] {msg}", flush=True)


# ------------------------------------------------------------------ fetching
def catch_up_nse(http: Http) -> dict:
    """Archive every official session from the last archived one up to today."""
    days = store.open_days()
    start = (days[-1] + timedelta(days=1)) if days else config.today_ist() - timedelta(days=10)
    end = config.today_ist()
    if not store.tracked_symbols():
        universe.refresh_universe(http)
    counts = ingest.backfill_nse(http, start, end, log=log) if start <= end else {}
    recovered = ingest.find_missing_sessions(http, log=log) if counts.get("saved") else []
    return {"counts": counts, "recovered": [d.isoformat() for d in recovered]}


def refresh_yahoo(http: Http) -> dict:
    symbols = ingest.all_yahoo_symbols(universe.plan_symbols())
    status = ingest.refresh_yahoo_daily(http, symbols, config.universe_cfg()["history_years"], log=log)
    failed = sorted(k for k, v in status.items() if v != "ok")
    return {"ok": len(status) - len(failed), "failed": failed}


def build_engine() -> Engine:
    return Engine(dataset.load_dataset(universe.plan_symbols()))


# ------------------------------------------------------------------- scoring
def scores_path(month: str):
    return config.DATA_DIR / "scores" / f"{month}.json"


def load_scores() -> dict[str, dict]:
    out = {}
    root = config.DATA_DIR / "scores"
    for path in sorted(root.glob("*.json")) if root.exists() else []:
        out.update(json.loads(path.read_text(encoding="utf-8")))
    return out


def save_scores(scores: dict[str, dict]) -> None:
    by_month: dict[str, dict] = {}
    for sid, s in scores.items():
        by_month.setdefault(s["for_date"][:7], {})[sid] = s
    for month, items in by_month.items():
        publish.write_json(scores_path(month), dict(sorted(items.items())))


def score_pending(engine: Engine, replay_fn=None) -> list[str]:
    """Score every ledger record whose session is over. Returns the dates that changed."""
    records = ledger.load()
    scores = load_scores()
    todo = [rec for rec in records if rec["id"] not in scores]
    if not todo:
        return []
    open_days = set(store.open_days())
    closed = store.closed_days()
    last = max(open_days) if open_days else None
    first = min(date.fromisoformat(rec["for_date"]) for rec in todo)
    eod = store.load_nse_eod(first)
    bars = {(row.symbol, row.date): row for row in eod.itertuples(index=False)} if len(eod) else {}

    changed = set()
    for rec in todo:
        d = date.fromisoformat(rec["for_date"])
        sym = rec["symbol"]
        if d in open_days:
            row = bars.get((sym, d))
            void = None
            st = engine.states.get(sym)
            as_of = date.fromisoformat(rec["as_of"])
            if not ledger.made_before_open(rec):
                void = "written after the market opened, so it cannot count as a prediction"
            elif row is None:
                void = "the stock did not trade in this session"
            elif st is not None and as_of in st.pos and d in st.pos:
                f0, f1 = st.df["factor"].iloc[st.pos[as_of]], st.df["factor"].iloc[st.pos[d]]
                if abs(f0 / f1 - 1) > 1e-6:
                    void = "corporate action on the session day (levels no longer comparable)"
            bar = None if row is None else {"open": row.open, "high": row.high, "low": row.low, "close": row.close}
            plan_results = replay_fn(rec, d) if (replay_fn and bar and not void) else None
            s = score.resolve(rec, bar, void, engine.ccfg, plan_results)
        elif d in closed:                                   # confirmed: listed holiday or proven by later data
            s = score.resolve(rec, None, "no trading session on this date")
        elif last is not None and d < last:
            log(f"{rec['for_date']}: official file still missing; the prediction stays unscored until it arrives")
            continue
        else:
            continue                                        # session not over or file not published yet
        s["setup"] = rec["inputs"].get("setup")
        s["claims"] = rec["claims"]
        s["plan_levels"] = rec["plans"]
        s["prev_close"] = rec["inputs"]["prev"]["close"]
        s["made_at"] = rec["made_at"]
        s["runner"] = (rec.get("source") or {}).get("runner", "local")
        s["verified"] = ledger.verified(rec)
        scores[rec["id"]] = s
        changed.add(rec["for_date"])
    if changed:
        save_scores(scores)
        for day in changed:
            day_scores = [s for s in scores.values() if s["for_date"] == day]
            publish.write_day(day, day_scores, day_track(day_scores), engine.mcfg["model_version"])
    return sorted(changed)


def day_track(day_scores: list[dict]) -> str:
    """'live' only when the day's plans were made by the scheduled workflow before the open;
    plans made elsewhere (for example on a laptop) are 'unverified': nobody can check when."""
    return "live" if any(s.get("verified") for s in day_scores) else "unverified"


# ---------------------------------------------------------------- publishing
def issue_plan(engine: Engine, force: bool = False) -> tuple[str, date]:
    """Commit today's plan to the ledger if today is its session and it is early enough.

    Returns (plan_status, for_date) where plan_status is one of
    "scored" (in the ledger), "draft" (for a future session), "not_issued".
    """
    version = engine.mcfg["model_version"]
    as_of = engine.last_session
    for_date = engine.calendar.next_trading_day(as_of)
    now = config.now_ist()
    if ledger.has_plan_for(for_date, version):
        return "scored", for_date
    if for_date > now.date():
        return "draft", for_date                           # the 06:00 run on that day will commit it
    if for_date < now.date():
        return "not_issued", for_date                      # data is stale: the session already passed
    if now.time() > ISSUE_CUTOFF and not force:
        return "not_issued", for_date
    if now.time() >= MARKET_OPEN:                          # never, not even forced: it would see the open
        log("refusing to issue a plan after 09:15 IST: the session has started")
        return "not_issued", for_date
    vix = float(engine.ds.vix.iloc[-1]) if len(engine.ds.vix) else None
    made = datetime.now(timezone.utc)
    records = [ledger.make_record(e, for_date, version, made, vix) for e in engine.book(as_of).values()]
    written = ledger.append(records)
    log(f"ledger: {written} predictions committed for {for_date}")
    return "scored", for_date


def publish_site(engine: Engine, plan_status: str, for_date: date, status: dict) -> None:
    pub = config.load_yaml("publish.yaml")
    version = engine.mcfg["model_version"]
    as_of = engine.last_session
    uni = {s["symbol"]: s for s in universe.load_universe()["stocks"]}
    book = engine.book(as_of, detail=True)
    files = []
    for sym, entry in book.items():
        files.append(publish.clean(
            publish.symbol_file(engine, entry, uni.get(sym, {}), for_date, plan_status, pub,
                                engine.ds.issues.get(sym, []))))
        publish.write_json(config.DATA_DIR / "symbols" / f"{publish.safe_name(sym)}.json", files[-1])
    publish.write_json(config.DATA_DIR / "planner.json", publish.planner_file(files, version))
    publish.write_json(config.DATA_DIR / "market.json", publish.market_file(engine, book, as_of))

    scores = load_scores()
    by_day: dict[str, list[dict]] = {}
    for s in scores.values():
        by_day.setdefault(s["for_date"], []).append(s)
    day_root = config.DATA_DIR / "days"
    tracks = {d: day_track(v) for d, v in by_day.items()}
    for d, v in by_day.items():                         # keep each scored day page's label in step with the rule
        page = day_root / d / "summary.json"
        try:
            current = json.loads(page.read_text(encoding="utf-8")).get("track") if page.exists() else None
        except ValueError:
            current = None
        if current != tracks[d]:
            publish.write_day(d, v, tracks[d], version)
    all_days = sorted(p.name for p in day_root.iterdir() if p.is_dir()) if day_root.exists() else []
    publish.write_json(day_root / "index.json",
                       {**publish.stamp(version),
                        "days": [{"date": d, "track": tracks.get(d, "backtest")} for d in all_days]})
    publish.write_compare(day_root, version)
    write_track(engine, scores)
    from . import allocator, portfolio
    publish.write_json(config.DATA_DIR / "portfolio.json", portfolio.summary(engine, scores, allocator.load_report()))
    learning_report(engine)

    now = config.now_ist()
    cal = engine.calendar
    upcoming, d = [], as_of
    for _ in range(3):
        d = cal.next_trading_day(d)
        upcoming.append(d.isoformat())
    publish.write_json(config.DATA_DIR / "meta.json", {
        **publish.stamp(version),
        "last_eod_date": as_of.isoformat(),
        "plan_for_date": for_date.isoformat(),
        "plan_status": plan_status,
        "result_date": max(by_day) if by_day else None,          # the latest session with scored predictions
        "today_ist": now.date().isoformat(),
        "today_is_session": cal.is_trading_day(now.date()),
        "upcoming_sessions": upcoming,
        "pipeline_status": status.get("pipeline_status", "ok"),
        "message": status.get("message"),
        "sources": status.get("sources", {}),
        "session": {"open": "09:15", "close": "15:30", **engine.mcfg["session"]},
        "costs": engine.ccfg,
        "ticks": engine.mcfg["ticks"],
        "variants_tried": engine.mcfg["variants_tried"],
        "publish_prices": pub["publish_prices"],
        "symbols": sorted(book),
    }, indent=1)


def write_track(engine: Engine, scores: dict[str, dict]) -> None:
    version = engine.mcfg["model_version"]
    mine = [s for s in scores.values() if s["model_version"] == version]
    live = [s for s in mine if s.get("verified")]
    unverified = [s for s in mine if not s.get("verified")]
    backtest_path = config.DATA_DIR / "backtest.json"
    backtest = json.loads(backtest_path.read_text(encoding="utf-8")) if backtest_path.exists() else None
    publish.write_json(config.DATA_DIR / "track.json", {
        **publish.stamp(version),
        "live": {"aggregate": score.aggregate(live), "by_symbol": score.by_symbol(live),
                 "label": "Live (out of sample)",
                 "note": "Plans written by the scheduled GitHub job before 09:15 IST and committed publicly, "
                         "scored against official NSE data."},
        "unverified": {"records": len(unverified), "days": sorted({s["for_date"] for s in unverified}),
                       "note": "Plans made outside the scheduled job (for example on a laptop) or after the open. "
                               "Their timing cannot be checked, so they are scored but kept out of the live record."},
        "backtest": backtest,
        "min_n": score.MIN_N,
    })


def learning_report(engine: Engine) -> dict:
    """What the weekly-trained models learned and how much they are trusted right now.

    Written on every run and extended with one history entry per training week,
    so the site can show the model improving (or not) week by week.
    """
    as_of = engine.last_session
    cal = engine.calibration(as_of)
    sym = next(iter(engine.states))
    st0 = engine.states[sym]
    info = engine.learner.info(sym, st0.pos[as_of])

    # Out-of-sample record of each source over the last CALIB_WINDOW sessions.
    parts = []
    for st in engine.states.values():
        i = st.pos.get(as_of)
        if i is not None:
            parts.append(st.hist[max(i - CALIB_WINDOW, 0):i])
    arr = np.vstack(parts) if parts else np.zeros((0, 15))
    arr = arr[np.isfinite(arr[:, 3]) & np.isfinite(arr[:, 4])]
    y = arr[:, 4]

    def record(p):
        ok = np.isfinite(p)
        if ok.sum() < 30:
            return None
        base = float(np.mean((0.5 - y[ok]) ** 2))
        brier = float(np.mean((p[ok] - y[ok]) ** 2))
        return {"n": int(ok.sum()), "hit": round(float(np.mean((p[ok] > 0.5) == (y[ok] > 0.5))), 4),
                "brier": round(brier, 5), "skill_vs_coin": round(1 - brier / base, 4)}

    lean = lambda col: np.nan_to_num(arr[:, col] - 0.5)
    blend = 0.5 + cal["dir_base"] * lean(3) + cal["dir_lr"] * lean(13) + cal["dir_gbm"] * lean(14)
    sources = {"simple": record(arr[:, 3]), "logistic": record(arr[:, 13]),
               "trees": record(arr[:, 14]), "blend": record(np.clip(blend, 0.02, 0.98))}
    weights = {"simple": cal["dir_base"], "logistic": cal["dir_lr"], "trees": cal["dir_gbm"]}

    top = []
    if info:
        ranked = sorted(info["weights"].items(), key=lambda kv: -abs(kv[1]))[:10]
        top = [{"feature": k, "label": learner.FEATURES[k], "weight": v} for k, v in ranked]

    path = config.DATA_DIR / "learning.json"
    history = json.loads(path.read_text(encoding="utf-8")).get("history", []) if path.exists() else []
    if info:
        entry = {"week": info["week"], "rows": info["rows"], "trained_to": info["to"],
                 "weights": weights, "window_sessions": CALIB_WINDOW,
                 "hit": {k: (v or {}).get("hit") for k, v in sources.items()},
                 "skill": {k: (v or {}).get("skill_vs_coin") for k, v in sources.items()}}
        history = [h for h in history if h["week"] != info["week"]] + [entry]
        history.sort(key=lambda h: h["week"])
    out = {
        **publish.stamp(engine.mcfg["model_version"]),
        "as_of": as_of.isoformat(),
        "trained": info and {k: info[k] for k in ("week", "rows", "from", "to", "up_share")},
        "next_training": (learner.monday(engine.calendar.next_trading_day(as_of))
                          + timedelta(days=7)).isoformat(),
        "blend_weights": weights,
        "window_sessions": CALIB_WINDOW,
        "sources": sources,
        "top_weights": top,
        "history": history[-104:],
        "how": ("Every week two models are retrained on all data whose outcome was known before that "
                "Monday. Their vote counts only as much as their last 250 sessions of real predictions "
                "have earned; a model that has not helped gets weight zero."),
    }
    publish.write_json(path, out, indent=1)
    return out


# ------------------------------------------------------------- weekly extras
def run_backtest(engine: Engine) -> dict:
    """Walk-forward replay for the scoreboard's backtest tab and recent day pages."""
    pub = config.load_yaml("publish.yaml")
    version = engine.mcfg["model_version"]
    end = engine.last_session
    start = end - timedelta(days=int(365.25 * pub["backtest_years"]))
    scores = walkforward.replay(engine, start, end, version, log=log)
    engine.backtest_scores = scores                             # reused by the weekly allocator
    out = {
        "aggregate": score.aggregate(scores), "by_symbol": score.by_symbol(scores),
        "label": "Backtest (not live)",
        "note": ("The same code replayed over past sessions using only data available on each day. "
                 "Caveats: today's Nifty 50 members only (survivorship bias); plan outcomes use daily "
                 "bars with conservative fills; prices are adjusted for later corporate actions."),
        "from": start.isoformat(), "to": end.isoformat(),
    }
    publish.write_json(config.DATA_DIR / "backtest.json", out)

    live_days = {s["for_date"] for s in load_scores().values()}
    days = sorted({s["for_date"] for s in scores})[-pub["archive_backtest_days"]:]
    for day in days:
        if day not in live_days:
            publish.write_day(day, [s for s in scores if s["for_date"] == day], "backtest", version)
    return out["aggregate"]


def quality_report(engine: Engine) -> dict:
    """Data-quality summary: source agreement, repairs and flags (derived, safe to publish)."""
    eod = store.load_nse_eod()
    reports = []
    for sym in engine.states:
        rows = eod[eod["symbol"] == sym] if len(eod) else None
        reports.append(validate.cross_check(sym, store.load_yahoo_daily(sym), store.load_events(sym), rows))
    summary = validate.summarise(reports)
    kinds: dict[str, int] = {}
    for items in engine.ds.issues.values():
        for it in items:
            kinds[it["issue"]] = kinds.get(it["issue"], 0) + 1
    out = {**publish.stamp(engine.mcfg["model_version"]),
           "sessions_archived": len(store.open_days()),
           "first_session": store.open_days()[0].isoformat() if store.open_days() else None,
           "last_session": engine.last_session.isoformat(),
           "cross_check": {k: v for k, v in summary.items() if k != "worst"},
           "largest_disagreements": summary["worst"][:10],
           "repairs": kinds,
           "notable": {sym: [it for it in items if it["issue"] in
                             ("estimated_corporate_action", "vendor_adjustment_artefact")]
                       for sym, items in engine.ds.issues.items()
                       if any(it["issue"] in ("estimated_corporate_action", "vendor_adjustment_artefact")
                              for it in items)}}
    publish.write_json(config.DATA_DIR / "quality.json", out, indent=1)
    return out


def issue_portfolio(engine: Engine, for_date: date) -> int:
    """Paper-portfolio orders for today's session, written before the open like the plans.
    The weekly allocator's choices are added as a separate shadow book when it has been trained."""
    from . import allocator, portfolio
    if config.now_ist().time() >= MARKET_OPEN:
        return 0
    version = engine.mcfg["model_version"]
    extra = {}
    try:
        records = [r for r in ledger.load(for_date, for_date) if r["for_date"] == for_date.isoformat() and r["model_version"] == version]
        shadow = allocator.shadow_orders(records, portfolio.cfg())
        if shadow is not None:
            extra["allocator"] = shadow
    except Exception as exc:                            # noqa: BLE001 - the shadow book must never block the main one
        log(f"allocator shadow skipped: {type(exc).__name__}: {exc}")
    n = portfolio.issue(for_date, version, extra)
    log(f"portfolio: {n} order book(s) written for {for_date}")
    return n


def write_health(job: str, status: dict) -> dict:
    """data/health.json: when each job last finished, what each source returned, and when the
    vault token expires (the workflow passes VAULT_TOKEN_EXPIRES). Read by people and monitors."""
    path = config.DATA_DIR / "health.json"
    try:
        old = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    except ValueError:
        old = {}
    meta_path = config.DATA_DIR / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
    now = config.now_ist().isoformat(timespec="seconds")
    jobs_ = {**(old.get("jobs") or {}), job: {"last_finished": now}}
    expires = os.environ.get("VAULT_TOKEN_EXPIRES") or (old.get("vault_token") or {}).get("expires")
    out = {"schema": 1, "generated_at": now, "jobs": jobs_,
           "sources": {k: (v if isinstance(v, (str, int, float)) else "ok" if v else "unavailable")
                       for k, v in (status.get("sources") or {}).items()},
           "last_eod_date": meta.get("last_eod_date"), "plan_for_date": meta.get("plan_for_date"),
           "plan_status": meta.get("plan_status"), "pipeline_status": meta.get("pipeline_status"),
           "vault_token": {"expires": expires},
           "runner": "github-actions" if os.environ.get("GITHUB_ACTIONS") == "true" else "local"}
    publish.write_json(path, out, indent=1)
    return out


def safe(step, *args, default=None, what: str = ""):
    """Run a fetch step; a network failure is reported, not fatal."""
    try:
        return step(*args), None
    except (FetchError, OSError) as exc:
        log(f"{what or step.__name__} failed: {exc}")
        return default, str(exc)
