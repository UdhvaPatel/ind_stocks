"""Yahoo Finance chart endpoint (unofficial, no key): daily history and 5-minute bars.

Prices from Yahoo are split-adjusted; `adjclose` is additionally dividend-adjusted.
Raw responses are never published (see PLAN.md 12.3); only derived analytics are.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import pandas as pd

from .http import FetchError, Http

BASE = "https://query1.finance.yahoo.com/v8/finance/chart/"
OHLCV = ["open", "high", "low", "close", "volume"]


def yahoo_symbol(nse_symbol: str) -> str:
    return f"{nse_symbol}.NS"


def _result(http: Http, symbol: str, params: dict) -> dict:
    resp = http.get(BASE + quote(symbol, safe=""), params=params)
    if resp is None:
        raise FetchError(f"Yahoo has no data for {symbol}")
    payload = resp.json().get("chart", {})
    if payload.get("error") or not payload.get("result"):
        raise FetchError(f"Yahoo error for {symbol}: {payload.get('error')}")
    return payload["result"][0]


def _frame(res: dict) -> pd.DataFrame:
    ts = res.get("timestamp") or []
    quote_ = res["indicators"]["quote"][0] if ts else {}
    df = pd.DataFrame({c: quote_.get(c, [None] * len(ts)) for c in OHLCV})
    offset = res["meta"].get("gmtoffset", 0)
    tz = timezone(timedelta(seconds=offset))
    df.insert(0, "ts", [datetime.fromtimestamp(t, tz).replace(tzinfo=None) for t in ts])
    adj = (res["indicators"].get("adjclose") or [{}])[0].get("adjclose")
    if adj:
        df["adjclose"] = adj
    return df


def parse_daily(res: dict) -> tuple[pd.DataFrame, dict]:
    """Return (daily frame indexed by local date, events dict)."""
    df = _frame(res)
    df["date"] = [t.date() for t in df["ts"]]
    df = df.drop(columns=["ts"]).dropna(subset=["close"])
    df = df.drop_duplicates("date", keep="last").set_index("date").sort_index()
    if "adjclose" not in df.columns:
        df["adjclose"] = df["close"]
    df["adjclose"] = df["adjclose"].fillna(df["close"])
    df["volume"] = df["volume"].fillna(0)

    offset = res["meta"].get("gmtoffset", 0)
    tz = timezone(timedelta(seconds=offset))
    events = {"splits": [], "dividends": []}
    raw = res.get("events") or {}
    for item in (raw.get("splits") or {}).values():
        den = item.get("denominator") or 1
        events["splits"].append({
            "date": datetime.fromtimestamp(item["date"], tz).date().isoformat(),
            "ratio": float(item.get("numerator", 1)) / float(den),
        })
    for item in (raw.get("dividends") or {}).values():
        events["dividends"].append({
            "date": datetime.fromtimestamp(item["date"], tz).date().isoformat(),
            "amount": float(item.get("amount", 0)),
        })
    events["splits"].sort(key=lambda e: e["date"])
    events["dividends"].sort(key=lambda e: e["date"])
    return df[["open", "high", "low", "close", "adjclose", "volume"]], events


def parse_intraday(res: dict) -> pd.DataFrame:
    df = _frame(res).dropna(subset=["close"])
    df = df.drop(columns=[c for c in ("adjclose",) if c in df.columns])
    df["volume"] = df["volume"].fillna(0)
    return df.drop_duplicates("ts", keep="last").sort_values("ts").reset_index(drop=True)


def fetch_daily(http: Http, symbol: str, years: int = 10) -> tuple[pd.DataFrame, dict]:
    rng = "max" if years > 10 else f"{years}y" if years in (1, 2, 5, 10) else "10y"
    res = _result(http, symbol, {"range": rng, "interval": "1d", "events": "div|split"})
    return parse_daily(res)


def fetch_5m(http: Http, symbol: str, days: int = 5) -> pd.DataFrame:
    """5-minute bars (local exchange time) for the last `days` sessions (1 or 5)."""
    res = _result(http, symbol, {"range": f"{days}d", "interval": "5m"})
    return parse_intraday(res)
