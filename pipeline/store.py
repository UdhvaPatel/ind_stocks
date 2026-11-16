"""Vault storage: raw vendor data that must stay out of the public repository.

Layout (all under VAULT_DIR):
  nse/eod/YYYY/YYYY-MM-DD.csv     official rows for tracked symbols, one file per session
  nse/idx/YYYY/YYYY-MM-DD.csv     official index closes, one file per session
  nse/breadth.csv                 advances / declines over every EQ-series stock
  nse/closed_days.json            weekdays confirmed to have had no session
  nse/tracked.json                symbols archived (Nifty 50 + Next 50)
  bars5m/YYYY/YYYY-MM-DD.csv.gz   5-minute bars of the plan universe, one file per session
  events/{SYMBOL}.json            split and dividend events (small, committed)
  cache/                          re-downloadable Yahoo history (git-ignored)
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pandas as pd

from . import config


def vault() -> Path:
    root = Path(config.VAULT_DIR)
    root.mkdir(parents=True, exist_ok=True)
    ignore = root / ".gitignore"
    if not ignore.exists():
        ignore.write_text("cache/\n", encoding="utf-8")
    return root


def _write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=1, sort_keys=True) + "\n", encoding="utf-8")


def _read_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def safe_name(symbol: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in symbol)


# ---------------------------------------------------------------- NSE sessions
def nse_day_path(d: date) -> Path:
    return vault() / "nse" / "eod" / f"{d:%Y}" / f"{d:%Y-%m-%d}.csv"


def idx_day_path(d: date) -> Path:
    return vault() / "nse" / "idx" / f"{d:%Y}" / f"{d:%Y-%m-%d}.csv"


def has_nse_day(d: date) -> bool:
    return nse_day_path(d).exists()


def save_nse_day(d: date, sec: pd.DataFrame, idx: pd.DataFrame | None) -> None:
    path = nse_day_path(d)
    path.parent.mkdir(parents=True, exist_ok=True)
    sec.to_csv(path, index=False, lineterminator="\n")
    if idx is not None:
        ipath = idx_day_path(d)
        ipath.parent.mkdir(parents=True, exist_ok=True)
        idx.to_csv(ipath, index=False, lineterminator="\n")


def open_days() -> list[date]:
    root = vault() / "nse" / "eod"
    return sorted(date.fromisoformat(p.stem) for p in root.glob("*/*.csv"))


def closed_days() -> set[date]:
    return {date.fromisoformat(s) for s in _read_json(vault() / "nse" / "closed_days.json", [])}


def add_closed_days(days) -> None:
    merged = closed_days() | set(days)
    _write_json(vault() / "nse" / "closed_days.json", sorted(d.isoformat() for d in merged))


def _load_days(kind: str, start: date | None) -> pd.DataFrame:
    root = vault() / "nse" / kind
    files = sorted(p for p in root.glob("*/*.csv")
                   if start is None or date.fromisoformat(p.stem) >= start)
    if not files:
        return pd.DataFrame()
    df = pd.concat((pd.read_csv(p) for p in files), ignore_index=True)
    df["date"] = pd.to_datetime(df["date"]).dt.date
    return df


def load_nse_eod(start: date | None = None) -> pd.DataFrame:
    """Every archived official stock row from `start` onward."""
    return _load_days("eod", start)


def load_idx(start: date | None = None) -> pd.DataFrame:
    return _load_days("idx", start)


# --------------------------------------------------------------------- breadth
def breadth_path() -> Path:
    return vault() / "nse" / "breadth.csv"


def load_breadth() -> pd.DataFrame:
    path = breadth_path()
    if not path.exists():
        return pd.DataFrame(columns=["date", "advances", "declines", "unchanged", "stocks", "turnover"])
    df = pd.read_csv(path)
    df["date"] = pd.to_datetime(df["date"]).dt.date
    return df


def upsert_breadth(rows: list[dict]) -> None:
    if not rows:
        return
    old, new = load_breadth(), pd.DataFrame(rows)
    df = pd.concat([old, new], ignore_index=True) if len(old) else new
    df = df.drop_duplicates("date", keep="last").sort_values("date")
    breadth_path().parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(breadth_path(), index=False, lineterminator="\n")


# ------------------------------------------------------------- tracked symbols
def tracked_symbols() -> list[str]:
    return _read_json(vault() / "nse" / "tracked.json", [])


def save_tracked_symbols(symbols) -> None:
    merged = sorted(set(tracked_symbols()) | set(symbols))   # never drop history
    _write_json(vault() / "nse" / "tracked.json", merged)


# ------------------------------------------------------------- Yahoo and events
def yahoo_cache_path(symbol: str) -> Path:
    return vault() / "cache" / "yahoo" / "daily" / f"{safe_name(symbol)}.csv"


def save_yahoo_daily(symbol: str, df: pd.DataFrame) -> None:
    path = yahoo_cache_path(symbol)
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, lineterminator="\n")


def load_yahoo_daily(symbol: str) -> pd.DataFrame | None:
    path = yahoo_cache_path(symbol)
    if not path.exists():
        return None
    df = pd.read_csv(path)
    df["date"] = pd.to_datetime(df["date"]).dt.date
    return df.set_index("date").sort_index()


def events_path(symbol: str) -> Path:
    return vault() / "events" / f"{safe_name(symbol)}.json"


def save_events(symbol: str, events: dict) -> None:
    if _read_json(events_path(symbol), None) != events:      # avoid needless commits
        _write_json(events_path(symbol), events)


def load_events(symbol: str) -> dict:
    return _read_json(events_path(symbol), {"splits": [], "dividends": []})


# ---------------------------------------------------------------- 5-minute bars
def bars5m_path(d: date) -> Path:
    return vault() / "bars5m" / f"{d:%Y}" / f"{d:%Y-%m-%d}.csv.gz"


def save_bars5m(d: date, df: pd.DataFrame) -> None:
    path = bars5m_path(d)
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index=False, lineterminator="\n", compression="gzip")


def load_bars5m(d: date) -> pd.DataFrame | None:
    path = bars5m_path(d)
    if not path.exists():
        return None
    df = pd.read_csv(path)
    df["ts"] = pd.to_datetime(df["ts"])
    return df


def bars5m_days() -> list[date]:
    root = vault() / "bars5m"
    return sorted(date.fromisoformat(p.name[:10]) for p in root.glob("*/*.csv.gz"))
