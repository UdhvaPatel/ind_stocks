"""Walk-forward history (PLAN.md 7.5): the same engine replayed over past sessions.

For every past session the engine builds the book it would have published that
morning, using only data available then, and the book is scored against what
happened. This fills the "previous page" on day one. It is always labelled
"Backtest (not live)": the stock list is today's Nifty 50 (survivorship bias),
plan outcomes use daily bars with conservative fills, and prices are adjusted
for corporate actions that happened later.
"""
from __future__ import annotations

from datetime import date

from . import ledger, score
from .engine import Engine


def sessions(engine: Engine) -> list[date]:
    days = set()
    for st in engine.states.values():
        days.update(st.dates)
    return sorted(days)


def replay(engine: Engine, start: date, end: date, model_version: str, log=None) -> list[dict]:
    """Scores for every session in [start, end]. Each score carries its record's key fields."""
    days = sessions(engine)
    out = []
    for k in range(len(days) - 1):
        as_of, for_date = days[k], days[k + 1]
        if for_date < start or for_date > end:
            continue
        for sym, st in engine.states.items():
            i = st.pos.get(as_of)
            if i is None or i + 1 >= len(st.dates) or st.dates[i + 1] != for_date:
                continue
            entry = engine.symbol_entry(sym, as_of)
            if entry is None:
                continue
            rec = ledger.make_record(entry, for_date, model_version)
            bar = st.df.iloc[i + 1][["open", "high", "low", "close"]].to_dict()
            s = score.resolve(rec, bar, cost_cfg=engine.ccfg)
            s["setup"] = entry["setup"]
            s["claims"] = rec["claims"]
            s["plan_levels"] = rec["plans"]
            s["evidence"] = rec.get("evidence")                 # the weekly allocator trains on it
            s["prev_close"] = entry["prev"]["close"]
            out.append(s)
        if log and len(out) and k % 100 == 0:
            log(f"  replayed through {for_date} ({len(out)} records)")
    return out
