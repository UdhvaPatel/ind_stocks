"""Turn raw vendor rows into one clean, split-adjusted daily frame per symbol.

Price basis used everywhere in the analysis:
  open/high/low/close : split-adjusted (comparable across splits and bonuses),
                        NOT dividend-adjusted, so they match prices a user sees
  adjclose            : additionally dividend-adjusted (used only for long returns)
Official NSE prices are unadjusted; `split_factor` converts between the two:
  unadjusted = adjusted * factor      (factor = product of later split ratios)
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date

import numpy as np
import pandas as pd

PRICE_COLS = ["open", "high", "low", "close"]


def split_factor(dates, splits: list[dict]) -> pd.Series:
    """For each date, the product of ratios of all splits that happen AFTER it."""
    idx = pd.Index(list(dates))
    factor = pd.Series(1.0, index=idx)
    for ev in splits or []:
        ex = date.fromisoformat(ev["date"]) if isinstance(ev["date"], str) else ev["date"]
        ratio = float(ev.get("ratio") or 1.0)
        if ratio > 0 and ratio != 1.0:
            factor[idx < ex] *= ratio
    return factor


@dataclass
class Adjustment:
    """Measured price adjustment for the official (unadjusted) rows of one symbol."""
    factor: pd.Series            # true factor per official date: adjusted = official / factor
    vendor_factor: pd.Series     # official / vendor step level per date (vendor's own basis)
    bad_prints: list             # dates where the vendor close is a one-day outlier
    artefacts: list              # vendor steps that no official price move supports
    pre_scale: float = 1.0       # multiply vendor-only (older) prices by this


def empirical_factor(nse: pd.DataFrame, yahoo_close: pd.Series, tol: float = 0.004) -> Adjustment:
    """Adjustment factor measured from the two sources.

    `nse` is indexed by date with official `open` and `close`.

    Yahoo's event list misses bonuses and demergers (measured: Bajaj Finance,
    ITC, Reliance), but its prices are adjusted for them, so official close /
    Yahoo close is a step function whose steps mark corporate actions. Two
    protections are applied:
      * a one-day deviation from the current step is a bad vendor print;
      * a step is only believed if the OFFICIAL overnight move on that date
        becomes smaller once the step is applied. A step with no matching
        official discontinuity is a vendor artefact (measured: Trent, where
        Yahoo applied a bonus adjustment to only part of the history).
    The true factor is rebuilt backward from the latest session using believed
    steps only, and older vendor-only history is rescaled to join it.
    """
    nse = nse.sort_index()
    ones = pd.Series(1.0, index=nse.index)
    both = nse.index.intersection(yahoo_close.index)
    if not len(both):
        return Adjustment(ones, ones.copy(), [], [])
    dates = list(both.sort_values())
    r = (nse["close"].loc[dates] / yahoo_close.loc[dates]).values
    seg = np.zeros(len(r), dtype=int)
    outlier = np.zeros(len(r), dtype=bool)
    level, cur = r[0], 0
    for i in range(1, len(r)):
        if abs(r[i] / level - 1) > tol:
            if i + 1 < len(r):
                persists = abs(r[i + 1] / r[i] - 1) < abs(r[i + 1] / level - 1)
            else:                      # last day: Yahoo re-adjusts history, so today reads 1.0
                persists = abs(r[i] - 1) < 0.0015 and abs(level - 1) > 0.0015
            if persists:
                cur += 1
                level = r[i]
            else:
                outlier[i] = True
        seg[i] = cur
    levels = []
    for s in range(cur + 1):
        m = (seg == s) & ~outlier
        med = float(np.median(r[m])) if m.any() else 1.0
        levels.append(1.0 if abs(med - 1) < 0.0015 else med)
    vendor = np.array([levels[s] for s in seg])

    # Rebuild the true factor backward, believing a step only if it shrinks the
    # official overnight move (previous close to open) on the step date.
    true_levels = [0.0] * (cur + 1)
    true_levels[cur] = levels[cur] if cur == 0 else 1.0 if abs(levels[cur] - 1) < 0.0015 else levels[cur]
    artefacts = []
    closes = nse["close"]
    opens = nse["open"] if "open" in nse.columns else closes
    for s in range(cur, 0, -1):
        first = int(np.argmax(seg == s))                       # first row of segment s
        d, prev = dates[first], dates[first - 1]
        raw = float(opens.loc[d] / closes.loc[prev])
        step = levels[s - 1] / levels[s]                       # how much larger prices were before
        genuine = abs(np.log(raw * step)) < abs(np.log(raw))
        true_levels[s - 1] = true_levels[s] * step if genuine else true_levels[s]
        if not genuine:
            artefacts.append(d)
    true = np.array([true_levels[s] for s in seg])

    idx = pd.Index(dates)
    factor = pd.Series(true, index=idx).reindex(nse.index).ffill().bfill()
    vendor_factor = pd.Series(vendor, index=idx).reindex(nse.index).ffill().bfill()
    return Adjustment(factor, vendor_factor,
                      [d for d, bad in zip(dates, outlier) if bad], artefacts,
                      pre_scale=levels[0] / true_levels[0])


def clean_bars(df: pd.DataFrame) -> tuple[pd.DataFrame, list[dict]]:
    """Drop impossible bars and report what was dropped or repaired."""
    issues: list[dict] = []
    df = df.copy()
    df[PRICE_COLS] = df[PRICE_COLS].astype(float)
    bad_price = (df[PRICE_COLS] <= 0).any(axis=1) | df[PRICE_COLS].isna().any(axis=1)
    for d in df.index[bad_price]:
        issues.append({"date": str(d), "issue": "missing_or_nonpositive_price", "action": "dropped"})
    df = df[~bad_price]

    # Repair inconsistent bars (high below open/close, low above them) instead of dropping.
    hi = df[["open", "close", "high"]].max(axis=1)
    lo = df[["open", "close", "low"]].min(axis=1)
    broken = (df["high"] < hi - 1e-9) | (df["low"] > lo + 1e-9)
    for d in df.index[broken]:
        issues.append({"date": str(d), "issue": "high_low_inconsistent", "action": "repaired"})
    df.loc[broken, "high"] = hi[broken]
    df.loc[broken, "low"] = lo[broken]

    # A flat bar with zero volume is a non-session leaking through (holiday echo).
    flat = (df["volume"] <= 0) & (df["high"] == df["low"])
    for d in df.index[flat]:
        issues.append({"date": str(d), "issue": "flat_zero_volume_bar", "action": "dropped"})
    return df[~flat], issues


def build_symbol_frame(yahoo: pd.DataFrame | None, events: dict,
                       nse: pd.DataFrame | None) -> tuple[pd.DataFrame, list[dict]]:
    """Merge Yahoo history with official NSE rows for one symbol.

    Returns (frame indexed by date, issues). Columns:
      open high low close adjclose volume factor
      nse_close (unadjusted official close), nse_close_adj (same, split-adjusted),
      prev_close_adj, vwap, turnover, trades, deliv_qty, deliv_pct, source
    Official NSE values win wherever both sources have the session, because the
    official file is what predictions are scored against.
    """
    splits = (events or {}).get("splits", [])
    issues: list[dict] = []

    if yahoo is not None and len(yahoo):
        base, issues = clean_bars(yahoo[PRICE_COLS + ["adjclose", "volume"]])
        base["volume"] = base["volume"].astype(float)
        base["source"] = "yahoo"
    else:
        base = pd.DataFrame({c: pd.Series(dtype=float) for c in PRICE_COLS + ["adjclose", "volume"]})
        base["source"] = pd.Series(dtype=object)

    if nse is not None and len(nse):
        n = nse.drop_duplicates("date", keep="last").set_index("date").sort_index()
        if yahoo is not None and len(yahoo):
            adjm = empirical_factor(n, yahoo["close"])
            f = adjm.factor
            issues += [{"date": str(d), "issue": "vendor_bad_print", "action": "official price used"}
                       for d in adjm.bad_prints]
            issues += [{"date": str(d), "issue": "vendor_adjustment_artefact", "action": "step ignored"}
                       for d in adjm.artefacts]
            # Vendor rows are in the vendor's own basis; move them onto the true basis.
            scale = (adjm.vendor_factor / adjm.factor)
            scale = scale.reindex(base.index.union(scale.index)).ffill().bfill().reindex(base.index)
            if len(scale) and (scale - 1).abs().max() > 1e-9:
                base[PRICE_COLS + ["adjclose"]] = base[PRICE_COLS + ["adjclose"]].mul(scale, axis=0)
                base["volume"] = base["volume"] / scale
        else:
            f = split_factor(n.index, splits)
        adj = pd.DataFrame(index=n.index)
        for col in PRICE_COLS:
            adj[col] = n[col] / f
        adj["volume"] = n["volume"] * f
        adj["nse_close"] = n["close"]
        adj["nse_close_adj"] = n["close"] / f
        adj["prev_close_adj"] = n["prev_close"] / f
        adj["vwap"] = n["vwap"] / f
        for col in ("turnover", "trades", "deliv_qty", "deliv_pct"):
            adj[col] = n[col]
        adj["deliv_qty"] = adj["deliv_qty"] * f
        adj, nse_issues = clean_bars(adj)
        issues += nse_issues

        all_dates = base.index.union(adj.index)
        out = base.reindex(all_dates)
        both = out.index.isin(adj.index)
        # Dividend adjustment ratio comes from Yahoo; carry it onto official prices.
        ratio = (out["adjclose"] / out["close"]).ffill().fillna(1.0)
        for col in PRICE_COLS + ["volume"]:
            out.loc[both, col] = adj[col]
        out["adjclose"] = out["close"] * ratio
        out.loc[both, "source"] = np.where(out.loc[both, "source"].isna(), "nse", "nse+yahoo")
        for col in ("nse_close", "nse_close_adj", "prev_close_adj", "vwap",
                    "turnover", "trades", "deliv_qty", "deliv_pct"):
            out[col] = adj[col].reindex(all_dates)
    else:
        out = base.copy()
        for col in ("nse_close", "nse_close_adj", "prev_close_adj", "vwap",
                    "turnover", "trades", "deliv_qty", "deliv_pct"):
            out[col] = np.nan

    out["factor"] = split_factor(out.index, splits).values
    if nse is not None and len(nse):
        out.loc[f.index.intersection(out.index), "factor"] = f
    out.index.name = "date"
    out = out.sort_index()
    issues += repair_unadjusted_gaps(out)
    return out, issues


GAP_LIMIT = -0.25
_PRICE_LIKE = PRICE_COLS + ["adjclose", "nse_close_adj", "prev_close_adj", "vwap"]
_SHARE_LIKE = ["volume", "deliv_qty"]


def repair_unadjusted_gaps(out: pd.DataFrame) -> list[dict]:
    """Treat a remaining overnight drop of more than 25% as an unrecorded corporate action.

    After the measured adjustment, an overnight gap this large in a large-cap
    stock is a demerger or split that neither source adjusted (measured: the
    Tata Motors demerger of Oct 2025). Earlier prices are rescaled by the gap
    itself, which assumes no genuine overnight move, so the event is reported
    as "estimated" rather than hidden.
    """
    issues = []
    numeric = [c for c in _PRICE_LIKE + _SHARE_LIKE + ["factor"] if c in out.columns]
    out[numeric] = out[numeric].astype(float)
    for _ in range(10):
        gap = out["open"] / out["close"].shift(1) - 1
        hits = gap[gap < GAP_LIMIT]
        if not len(hits):
            break
        d = hits.index[-1]
        k = 1.0 + float(hits.iloc[-1])
        older = out.index < d
        cols = [c for c in _PRICE_LIKE if c in out.columns]
        out.loc[older, cols] = out.loc[older, cols] * k
        for c in _SHARE_LIKE:
            if c in out.columns:
                out.loc[older, c] = out.loc[older, c] / k
        out.loc[older, "factor"] = out.loc[older, "factor"] / k
        issues.append({"date": str(d), "issue": "estimated_corporate_action",
                       "action": f"earlier prices scaled by {k:.4f}"})
    return issues


def yahoo_unadjusted_close(yahoo: pd.DataFrame, events: dict) -> pd.Series:
    """Yahoo's close converted back to the price actually traded that day."""
    return yahoo["close"] * split_factor(yahoo.index, (events or {}).get("splits", []))
