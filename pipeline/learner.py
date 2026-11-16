"""Weekly self-training direction models, with a gate (the "learn every Sunday" part).

Two models are trained on every stock-day in the history, pooled:
  * a regularised logistic regression (transparent: its weights are published)
  * gradient-boosted trees (can pick up non-linear patterns)
Both predict the probability that the next session closes up.

How "every Sunday" works, exactly:
  The model used for a session is the one trained on everything whose outcome
  was known before the Monday of that session's week. So each new week gets a
  model that has seen one more week of data, including how the previous week
  turned out. The same rule is used for today and for the historical replay,
  so a past week's prediction never comes from a model that saw that week.

The gate:
  A trained model is not trusted because it is new. The engine measures how
  each source (simple baseline, logistic model, tree model) did on the last
  250 sessions of real out-of-sample predictions and weights them by that
  record (non-negative least squares). A model that has not been helping gets
  weight zero. Measured on 3 years: either model alone was no better than the
  baseline; the blend added about 0.4 percentage points of hit rate.

Fitting is deterministic (fixed seed, no random validation split), so the same
data always gives the same model.
"""
from __future__ import annotations

from datetime import date, timedelta

import numpy as np
import pandas as pd

MIN_TRAIN_ROWS = 20000
L2 = 20.0                           # ridge strength of the logistic regression
GBM_PARAMS = dict(max_depth=3, learning_rate=0.03, max_iter=200, min_samples_leaf=500,
                  l2_regularization=1.0, early_stopping=False, random_state=0)

# name -> plain-language label (shown on the site)
FEATURES = {
    "x": "Overnight US move",
    "x_beta": "Overnight US move x stock beta",
    "absx": "Size of the overnight US move",
    "ret_u": "Previous day's move",
    "absret": "Size of the previous day's move",
    "roc5_u": "5-day move",
    "roc21_u": "1-month move",
    "rsi": "RSI",
    "z20": "Distance from 20-day average (z-score)",
    "pctb": "Position inside Bollinger bands",
    "d20_u": "Distance from 20-day average",
    "d50_u": "Distance from 50-day average",
    "trend": "Trend state",
    "volr": "Volatility expanding or calm",
    "lvol": "Volume versus normal",
    "deliv": "Delivery % versus normal",
    "gap_u": "Previous day's opening gap",
    "rng_u": "Previous day's range",
    "clv": "Where the previous day closed inside its range",
    "rs21_u": "1-month strength versus Nifty",
    "beta": "Beta",
    "mret_u": "Nifty's previous-day move",
    "vixchg": "Change in India VIX",
    "vixrank": "India VIX level (percentile)",
    "adv": "Market breadth (advancers)",
}
NAMES = list(FEATURES)


def monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def feature_frame(st, market: pd.DataFrame, nifty: pd.Series) -> pd.DataFrame:
    """Model inputs for every row of one stock. Row i describes the state before session i+1."""
    f, df = st.feat, st.df
    a = f["atr_pct"].replace(0, np.nan)
    nret = nifty.pct_change() * 100
    natr = nret.abs().rolling(14).mean().replace(0, np.nan)
    col = lambda name: market[name].reindex(df.index) if name in market else pd.Series(np.nan, index=df.index)
    x = pd.Series(st.model.x_next, index=df.index)
    if len(x):
        x.iloc[-1] = getattr(st, "overnight_next", 0.0)      # the signal for the upcoming session
    beta = f["beta_252"].fillna(1.0)
    d = pd.DataFrame(index=df.index)
    d["x"] = x
    d["x_beta"] = x * beta
    d["absx"] = x.abs()
    d["ret_u"] = f["ret_1d"] / a
    d["absret"] = d["ret_u"].abs()
    d["roc5_u"] = f["roc_5"] / a
    d["roc21_u"] = f["roc_21"] / a
    d["rsi"] = (f["rsi_14"] - 50) / 20
    d["z20"] = f["z_20"]
    d["pctb"] = f["bb_pctb"] - 0.5
    d["d20_u"] = f["dist_sma_20"] / a
    d["d50_u"] = f["dist_sma_50"] / a
    d["trend"] = f["trend_state"]
    d["volr"] = f["vol_ratio"] - 1
    d["lvol"] = np.log(f["volume_ratio"].clip(0.1, 10))
    d["deliv"] = (f["deliv_vs_60"] / 10).fillna(0.0)
    d["gap_u"] = f["gap_pct"] / a
    d["rng_u"] = f["day_range_pct"] / a
    span = (df["high"] - df["low"]).replace(0, np.nan)
    d["clv"] = ((df["close"] - df["low"]) / span - 0.5).fillna(0.0)
    d["rs21_u"] = (f["rs_21"] / a).fillna(0.0)
    d["beta"] = beta - 1
    d["mret_u"] = (nret / natr).reindex(df.index).fillna(0.0)
    d["vixchg"] = (col("vix").pct_change(fill_method=None) * 100 / 5).fillna(0.0)
    d["vixrank"] = ((col("vix_rank_252") - 50) / 50).fillna(0.0)
    d["adv"] = ((col("adv_pct") - 50) / 25).fillna(0.0)
    return d[NAMES].replace([np.inf, -np.inf], np.nan).clip(-6, 6)


def fit_logistic(X: np.ndarray, y: np.ndarray, l2: float = L2, iters: int = 25) -> dict:
    """Ridge logistic regression by Newton's method on standardised inputs."""
    mu, sd = X.mean(axis=0), X.std(axis=0)
    sd = np.where(sd > 0, sd, 1.0)
    Z = np.c_[np.ones(len(X)), (X - mu) / sd]
    w = np.zeros(Z.shape[1])
    pen = np.r_[0.0, np.full(Z.shape[1] - 1, l2)]            # the intercept is not penalised
    for _ in range(iters):
        p = 1 / (1 + np.exp(-np.clip(Z @ w, -30, 30)))
        grad = Z.T @ (p - y) + pen * w
        H = (Z * (p * (1 - p))[:, None]).T @ Z + np.diag(pen)
        step = np.linalg.solve(H, grad)
        w -= step
        if np.abs(step).max() < 1e-8:
            break
    return {"mu": mu, "sd": sd, "w": w}


def predict_logistic(m: dict, X: np.ndarray) -> np.ndarray:
    Z = np.c_[np.ones(len(X)), (X - m["mu"]) / m["sd"]]
    return 1 / (1 + np.exp(-np.clip(Z @ m["w"], -30, 30)))


class Learner:
    """Pooled training table plus a lazily filled set of weekly models."""

    def __init__(self, states: dict, market: pd.DataFrame, nifty: pd.Series, next_day: dict):
        """`next_day[sym]` is the session after that stock's last row."""
        xs, ys, keys, known = [], [], [], []
        self.offset, n = {}, 0
        for sym, st in states.items():
            X = feature_frame(st, market, nifty).values
            nxt = np.array(st.dates[1:] + [next_day[sym]], dtype=object)       # session each row is about
            up = (st.model.y["cc"] > 0).astype(float)
            xs.append(X)
            ys.append(up)
            keys.append(nxt)
            known.append(st.model.valid)                     # outcome known and usable
            self.offset[sym] = n
            n += len(X)
        self.X = np.vstack(xs) if xs else np.zeros((0, len(NAMES)))
        self.y = np.concatenate(ys) if ys else np.zeros(0)
        self.session = np.concatenate(keys) if keys else np.zeros(0, dtype=object)
        self.week = np.array([monday(d) for d in self.session], dtype=object)
        self.has_x = np.isfinite(self.X).all(axis=1)
        self.trainable = self.has_x & (np.concatenate(known) if known else np.zeros(0, dtype=bool))
        self.p_lr = np.full(n, np.nan)
        self.p_gbm = np.full(n, np.nan)
        self.models: dict[date, dict | None] = {}

    def _fit(self, week: date) -> dict | None:
        """Train on every row whose session ended before `week`, then predict that week."""
        if week in self.models:
            return self.models[week]
        train = self.trainable & (self.session < week)
        info = None
        if train.sum() >= MIN_TRAIN_ROWS and 0 < self.y[train].mean() < 1:
            from sklearn.ensemble import HistGradientBoostingClassifier
            Xt, yt = self.X[train], self.y[train]
            lr = fit_logistic(Xt, yt)
            gbm = HistGradientBoostingClassifier(**GBM_PARAMS).fit(Xt, yt)
            rows = np.flatnonzero((self.week == week) & self.has_x)
            if len(rows):
                self.p_lr[rows] = predict_logistic(lr, self.X[rows])
                self.p_gbm[rows] = gbm.predict_proba(self.X[rows])[:, 1]
            sessions = self.session[train]
            info = {"week": week.isoformat(), "rows": int(train.sum()),
                    "from": min(sessions).isoformat(), "to": max(sessions).isoformat(),
                    "up_share": round(float(yt.mean()), 4),
                    "weights": {n: round(float(w), 4) for n, w in zip(NAMES, lr["w"][1:])}}
        self.models[week] = info
        return info

    def predict(self, sym: str, i: int) -> tuple[float, float]:
        """(logistic, trees) probability of an up close for the session after row i. NaN if no model."""
        row = self.offset[sym] + i
        self._fit(self.week[row])
        return float(self.p_lr[row]), float(self.p_gbm[row])

    def info(self, sym: str, i: int) -> dict | None:
        return self._fit(self.week[self.offset[sym] + i])
