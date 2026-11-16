"""One-session conditional distributions (PLAN.md 5.9): scenarios, not prophecy.

For a stock at the close of session t, the forecast describes session t+1:
close-to-close return, opening gap, how high and how low the session trades.

Method, in plain words:
  1. Every past session's outcome is expressed in units of that day's ATR, so
     calm and wild periods become comparable (volatility scaling).
  2. "Analog days" are past days in the same stock that looked like today:
     same position in the 60-day range, same trend state, same volatility
     regime. If fewer than MIN_ANALOGS exist, the match is relaxed step by step.
  3. The overnight move of the S&P 500 (known before the Indian open) shifts the
     centre of the distribution through a regression fitted on past data only.
  4. Probabilities are shrunk toward the base rate so a small sample cannot
     produce an overconfident number.

Nothing here uses information from after the moment the forecast is made:
labels of session s+1 are only used when s+1 <= t.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

MIN_ANALOGS = 60
# Pseudo-observations pulling p(up) toward the base rate. Measured on 3 years x
# 50 stocks (37,450 forecasts): analog days carry no directional information
# (Brier skill -0.4% at weight 40, about 0 at 400), while the overnight US move
# does (53.6% hit rate). So direction leans on the base rate plus the overnight
# shift, and analogs are used for what they are good at: the size of the move.
SHRINK_WEIGHT = 400
MIN_BETA_OBS = 250
QUANTILES = (0.05, 0.25, 0.50, 0.75, 0.95)
TIER_NAMES = ["level + trend + volatility", "level + trend", "trend only", "all days"]


def overnight_signal(sp500_close: pd.Series, india_days: list, next_day=None) -> pd.Series:
    """Overnight US move, in its own volatility units, for each Indian session.

    For Indian session D the value is the S&P 500 log return over US sessions
    dated on or after the previous Indian session and before D, divided by the
    S&P's trailing 21-day volatility as known before those sessions. US markets
    close after the Indian close of the same date, so this is information that
    arrives between two Indian sessions and is known by 06:00 IST.
    `next_day` adds one extra (future) Indian session to the output.
    """
    days = list(india_days) + ([next_day] if next_day is not None else [])
    out = pd.Series(0.0, index=days)
    if sp500_close is None or len(sp500_close) < 30 or len(days) < 2:
        return out
    sp = sp500_close.sort_index()
    ret = np.log(sp).diff()
    sigma = ret.rolling(21, min_periods=10).std().shift(1)
    us_dates = np.array(sp.index)
    cum = ret.fillna(0).cumsum().values
    sig = sigma.values
    for k in range(1, len(days)):
        lo = np.searchsorted(us_dates, days[k - 1], side="left")     # first US date >= previous Indian day
        hi = np.searchsorted(us_dates, days[k], side="left")         # first US date >= this Indian day
        if hi <= lo or lo == 0:
            continue
        s = sig[lo]
        if not np.isfinite(s) or s <= 0:
            continue
        out.iloc[k] = (cum[hi - 1] - cum[lo - 1]) / s
    return out.clip(-4, 4)


@dataclass
class Forecast:
    n: int = 0
    tier: int = 3
    p_up: float = float("nan")
    base_p_up: float = float("nan")         # all-days up frequency after the overnight shift
    up_rate: float = float("nan")           # plain historical up frequency: the naive baseline
    close: dict = field(default_factory=dict)      # % vs previous close
    gap: dict = field(default_factory=dict)
    high: dict = field(default_factory=dict)       # session high, % above previous close
    low: dict = field(default_factory=dict)        # session low, % below previous close (negative)
    range_pct: dict = field(default_factory=dict)  # high minus low, % of previous close
    mean: float = float("nan")
    edge: dict = field(default_factory=dict)
    overnight_z: float = 0.0
    overnight_shift: float = 0.0                   # % shift of the centre due to the US move
    atr_pct: float = float("nan")
    # Samples in % of previous close, kept for touch probabilities and plan simulation.
    s_cc: np.ndarray = field(default_factory=lambda: np.array([]), repr=False)
    s_gap: np.ndarray = field(default_factory=lambda: np.array([]), repr=False)
    s_hi: np.ndarray = field(default_factory=lambda: np.array([]), repr=False)
    s_lo: np.ndarray = field(default_factory=lambda: np.array([]), repr=False)

    @property
    def ok(self) -> bool:
        return self.n >= 30 and np.isfinite(self.p_up)

    def touch_up(self, pct: float) -> float:
        """P(session high reaches +pct% above the previous close)."""
        return float(np.mean(self.s_hi >= pct)) if len(self.s_hi) else float("nan")

    def touch_down(self, pct: float) -> float:
        """P(session low reaches pct% (negative) below the previous close)."""
        return float(np.mean(self.s_lo <= pct)) if len(self.s_lo) else float("nan")

    def to_json(self) -> dict:
        r = lambda x, k=2: None if x is None or not np.isfinite(x) else round(float(x), k)
        q = lambda d: {k: r(v) for k, v in d.items()}
        return {"n": self.n, "tier": self.tier, "tier_name": TIER_NAMES[self.tier],
                "p_up": r(self.p_up, 3), "base_p_up": r(self.base_p_up, 3),
                "up_rate": r(self.up_rate, 3),
                "close": q(self.close), "gap": q(self.gap), "high": q(self.high),
                "low": q(self.low), "range": q(self.range_pct), "mean": r(self.mean, 3),
                "edge": {k: r(v, 3) for k, v in self.edge.items()},
                "overnight_z": r(self.overnight_z), "overnight_shift": r(self.overnight_shift, 3),
                "atr_pct": r(self.atr_pct, 3)}


def _bands(values: np.ndarray, cuts: tuple[float, float]) -> np.ndarray:
    out = np.full(len(values), np.nan)
    ok = np.isfinite(values)
    out[ok] = np.digitize(values[ok], cuts)
    return out


class SymbolModel:
    """Precomputed arrays for one symbol; `forecast(i)` is then cheap."""

    def __init__(self, df: pd.DataFrame, feat: pd.DataFrame, overnight: pd.Series | None = None):
        self.dates = list(df.index)
        n = len(df)
        c = df["close"].values.astype(float)
        atr_frac = feat["atr_pct"].values / 100.0
        self.atr_frac = atr_frac
        nxt = lambda col: np.r_[df[col].values[1:].astype(float), np.nan]
        with np.errstate(divide="ignore", invalid="ignore"):
            self.y = {                                             # outcomes of session i+1, in ATR units
                "cc": (nxt("close") / c - 1) / atr_frac,
                "gap": (nxt("open") / c - 1) / atr_frac,
                "hi": (nxt("high") / c - 1) / atr_frac,
                "lo": (nxt("low") / c - 1) / atr_frac,
            }
        self.valid = np.isfinite(self.y["cc"]) & np.isfinite(self.y["hi"]) & np.isfinite(self.y["lo"]) \
            & np.isfinite(self.y["gap"]) & (atr_frac > 0)

        self.level = _bands(feat["pct_rank_60"].values, (30.0, 70.0))
        self.trend = feat["trend_state"].values.astype(float)
        self.vol = _bands(feat["vol_ratio"].values, (0.85, 1.15))

        # x_next[i] = overnight signal arriving before session i+1.
        if overnight is not None and len(overnight):
            x = overnight.reindex(self.dates).fillna(0.0).values
            self.x_next = np.r_[x[1:], 0.0]
        else:
            self.x_next = np.zeros(n)

        # Expanding no-intercept betas of each outcome on the overnight signal,
        # where beta[i] uses rows strictly before i.
        xv = np.where(self.valid, self.x_next, 0.0)
        sxx = np.r_[0.0, np.cumsum(xv * xv)[:-1]]
        cnt = np.r_[0, np.cumsum(self.valid & (self.x_next != 0))[:-1]]
        self.beta = {}
        for key, y in self.y.items():
            yv = np.where(self.valid, y, 0.0)
            sxy = np.r_[0.0, np.cumsum(xv * yv)[:-1]]
            with np.errstate(divide="ignore", invalid="ignore"):
                b = np.where((cnt >= MIN_BETA_OBS) & (sxx > 0), sxy / sxx, 0.0)
            self.beta[key] = np.clip(b, -1.5, 1.5)

    def _analogs(self, i: int) -> tuple[np.ndarray, int]:
        pool = self.valid[:i].copy()                               # only sessions whose outcome is known
        lvl, trd, vol = self.level[i], self.trend[i], self.vol[i]
        tiers = []
        if np.isfinite(lvl) and np.isfinite(trd) and np.isfinite(vol):
            tiers.append(pool & (self.level[:i] == lvl) & (self.trend[:i] == trd) & (self.vol[:i] == vol))
        else:
            tiers.append(None)
        tiers.append(pool & (self.level[:i] == lvl) & (self.trend[:i] == trd)
                     if np.isfinite(lvl) and np.isfinite(trd) else None)
        tiers.append(pool & (self.trend[:i] == trd) if np.isfinite(trd) else None)
        tiers.append(pool)
        for tier, mask in enumerate(tiers):
            if mask is not None and (mask.sum() >= MIN_ANALOGS or tier == 3):
                return np.flatnonzero(mask), tier
        return np.flatnonzero(pool), 3

    def forecast(self, i: int, x_now: float | None = None) -> Forecast:
        """Forecast for the session after row i. `x_now` overrides the overnight signal."""
        fc = Forecast()
        scale = self.atr_frac[i] * 100.0 if i < len(self.atr_frac) else np.nan     # ATR units -> %
        if not np.isfinite(scale) or scale <= 0:
            return fc
        idx, tier = self._analogs(i)
        fc.n, fc.tier, fc.atr_pct = int(len(idx)), tier, float(scale)
        if len(idx) < 30:
            return fc
        x = float(self.x_next[i] if x_now is None else x_now)
        fc.overnight_z = x

        def sample(key: str) -> np.ndarray:
            b = self.beta[key][i]
            return (self.y[key][idx] - b * self.x_next[idx] + b * x) * scale

        fc.s_cc, fc.s_gap, fc.s_hi, fc.s_lo = sample("cc"), sample("gap"), sample("hi"), sample("lo")
        fc.overnight_shift = float(self.beta["cc"][i] * x * scale)

        pool = np.flatnonzero(self.valid[:i])
        b_cc = self.beta["cc"][i]
        pool_cc = (self.y["cc"][pool] - b_cc * self.x_next[pool] + b_cc * x) * scale
        fc.base_p_up = float(np.mean(pool_cc > 0))
        fc.up_rate = float(np.mean(self.y["cc"][pool] > 0))
        k = float(np.sum(fc.s_cc > 0))
        fc.p_up = (k + SHRINK_WEIGHT * fc.base_p_up) / (len(idx) + SHRINK_WEIGHT)

        qs = lambda arr, probs: {f"p{int(p * 100):02d}": float(v)
                                 for p, v in zip(probs, np.quantile(arr, probs))}
        fc.close = qs(fc.s_cc, QUANTILES)
        fc.gap = qs(fc.s_gap, (0.05, 0.50, 0.95))
        fc.high = qs(fc.s_hi, (0.25, 0.50, 0.75, 0.90))
        fc.low = qs(fc.s_lo, (0.10, 0.25, 0.50, 0.75))
        fc.range_pct = qs(fc.s_hi - fc.s_lo, (0.50, 0.90))
        fc.mean = float(fc.s_cc.mean())

        sd = float(fc.s_cc.std(ddof=1)) if len(idx) > 1 else np.nan
        diff = fc.mean - float(pool_cc.mean())
        fc.edge = {"analog_mean": fc.mean, "all_mean": float(pool_cc.mean()), "diff": diff,
                   "t_stat": diff / (sd / np.sqrt(len(idx))) if sd and sd > 0 else float("nan")}
        return fc
