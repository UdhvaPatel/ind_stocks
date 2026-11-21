"""Load everything the analysis needs from the vault into clean frames."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

import pandas as pd

from . import clean, config, store


@dataclass
class Dataset:
    frames: dict[str, pd.DataFrame]                 # stock symbol -> clean daily frame
    indices: dict[str, pd.DataFrame]                # NIFTY50, BANKNIFTY, SENSEX, INDIAVIX
    overnight: dict[str, pd.DataFrame]              # SP500, NASDAQ, ...
    breadth: pd.DataFrame
    valuation: pd.DataFrame                         # Nifty 50 P/E, P/B, yield by date
    issues: dict[str, list] = field(default_factory=dict)
    last_session: date | None = None                # latest official NSE session

    @property
    def nifty(self) -> pd.Series:
        return self.indices["NIFTY50"]["close"] if "NIFTY50" in self.indices else pd.Series(dtype=float)

    @property
    def vix(self) -> pd.Series:
        return self.indices["INDIAVIX"]["close"] if "INDIAVIX" in self.indices else pd.Series(dtype=float)

    def truncated(self, as_of: date, next_day: date | None = None) -> "Dataset":
        """The dataset as known when planning the session after `as_of`.

        Indian data stops at the close of `as_of`. Overnight markets keep
        everything dated before `next_day`: US sessions close after the Indian
        close of the same date, and are complete by 06:00 IST the next morning.
        """
        cut = lambda df: df[df.index <= as_of]
        if next_day is None:
            cut_overnight = cut
        else:
            cut_overnight = lambda df: df[df.index < next_day]
        return Dataset(
            frames={k: cut(v) for k, v in self.frames.items()},
            indices={k: cut(v) for k, v in self.indices.items()},
            overnight={k: cut_overnight(v) for k, v in self.overnight.items()},
            breadth=self.breadth[self.breadth["date"] <= as_of],
            valuation=cut(self.valuation),
            issues=self.issues,
            last_session=as_of,
        )


def finished_only(df: pd.DataFrame | None) -> pd.DataFrame | None:
    """Drop vendor bars for an Indian session that is still running (or dated in the future).

    During market hours Yahoo already lists today's bar, built from the trades so far.
    Treating it as a closed session would plan and score against a half-made day.
    """
    if df is None or not len(df):
        return df
    return df[df.index <= config.last_finished_session_day()]


def _index_frame(key: str, nse_name: str | None, idx_all: pd.DataFrame) -> pd.DataFrame | None:
    """Yahoo index history, with official NSE closes overriding where available."""
    ydf = finished_only(store.load_yahoo_daily(key))
    cols = ["open", "high", "low", "close"]
    if nse_name and len(idx_all):
        off = idx_all[idx_all["index"] == nse_name].drop_duplicates("date", keep="last")
        off = off.set_index("date")[cols].dropna(subset=["close"])
        if ydf is None:
            return off.sort_index()
        out = ydf[cols].reindex(ydf.index.union(off.index))
        out.loc[off.index, cols] = off[cols]
        return out.dropna(subset=["close"]).sort_index()
    return None if ydf is None else ydf[cols].dropna(subset=["close"])


def load_dataset(symbols: list[str]) -> Dataset:
    cfg = config.universe_cfg()
    eod = store.load_nse_eod()
    idx_all = store.load_idx()
    by_symbol = {s: g for s, g in eod.groupby("symbol")} if len(eod) else {}

    frames, issues = {}, {}
    for sym in symbols:
        frame, iss = clean.build_symbol_frame(
            finished_only(store.load_yahoo_daily(sym)), store.load_events(sym), by_symbol.get(sym))
        if len(frame):
            frames[sym] = frame
        if iss:
            issues[sym] = iss

    indices = {}
    for key, meta in cfg["indices"].items():
        df = _index_frame(key, meta.get("nse"), idx_all)
        if df is not None and len(df):
            indices[key] = df
    overnight = {}
    for key in cfg["overnight"]:
        df = store.load_yahoo_daily(key)
        if df is not None and len(df):
            overnight[key] = df[["open", "high", "low", "close"]].dropna(subset=["close"])

    valuation = pd.DataFrame(columns=["pe", "pb", "div_yield"])
    if len(idx_all):
        nifty_name = cfg["indices"]["NIFTY50"]["nse"]
        val = idx_all[idx_all["index"] == nifty_name].drop_duplicates("date", keep="last")
        valuation = val.set_index("date")[["pe", "pb", "div_yield"]].sort_index()

    days = store.open_days()
    return Dataset(frames=frames, indices=indices, overnight=overnight,
                   breadth=store.load_breadth(), valuation=valuation, issues=issues,
                   last_session=days[-1] if days else None)
