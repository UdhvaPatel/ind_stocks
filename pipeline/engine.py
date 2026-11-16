"""The analysis engine: one code path for today's plans and for the walk-forward.

`Engine(dataset)` precomputes, per stock, everything that depends only on the
past of each row (statistics, forecasts, plan levels, each rule's resolved
record). `book(as_of)` then reads the row for `as_of` and returns what the tool
would have published for the NEXT session. Because the same function serves
the live morning job and the historical replay, the replay cannot cheat: the
test suite checks that a book built from history cut at `as_of` is identical.
"""
from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd
from scipy.optimize import nnls

from . import backtest, config, costs, decide, features as ft, plans, setupscore
from .dataset import Dataset
from .forecast import Forecast, SymbolModel, overnight_signal
from .learner import Learner
from .tradingcal import TradingCalendar

TOUCH_ATR = 0.5          # touch claims are made at +/- half an ATR from the previous close
CALIB_WINDOW = 250       # sessions of past forecasts used to calibrate range widths
CALIB_MIN = 500          # pooled residuals needed before any calibration is applied
CALIB_LIMITS = (0.8, 1.6)


class SymbolState:
    """Everything precomputed for one stock."""

    def __init__(self, symbol: str, df: pd.DataFrame, bench: pd.Series, vix_regime: pd.Series | None,
                 overnight: pd.Series, mcfg: dict, ccfg: dict):
        self.symbol = symbol
        self.df = df
        self.dates = list(df.index)
        self.pos = {d: i for i, d in enumerate(self.dates)}
        self.feat = ft.compute_features(df, bench)
        self.setup = setupscore.setup_score(self.feat, vix_regime)
        self.turnover_cr = (self.feat["turnover_20"] / 1e7).values
        self.slip = costs.slippage_per_side(np.nan_to_num(self.turnover_cr), ccfg)
        self.model = SymbolModel(df, self.feat, overnight)
        self.levels, self.sims, self.evidence = {}, {}, {}
        for kind in plans.KINDS:
            lv = plans.plan_levels(df, self.feat, kind, mcfg)
            sim = plans.simulate(df, lv, kind, self.slip, ccfg)
            self.levels[kind], self.sims[kind] = lv, sim
            self.evidence[kind] = backtest.expanding_evidence(sim)
        # Lazily filled record of past forecasts and what happened, used to
        # calibrate today's numbers. Columns:
        #   0-2  stretch needed by the close / gap / session-range forecast
        #   3-4  raw p(up) and whether the close was up
        #   5-8  raw touch probabilities (4 levels), 9-12 whether each was touched
        #   13-14 p(up) from the weekly-trained logistic and tree models
        self.hist = np.full((len(self.dates), 15), np.nan)
        self.hist_done = np.zeros(len(self.dates), dtype=bool)

    def touch_levels(self, i: int) -> list[tuple[str, str, float]]:
        row = self.df.iloc[i]
        close, atr = float(row["close"]), float(self.feat["atr_14"].iloc[i])
        return [("up_half_atr", "up", close + TOUCH_ATR * atr),
                ("down_half_atr", "down", close - TOUCH_ATR * atr),
                ("prev_high", "up", float(row["high"])),
                ("prev_low", "down", float(row["low"]))]

    def fill_hist(self, lo: int, hi: int, learner=None) -> None:
        """Record forecasts and outcomes for rows lo..hi-1 (each needs the next session)."""
        c, o, h, l = (self.df[k].values for k in ("close", "open", "high", "low"))
        for j in range(max(lo, 0), min(hi, len(self.dates) - 1)):
            if self.hist_done[j]:
                continue
            self.hist_done[j] = True
            fc = self.model.forecast(j)
            if not fc.ok:
                continue
            ret = (c[j + 1] / c[j] - 1) * 100
            gap = (o[j + 1] / c[j] - 1) * 100
            rng = (h[j + 1] - l[j + 1]) / c[j] * 100
            row = self.hist[j]
            row[0] = _stretch(ret, fc.close["p05"], fc.close["p50"], fc.close["p95"])
            row[1] = _stretch(gap, fc.gap["p05"], fc.gap["p50"], fc.gap["p95"])
            row[2] = rng / fc.range_pct["p90"] if fc.range_pct["p90"] > 0 else np.nan
            row[3], row[4] = fc.p_up, float(ret > 0)
            for n, (_, side, level) in enumerate(self.touch_levels(j)):
                pct = (level / c[j] - 1) * 100
                row[5 + n] = fc.touch_up(pct) if side == "up" else fc.touch_down(pct)
                row[9 + n] = float(h[j + 1] >= level) if side == "up" else float(l[j + 1] <= level)
            if learner is not None:
                row[13], row[14] = learner.predict(self.symbol, j)


def _stretch(y: float, lo: float, mid: float, hi: float) -> float:
    """Factor by which the range [lo, hi] must be scaled about `mid` to just contain y."""
    if y >= mid:
        return (y - mid) / (hi - mid) if hi > mid else np.nan
    return (mid - y) / (mid - lo) if mid > lo else np.nan


class Engine:
    def __init__(self, ds: Dataset, calendar: TradingCalendar | None = None):
        self.ds = ds
        self.mcfg = config.load_yaml("model.yaml")
        self.ccfg = costs.cost_cfg()
        self.calendar = calendar or TradingCalendar.load()
        self.market = ft.market_features(ds.vix if len(ds.vix) else None, ds.breadth, None)
        vix_regime = self.market["vix_regime"] if "vix_regime" in self.market else None
        sp = ds.overnight["SP500"]["close"] if "SP500" in ds.overnight else None

        self.states: dict[str, SymbolState] = {}
        for sym, df in ds.frames.items():
            if len(df) < 60:
                continue
            nxt = self.calendar.next_trading_day(df.index[-1])
            ov = overnight_signal(sp, list(df.index), next_day=nxt)
            st = SymbolState(sym, df, ds.nifty, vix_regime, ov, self.mcfg, self.ccfg)
            st.overnight_next = float(ov.iloc[-1])          # signal for the session after the last row
            self.states[sym] = st
        self._pooled = self._build_pooled()
        self._calib: dict[date, dict] = {}
        self.learner = Learner(self.states, self.market, ds.nifty,
                               {s: self.calendar.next_trading_day(st.dates[-1]) for s, st in self.states.items()})

    # ------------------------------------------------------ pooled rule record
    def _build_pooled(self) -> dict[str, pd.DataFrame]:
        """Per rule: cumulative count and sum of net R over ALL stocks, by plan date."""
        out = {}
        for kind in plans.KINDS:
            parts = []
            for st in self.states.values():
                sim = st.sims[kind]
                traded = sim["status"].isin(plans.TRADED) & sim["r"].notna()
                parts.append(sim.loc[traded, "r"])
            if not parts or not sum(len(p) for p in parts):
                out[kind] = pd.DataFrame(columns=["n", "sum"])
                continue
            r = pd.concat(parts)
            g = r.groupby(level=0).agg(["count", "sum"]).sort_index()
            out[kind] = pd.DataFrame({"n": g["count"].cumsum(), "sum": g["sum"].cumsum()})
        return out

    def pooled_mean(self, kind: str, as_of: date) -> float:
        """Mean net R of a rule over all stocks, using plans made strictly before `as_of`.

        A plan made on day d is resolved during the next session, which is at
        or before `as_of` whenever d < as_of.
        """
        tab = self._pooled[kind]
        if not len(tab):
            return 0.0
        k = int(np.searchsorted(np.array(tab.index, dtype=object), as_of, side="left"))
        if k == 0:
            return 0.0
        row = tab.iloc[k - 1]
        return float(row["sum"] / row["n"]) if row["n"] else 0.0

    # ------------------------------------------------------------- calibration
    def calibration(self, as_of: date) -> dict:
        """Corrections learned from the previous CALIB_WINDOW sessions of forecasts.

        Ranges: for each recent forecast we know how far its 90% range would
        have had to stretch to contain the outcome; the 90th percentile of those
        stretches is the multiplier that would have given exactly 90% coverage
        (a split conformal correction).
        Probabilities: raw probabilities are too extreme, so they are pulled
        back by the amount the recent record justifies.
        Only forecasts whose outcome is known by the close of `as_of` are used.
        """
        if as_of in self._calib:
            return self._calib[as_of]
        parts = []
        for st in self.states.values():
            i = st.pos.get(as_of)
            if i is None:
                continue
            st.fill_hist(i - CALIB_WINDOW, i, self.learner)
            parts.append(st.hist[max(i - CALIB_WINDOW, 0):i])
        out = {"close": 1.0, "gap": 1.0, "range": 1.0, "dir_base": 1.0, "dir_lr": 0.0, "dir_gbm": 0.0,
               "touch_a": 0.0, "touch_b": 1.0, "n": 0}
        if parts:
            arr = np.vstack(parts)
            arr = arr[np.isfinite(arr[:, 0])]
            out["n"] = int(len(arr))
            if len(arr) >= CALIB_MIN:
                for col, key in enumerate(("close", "gap", "range")):
                    v = arr[:, col]
                    k = float(np.quantile(v[np.isfinite(v)], 0.90))
                    out[key] = round(float(np.clip(k, *CALIB_LIMITS)), 4)
                # Direction: weight each source (simple baseline, logistic model, tree
                # model) by how much of its lean away from 50% the recent record
                # justified. Non-negative least squares: a source that has not been
                # helping gets weight zero. This is the gate on the trained models.
                lean = np.nan_to_num(arr[:, [3, 13, 14]] - 0.5)
                w, _ = nnls(lean, arr[:, 4] - 0.5)
                w = np.clip(w, 0.0, 1.2)
                out["dir_base"], out["dir_lr"], out["dir_gbm"] = (round(float(v), 4) for v in w)
                # Touch probabilities: straight-line recalibration, realised = a + b * predicted.
                tp, th = arr[:, 5:9].ravel(), arr[:, 9:13].ravel()
                ok = np.isfinite(tp) & np.isfinite(th)
                if ok.sum() >= CALIB_MIN and tp[ok].std() > 0:
                    b_ = float(np.clip(np.cov(tp[ok], th[ok])[0, 1] / tp[ok].var(ddof=1), 0.5, 1.2))
                    out["touch_b"] = round(b_, 4)
                    out["touch_a"] = round(float(th[ok].mean() - b_ * tp[ok].mean()), 4)
        self._calib[as_of] = out
        return out

    # ---------------------------------------------------------------- the book
    def symbol_entry(self, sym: str, as_of: date, detail: bool = False) -> dict | None:
        st = self.states.get(sym)
        if st is None or as_of not in st.pos:
            return None
        i = st.pos[as_of]
        row, feat = st.df.iloc[i], st.feat.iloc[i]
        atr = float(feat["atr_14"])
        close = float(row["close"])
        if not np.isfinite(atr) or atr <= 0:
            return None
        last = i == len(st.dates) - 1
        fc: Forecast = st.model.forecast(i, st.overnight_next if last else None)

        pct = lambda price: (price / close - 1) * 100
        claims = None
        cal = self.calibration(as_of) if fc.ok else None
        if fc.ok:
            widen = lambda q, k: {name: round(q["p50"] + k * (v - q["p50"]), 3) for name, v in q.items()}
            fix = lambda p: float(np.clip(cal["touch_a"] + cal["touch_b"] * p, 0.01, 0.99))
            touch = []
            for name, side, level in st.touch_levels(i):
                raw = fc.touch_up(pct(level)) if side == "up" else fc.touch_down(pct(level))
                touch.append({"name": name, "side": side, "level": round(level, 2), "p": round(fix(raw), 4)})
            p_lr, p_gbm = self.learner.predict(sym, i)
            lean = lambda p: (p - 0.5) if np.isfinite(p) else 0.0
            p_up = 0.5 + cal["dir_base"] * lean(fc.p_up) + cal["dir_lr"] * lean(p_lr) + cal["dir_gbm"] * lean(p_gbm)
            claims = {
                "dir": {"p_up": round(float(np.clip(p_up, 0.02, 0.98)), 4),
                        "base_p_up": round(fc.up_rate, 4),
                        "parts": {"simple": round(fc.p_up, 4),
                                  "logistic": None if not np.isfinite(p_lr) else round(p_lr, 4),
                                  "trees": None if not np.isfinite(p_gbm) else round(p_gbm, 4)}},
                "close": widen(fc.close, cal["close"]),
                "gap": widen(fc.gap, cal["gap"]),
                "range": {"p50": round(fc.range_pct["p50"], 3),
                          "p90": round(fc.range_pct["p90"] * cal["range"], 3)},
                "touch": touch,
                "calibration": {k: cal[k] for k in ("close", "gap", "range", "dir_base", "dir_lr", "dir_gbm",
                                                        "touch_a", "touch_b")},
                "baseline_close": {"p05": round(-1.2 * fc.atr_pct, 3), "p95": round(1.2 * fc.atr_pct, 3)},
            }

        plan_set, evidence = {}, {}
        for kind in plans.KINDS:
            raw = st.levels[kind].iloc[i]
            if not np.isfinite(raw["entry"]):
                continue
            lv = plans.round_plan(raw.to_dict(), kind, self.mcfg)
            if kind == "gap_reversal":
                lv["floor"] = plans.round_tick(float(raw["floor"]), "down", self.mcfg)
                lv["stop_distance"] = lv["risk"]
            if fc.ok:
                if kind == "breakout":
                    lv["p_trigger"] = round(fix(fc.touch_up(pct(lv["entry"]))), 3)
                elif kind == "pullback":
                    lv["p_trigger"] = round(fix(fc.touch_down(pct(lv["entry"]))), 3)
                else:
                    lv["p_trigger"] = round(float(np.mean(fc.s_gap <= pct(lv["entry"]))), 3)
                lv["p_t1"] = round(fix(fc.touch_up(pct(lv["t1"]))), 3)
                lv["p_t2"] = round(fix(fc.touch_up(pct(lv["t2"]))), 3)
            plan_set[kind] = lv
            ev = st.evidence[kind].iloc[i]
            evidence[kind] = {"n": int(ev["n"]), "expectancy_r": float(ev["expectancy_r"]),
                              "t_stat": float(ev["t_stat"])}

        pooled = {k: self.pooled_mean(k, as_of) for k in evidence}
        flags = []
        if not fc.ok:
            flags.append("Not enough comparable history for a forecast.")
        decision = decide.choose(evidence, pooled, float(st.turnover_cr[i]), flags, self.mcfg)
        setup = st.setup.iloc[i]

        entry = {
            "symbol": sym, "as_of": as_of.isoformat(),
            "prev": {"open": round(float(row["open"]), 2), "high": round(float(row["high"]), 2),
                     "low": round(float(row["low"]), 2), "close": round(close, 2)},
            "atr": round(atr, 2), "atr_pct": round(atr / close * 100, 3),
            "setup": None if not np.isfinite(setup["setup"]) else float(setup["setup"]),
            "claims": claims, "plans": plan_set, "decision": decision,
            "overnight_z": round(fc.overnight_z, 2),
            "liquidity_tier": costs.liquidity_tier(float(np.nan_to_num(st.turnover_cr[i])), self.ccfg),
            "slippage": float(st.slip[i]),
        }
        if detail:
            entry["forecast"] = fc
            entry["setup_parts"] = {k: round(float(setup[k]), 3) for k in setupscore.PARTS}
            entry["features"] = feat
            entry["rules"] = {}
            for kind in plan_set:
                past = st.sims[kind].iloc[:i]                       # plans made before as_of: all resolved
                stats = backtest.rule_stats(past)
                r = past.loc[past["status"].isin(plans.TRADED), "r"].dropna().values
                stats["monte_carlo"] = backtest.monte_carlo(r, self.mcfg)
                stats["pooled_expectancy_r"] = round(pooled[kind], 4)
                entry["rules"][kind] = stats
        return entry

    def book(self, as_of: date, detail: bool = False) -> dict[str, dict]:
        """Everything the tool publishes for the session after `as_of`."""
        out = {}
        for sym in self.states:
            entry = self.symbol_entry(sym, as_of, detail)
            if entry is not None:
                out[sym] = entry
        return out

    @property
    def last_session(self) -> date:
        return max(st.dates[-1] for st in self.states.values())
