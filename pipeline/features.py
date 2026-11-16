"""Statistics catalogue (PLAN.md section 5), as pure functions of a daily frame.

Every value on row t uses data up to and including t only. This is enforced by
the truncation test: computing on history cut at t must give the same row t.

Input frame: index = date, columns open high low close adjclose volume
(split-adjusted) and optionally turnover, deliv_pct.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

TRADING_DAYS = 252


# ------------------------------------------------------------------ primitives
def wilder(series: pd.Series, n: int) -> pd.Series:
    """Wilder's smoothing (the classic RSI / ATR / ADX average)."""
    return series.ewm(alpha=1.0 / n, adjust=False, min_periods=n).mean()


def true_range(df: pd.DataFrame) -> pd.Series:
    prev = df["close"].shift(1)
    return pd.concat([df["high"] - df["low"], (df["high"] - prev).abs(),
                      (df["low"] - prev).abs()], axis=1).max(axis=1)


def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    return wilder(true_range(df), n)


def rsi(close: pd.Series, n: int = 14) -> pd.Series:
    delta = close.diff()
    up = wilder(delta.clip(lower=0), n)
    down = wilder((-delta).clip(lower=0), n)
    rs = up / down.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    return out.where(down != 0, 100.0).where(up.notna())


def adx(df: pd.DataFrame, n: int = 14) -> pd.Series:
    up = df["high"].diff()
    down = -df["low"].diff()
    plus_dm = up.where((up > down) & (up > 0), 0.0)
    minus_dm = down.where((down > up) & (down > 0), 0.0)
    tr = wilder(true_range(df), n)
    plus_di = 100 * wilder(plus_dm, n) / tr
    minus_di = 100 * wilder(minus_dm, n) / tr
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    return wilder(dx.fillna(0.0), n).where(tr.notna())


def pct_rank(series: pd.Series, n: int) -> pd.Series:
    """Percentile (0-100) of the latest value within the last n values."""
    return series.rolling(n, min_periods=max(5, n // 2)).rank(pct=True) * 100


def range_position(df: pd.DataFrame, n: int) -> pd.Series:
    hi = df["high"].rolling(n, min_periods=max(5, n // 2)).max()
    lo = df["low"].rolling(n, min_periods=max(5, n // 2)).min()
    return 100 * (df["close"] - lo) / (hi - lo).replace(0, np.nan)


def trend_fit(close: pd.Series, n: int) -> tuple[pd.Series, pd.Series]:
    """Slope (% per day) and R-squared of a log-price regression over n days."""
    logp = np.log(close)
    t = pd.Series(np.arange(len(close), dtype=float), index=close.index)
    corr = logp.rolling(n).corr(t)
    slope = corr * logp.rolling(n).std() / t.rolling(n).std()
    return slope * 100, corr ** 2


def days_since(flag: pd.Series) -> pd.Series:
    """Rows since `flag` was last True (0 on the row where it is True)."""
    pos = pd.Series(np.arange(len(flag), dtype=float), index=flag.index)
    return pos - pos.where(flag.astype(bool)).ffill()


# -------------------------------------------------------------------- the lot
def compute_features(df: pd.DataFrame, bench: pd.Series | None = None) -> pd.DataFrame:
    """All per-symbol statistics. `bench` is the benchmark close (Nifty 50)."""
    c, h, l, o, v = df["close"], df["high"], df["low"], df["open"], df["volume"]
    ret = c.pct_change()
    logret = np.log(c).diff()
    f = pd.DataFrame(index=df.index)
    f["close"] = c
    f["ret_1d"] = ret * 100

    # 5.1 level and position
    for n in (20, 60, 252):
        f[f"pct_rank_{n}"] = pct_rank(c, n)
        f[f"range_pos_{n}"] = range_position(df, n)
    hi252 = h.rolling(252, min_periods=60).max()
    lo252 = l.rolling(252, min_periods=60).min()
    f["dist_52w_high"] = (c / hi252 - 1) * 100
    f["dist_52w_low"] = (c / lo252 - 1) * 100
    f["days_since_52w_high"] = days_since(h >= hi252)
    f["drawdown"] = (c / c.cummax() - 1) * 100
    for n in (20, 60):
        f[f"z_{n}"] = (c - c.rolling(n).mean()) / c.rolling(n).std().replace(0, np.nan)

    # 5.2 trend
    for n in (20, 50, 200):
        sma = c.rolling(n).mean()
        f[f"sma_{n}"] = sma
        f[f"dist_sma_{n}"] = (c / sma - 1) * 100
    above = (c > f["sma_20"]).astype(int) + (c > f["sma_50"]).astype(int) + (c > f["sma_200"]).astype(int)
    f["trend_state"] = np.select([above == 3, above == 0], [1, -1], 0)
    f.loc[f["sma_200"].isna(), "trend_state"] = np.nan
    golden = f["sma_50"] > f["sma_200"]
    f["cross_state"] = np.where(golden, 1, -1).astype(float)
    f.loc[f["sma_200"].isna(), "cross_state"] = np.nan
    f["days_since_cross"] = days_since(golden != golden.shift(1)).where(f["sma_200"].notna())
    for n in (20, 60):
        f[f"slope_{n}"], f[f"r2_{n}"] = trend_fit(c, n)
    f["adx_14"] = adx(df, 14)
    prior_hi20 = h.shift(1).rolling(20).max()
    prior_lo20 = l.shift(1).rolling(20).min()
    f["donchian"] = np.select([c > prior_hi20, c < prior_lo20], [1, -1], 0)
    f["high_20"] = h.rolling(20).max()
    f["low_20"] = l.rolling(20).min()
    macd = c.ewm(span=12, adjust=False).mean() - c.ewm(span=26, adjust=False).mean()
    signal = macd.ewm(span=9, adjust=False).mean()
    f["macd_hist"] = (macd - signal) / c * 100

    # 5.3 momentum
    f["rsi_14"] = rsi(c, 14)
    for n in (5, 21, 63, 126, 252):
        f[f"roc_{n}"] = (c / c.shift(n) - 1) * 100
    f["mom_12_1"] = (c.shift(21) / c.shift(252) - 1) * 100
    lo14, hi14 = l.rolling(14).min(), h.rolling(14).max()
    f["stoch_14"] = 100 * (c - lo14) / (hi14 - lo14).replace(0, np.nan)

    # 5.4 volatility and range
    for n in (10, 21, 63):
        f[f"rv_{n}"] = logret.rolling(n).std() * np.sqrt(TRADING_DAYS) * 100
    f["atr_14"] = atr(df, 14)
    f["atr_pct"] = f["atr_14"] / c * 100
    hl = np.log(h / l) ** 2
    co = np.log(c / o) ** 2
    f["parkinson_21"] = np.sqrt(hl.rolling(21).mean() / (4 * np.log(2)) * TRADING_DAYS) * 100
    gk = (0.5 * hl - (2 * np.log(2) - 1) * co).rolling(21).mean().clip(lower=0)
    f["garman_klass_21"] = np.sqrt(gk * TRADING_DAYS) * 100
    f["vol_ratio"] = f["rv_21"] / f["rv_63"].replace(0, np.nan)
    mid, sd = c.rolling(20).mean(), c.rolling(20).std()
    f["bb_pctb"] = (c - (mid - 2 * sd)) / (4 * sd).replace(0, np.nan)
    f["bb_width"] = 4 * sd / mid * 100
    f["bb_width_rank"] = pct_rank(f["bb_width"], 126)

    # 5.5 participation
    f["volume_ratio"] = v / v.rolling(20).mean().shift(1).replace(0, np.nan)
    turnover = df["turnover"] if "turnover" in df.columns else pd.Series(np.nan, index=df.index)
    turnover = turnover.fillna(c * v)                    # estimate where the official value is absent
    f["turnover_20"] = turnover.rolling(20, min_periods=5).mean()
    if "deliv_pct" in df.columns:
        f["deliv_pct"] = df["deliv_pct"]
        f["deliv_vs_60"] = df["deliv_pct"] - df["deliv_pct"].rolling(60, min_periods=20).mean().shift(1)
    else:
        f["deliv_pct"] = np.nan
        f["deliv_vs_60"] = np.nan
    up_vol = v.where(ret > 0, 0.0).rolling(20).sum()
    f["up_volume_ratio"] = up_vol / v.rolling(20).sum().replace(0, np.nan) * 100
    obv = (np.sign(ret.fillna(0)) * v).cumsum()
    f["obv_trend"] = (obv - obv.shift(20)) / v.rolling(20).sum().replace(0, np.nan)

    # 5.6 gaps and reference levels
    f["gap_pct"] = (o / c.shift(1) - 1) * 100
    f["prev_high"], f["prev_low"] = h, l                  # "previous" from tomorrow's viewpoint
    pivot = (h + l + c) / 3
    f["pivot"] = pivot
    f["pivot_r1"], f["pivot_s1"] = 2 * pivot - l, 2 * pivot - h
    f["day_range_pct"] = (h - l) / c * 100

    # 5.7 relative strength and market context
    if bench is not None and len(bench):
        b = bench.reindex(df.index).ffill()
        bret = b.pct_change()
        ratio = c / b
        f["rs_rank_252"] = pct_rank(ratio, 252)
        for n in (21, 63):
            f[f"rs_{n}"] = ((c / c.shift(n)) / (b / b.shift(n)) - 1) * 100
        cov = ret.rolling(252, min_periods=120).cov(bret)
        f["beta_252"] = cov / bret.rolling(252, min_periods=120).var().replace(0, np.nan)
        f["corr_252"] = ret.rolling(252, min_periods=120).corr(bret)
    else:
        for col in ("rs_rank_252", "rs_21", "rs_63", "beta_252", "corr_252"):
            f[col] = np.nan

    # 5.8 risk
    r252 = ret.rolling(252, min_periods=120)
    f["var_95"] = r252.quantile(0.05) * 100
    def _cvar(x: np.ndarray) -> float:
        x = x[~np.isnan(x)]
        tail = x[x <= np.quantile(x, 0.05)] if len(x) else x
        return float(tail.mean()) if len(tail) else np.nan

    f["cvar_95"] = ret.rolling(252, min_periods=120).apply(_cvar, raw=True) * 100
    f["skew_252"] = r252.skew()
    f["kurt_252"] = r252.kurt()
    f["worst_day_252"] = r252.min() * 100
    f["downside_dev"] = ret.clip(upper=0).rolling(252, min_periods=120).std() * np.sqrt(TRADING_DAYS) * 100
    down = (ret < 0).astype(float)
    both = (down * down.shift(1)).rolling(252, min_periods=120).sum()
    f["p_down_after_down"] = both / down.shift(1).rolling(252, min_periods=120).sum().replace(0, np.nan) * 100
    return f


def market_features(vix: pd.Series | None, breadth: pd.DataFrame | None,
                    above_50: pd.Series | None) -> pd.DataFrame:
    """Market-wide context: India VIX regime and breadth."""
    parts = {}
    if vix is not None and len(vix):
        parts["vix"] = vix
        parts["vix_rank_252"] = pct_rank(vix, 252)
        rank = parts["vix_rank_252"]
        parts["vix_regime"] = pd.Series(
            np.select([rank < 33, rank > 80], [-1, 1], 0), index=vix.index).where(rank.notna())
    if breadth is not None and len(breadth):
        b = breadth.set_index("date")
        total = (b["advances"] + b["declines"]).replace(0, np.nan)
        parts["adv_pct"] = b["advances"] / total * 100
        parts["adv_pct_10"] = parts["adv_pct"].rolling(10, min_periods=3).mean()
    if above_50 is not None and len(above_50):
        parts["pct_above_sma50"] = above_50
    return pd.DataFrame(parts).sort_index()
