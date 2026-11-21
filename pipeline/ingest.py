"""Ingest steps shared by the backfill and the daily jobs."""
from __future__ import annotations

from datetime import date, timedelta

import pandas as pd

from . import config, fetch_nse, fetch_yahoo, store
from .http import FetchError, FormatError, Http


def breadth_row(d: date, sec: pd.DataFrame) -> dict:
    eq = sec[sec["series"] == "EQ"]
    chg = eq["close"] - eq["prev_close"]
    return {"date": d, "advances": int((chg > 0).sum()), "declines": int((chg < 0).sum()),
            "unchanged": int((chg == 0).sum()), "stocks": int(len(eq)),
            "turnover": float(eq["turnover"].sum())}


def listed_holidays() -> set[date]:
    out = set()
    for item in (config.load_yaml("holidays.yaml").get("holidays") or []):
        raw = item.get("date") if isinstance(item, dict) else item
        try:
            out.add(raw if isinstance(raw, date) else date.fromisoformat(str(raw)))
        except ValueError:
            continue
    return out


def check_day(d: date, keep: pd.DataFrame, expected: set[str]) -> None:
    """Refuse to archive a partial or broken official file (it would never be fetched again)."""
    have = set(keep["symbol"])
    if expected and len(have & expected) < 0.9 * len(expected):
        raise FormatError(f"{d}: official file has only {len(have & expected)} of {len(expected)} tracked stocks")
    ok = keep.dropna(subset=["open", "high", "low", "close"])
    bad = ok[(ok["low"] > ok[["open", "close"]].min(axis=1) + 1e-9) | (ok["high"] < ok[["open", "close"]].max(axis=1) - 1e-9)
             | (ok["close"] <= 0)]
    if len(bad) > 0.05 * max(len(ok), 1):
        raise FormatError(f"{d}: {len(bad)} rows have impossible prices (low above open/close or high below)")


def ingest_nse_day(http: Http, d: date, expected: set[str] | None = None) -> str:
    """Fetch and archive one session. Returns 'saved', 'exists', 'closed', 'missing' or 'pending'.

    'closed'  : no session that day: a listed holiday (holidays.yaml)
    'missing' : no file, but nothing proves there was no session (maintenance, outage):
                left open and retried; `confirm_closed_days` settles it from later data
    'pending' : today's file is simply not published yet
    """
    if store.has_nse_day(d):
        return "exists"
    sec = fetch_nse.fetch_sec_bhav(http, d)
    if sec is None:
        if d >= config.today_ist() - timedelta(days=1):
            return "pending"
        return "closed" if d in listed_holidays() else "missing"
    idx = fetch_nse.fetch_index_close(http, d)
    tracked = set(store.tracked_symbols())
    keep = sec[(sec["series"] == "EQ") & (sec["symbol"].isin(tracked))]
    check_day(d, keep, expected or set())
    store.save_nse_day(d, keep.sort_values("symbol"), idx)
    store.upsert_breadth([breadth_row(d, sec)])
    return "saved"


def confirm_closed_days(candidates: list[date]) -> list[date]:
    """A missing weekday was a holiday only if the next archived session's official
    'previous close' equals the last archived close for most stocks (nothing traded between)."""
    if not candidates:
        return []
    eod = store.load_nse_eod(min(candidates) - timedelta(days=10))
    if eod.empty:
        return []
    days = sorted(set(eod["date"]))
    out = []
    for d in candidates:
        before = [x for x in days if x < d]
        after = [x for x in days if x > d]
        if not before or not after:
            continue
        a = eod[eod["date"] == before[-1]].set_index("symbol")["close"]
        b = eod[eod["date"] == after[0]].set_index("symbol")["prev_close"]
        both = a.index.intersection(b.index)
        if len(both) >= 10 and ((a[both] - b[both]).abs() <= 0.011 * a[both].abs()).mean() >= 0.9:
            out.append(d)
    return out


def backfill_nse(http: Http, start: date, end: date, log=print) -> dict:
    """Archive every session in [start, end] that is not already in the vault."""
    known_closed = store.closed_days()
    counts = {"saved": 0, "exists": 0, "closed": 0, "pending": 0, "error": 0, "missing": 0}
    newly_closed, missing, d = [], [], start
    try:
        from . import universe
        expected = set(universe.plan_symbols())
    except Exception:                                   # noqa: BLE001 - no universe yet (first backfill)
        expected = set()
    while d <= end:
        if d.weekday() >= 5 and not store.has_nse_day(d):
            # Weekend sessions are rare (Muhurat, special Saturdays): probe only
            # dates listed as special sessions in the config.
            special = {str(s["date"] if isinstance(s, dict) else s)
                       for s in config.load_yaml("holidays.yaml").get("special_sessions") or []}
            if d.isoformat() not in special:
                d += timedelta(days=1)
                continue
        if d in known_closed:
            counts["closed"] += 1
        else:
            try:
                status = ingest_nse_day(http, d, expected)
            except FetchError as exc:
                status = "error"
                log(f"  {d} error: {exc}")
            counts[status] += 1
            if status == "closed":
                newly_closed.append(d)
            if status == "missing":
                missing.append(d)
            if status == "saved" and counts["saved"] % 50 == 0:
                log(f"  archived {counts['saved']} sessions, now at {d}")
        d += timedelta(days=1)
    confirmed = confirm_closed_days(missing)
    if missing:
        log(f"  no file for {[x.isoformat() for x in missing]}; confirmed as no-session days: {[x.isoformat() for x in confirmed]}")
    store.add_closed_days(newly_closed + confirmed)
    return counts


def refresh_yahoo_daily(http: Http, symbols: dict[str, str], years: int = 10, log=print) -> dict:
    """Download daily history for {key: yahoo_symbol}. Returns {key: 'ok' | error text}."""
    status = {}
    for key, ysym in symbols.items():
        try:
            df, events = fetch_yahoo.fetch_daily(http, ysym, years)
            if len(df) < 30:
                raise FetchError(f"only {len(df)} rows")
            old = store.load_yahoo_daily(key)
            if old is not None and len(old) and (len(df) < 0.9 * len(old) or df.index.max() < old.index.max()):
                # A short or stale reply would overwrite years of good history: keep what we have.
                raise FormatError(f"reply has {len(df)} rows to {df.index.max()}, cache has {len(old)} to {old.index.max()}")
            store.save_yahoo_daily(key, df)
            store.save_events(key, events)
            status[key] = "ok"
        except (FetchError, ValueError, KeyError) as exc:
            status[key] = f"failed: {exc}"
            log(f"  yahoo {key}: {status[key]}")
    return status


def all_yahoo_symbols(stock_symbols: list[str]) -> dict[str, str]:
    cfg = config.universe_cfg()
    out = {s: fetch_yahoo.yahoo_symbol(s) for s in stock_symbols}
    out.update({k: v["yahoo"] for k, v in cfg["indices"].items()})
    out.update({k: v["yahoo"] for k, v in cfg["overnight"].items()})
    return out


def find_missing_sessions(http: Http, log=print) -> list[date]:
    """Find and archive sessions the weekday scan missed (Muhurat, special weekend sessions).

    Detection uses the official data itself: if most stocks' "previous close"
    on day D differs from their close on the last archived session, a session
    happened in between. Every calendar day in that hole is then probed.
    """
    eod = store.load_nse_eod()
    if not len(eod):
        return []
    close = eod.pivot_table(index="date", columns="symbol", values="close")
    prev = eod.pivot_table(index="date", columns="symbol", values="prev_close")
    mismatch = ((close.shift(1) / prev - 1).abs() > 0.001).sum(axis=1) / prev.notna().sum(axis=1)
    days = list(close.index)
    found = []
    for d in mismatch.index[mismatch > 0.5]:
        probe = days[days.index(d) - 1] + timedelta(days=1)
        while probe < d:
            if not store.has_nse_day(probe) and ingest_nse_day(http, probe) == "saved":
                found.append(probe)
                log(f"  recovered missing session {probe} ({probe:%A})")
            probe += timedelta(days=1)
    if found:
        store.add_closed_days([])            # keep the file present
        closed = store.closed_days() - set(found)
        store._write_json(store.vault() / "nse" / "closed_days.json",
                          sorted(x.isoformat() for x in closed))
    return found
