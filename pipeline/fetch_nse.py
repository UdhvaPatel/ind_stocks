"""Official NSE end-of-day files (free, no key).

Three files are used:
  * sec_bhavdata_full  : OHLC, previous close, volume, turnover, trades, delivery %
  * ind_close_all      : every index with OHLC, P/E, P/B, dividend yield
  * constituent lists  : Nifty 50 / Next 50 members with industry and ISIN

Important quirk (measured): on a market holiday the sec_bhavdata_full URL still
answers 200 but serves the PREVIOUS session's rows, so the date inside the file
is always checked against the date asked for.
"""
from __future__ import annotations

import io
from datetime import date

import pandas as pd

from .http import FormatError, Http

BASE = "https://nsearchives.nseindia.com"

SEC_COLS = {
    "SYMBOL": "symbol", "SERIES": "series", "DATE1": "date",
    "PREV_CLOSE": "prev_close", "OPEN_PRICE": "open", "HIGH_PRICE": "high",
    "LOW_PRICE": "low", "LAST_PRICE": "last", "CLOSE_PRICE": "close",
    "AVG_PRICE": "vwap", "TTL_TRD_QNTY": "volume", "TURNOVER_LACS": "turnover_lacs",
    "NO_OF_TRADES": "trades", "DELIV_QTY": "deliv_qty", "DELIV_PER": "deliv_pct",
}
IDX_COLS = {
    "Index Name": "index", "Index Date": "date", "Open Index Value": "open",
    "High Index Value": "high", "Low Index Value": "low", "Closing Index Value": "close",
    "Points Change": "change", "Change(%)": "change_pct", "Volume": "volume",
    "Turnover (Rs. Cr.)": "turnover_cr", "P/E": "pe", "P/B": "pb", "Div Yield": "div_yield",
}


def sec_bhav_url(d: date) -> str:
    return f"{BASE}/products/content/sec_bhavdata_full_{d:%d%m%Y}.csv"


def index_close_url(d: date) -> str:
    return f"{BASE}/content/indices/ind_close_all_{d:%d%m%Y}.csv"


def list_url(file_name: str) -> str:
    return f"{BASE}/content/indices/{file_name}"


def _looks_like_csv(text: str, must_contain: str) -> bool:
    head = text[:400].lstrip("﻿ \r\n")
    return bool(head) and not head.startswith("<") and must_contain in head


def parse_sec_bhav(text: str) -> pd.DataFrame:
    """Parse sec_bhavdata_full into a tidy frame (all series, all symbols)."""
    df = pd.read_csv(io.StringIO(text), skipinitialspace=True, na_values=["-", ""])
    df.columns = [c.strip() for c in df.columns]
    missing = [c for c in SEC_COLS if c not in df.columns]
    if missing:
        raise FormatError(f"NSE stock file is missing columns {missing}; the format may have changed")
    df = df.rename(columns=SEC_COLS)[list(SEC_COLS.values())]
    for col in ("symbol", "series"):
        df[col] = df[col].astype(str).str.strip()
    df["date"] = pd.to_datetime(df["date"].astype(str).str.strip(), format="%d-%b-%Y").dt.date
    num = [c for c in df.columns if c not in ("symbol", "series", "date")]
    df[num] = df[num].apply(pd.to_numeric, errors="coerce")
    df["turnover"] = (df["turnover_lacs"] * 1e5).round(0)   # rupees
    return df.drop(columns=["turnover_lacs"])


def parse_index_close(text: str) -> pd.DataFrame:
    df = pd.read_csv(io.StringIO(text), skipinitialspace=True, na_values=["-", ""])
    df.columns = [c.strip() for c in df.columns]
    keep = {k: v for k, v in IDX_COLS.items() if k in df.columns}
    df = df.rename(columns=keep)[list(keep.values())]
    df["index"] = df["index"].astype(str).str.strip()
    df["date"] = pd.to_datetime(df["date"].astype(str).str.strip(), format="%d-%m-%Y").dt.date
    num = [c for c in df.columns if c not in ("index", "date")]
    df[num] = df[num].apply(pd.to_numeric, errors="coerce")
    for col in IDX_COLS.values():                        # older files lack some columns
        if col not in df.columns:
            df[col] = float("nan")
    return df[list(IDX_COLS.values())]


def fetch_sec_bhav(http: Http, d: date) -> pd.DataFrame | None:
    """Official stock file for one day, or None if there was no session that day."""
    resp = http.get(sec_bhav_url(d))
    if resp is None or not _looks_like_csv(resp.text, "SYMBOL"):
        return None
    df = parse_sec_bhav(resp.text)
    if df.empty or df["date"].iloc[0] != d:              # stale file served on a holiday
        return None
    return df


def fetch_index_close(http: Http, d: date) -> pd.DataFrame | None:
    resp = http.get(index_close_url(d))
    if resp is None or not _looks_like_csv(resp.text, "Index Name"):
        return None
    df = parse_index_close(resp.text)
    if df.empty or df["date"].iloc[0] != d:
        return None
    return df


def fetch_constituents(http: Http, file_name: str) -> pd.DataFrame:
    resp = http.get(list_url(file_name))
    if resp is None or not _looks_like_csv(resp.text, "Symbol"):
        raise RuntimeError(f"constituent list {file_name} is unavailable")
    df = pd.read_csv(io.StringIO(resp.text), skipinitialspace=True)
    df.columns = [c.strip() for c in df.columns]
    df = df.rename(columns={"Company Name": "name", "Industry": "industry",
                            "Symbol": "symbol", "Series": "series", "ISIN Code": "isin"})
    for col in df.columns:
        df[col] = df[col].astype(str).str.strip()
    return df[["symbol", "name", "industry", "series", "isin"]]
