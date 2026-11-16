"""NSE trading calendar, built from data rather than from "Monday to Friday".

Past: a day is a session if an official file exists for it, and a confirmed
non-session if it is in the vault's closed-days list.
Future: weekdays minus the committed holiday list, plus announced special sessions.
"""
from __future__ import annotations

from datetime import date, timedelta

from . import config, store


def _as_date(value) -> date:
    return value if isinstance(value, date) else date.fromisoformat(str(value))


class TradingCalendar:
    def __init__(self, open_days=(), closed_days=(), holidays=(), special_sessions=()):
        self.open_days = set(open_days)
        self.closed_days = set(closed_days)
        self.holidays = set(holidays)
        self.special = set(special_sessions)
        self.last_known = max(self.open_days) if self.open_days else None

    @classmethod
    def load(cls) -> "TradingCalendar":
        cfg = config.load_yaml("holidays.yaml")
        holidays = [_as_date(h["date"]) for h in cfg.get("holidays") or []]
        special = [_as_date(s["date"] if isinstance(s, dict) else s)
                   for s in cfg.get("special_sessions") or []]
        return cls(store.open_days(), store.closed_days(), holidays, special)

    def is_trading_day(self, d: date) -> bool:
        if d in self.open_days:
            return True
        if d in self.closed_days:
            return False
        if d in self.special:
            return True
        return d.weekday() < 5 and d not in self.holidays

    def next_trading_day(self, d: date) -> date:
        """First trading day strictly after d."""
        nxt = d + timedelta(days=1)
        for _ in range(30):
            if self.is_trading_day(nxt):
                return nxt
            nxt += timedelta(days=1)
        raise RuntimeError(f"no trading day found within 30 days after {d}")

    def prev_trading_day(self, d: date) -> date:
        """Last trading day strictly before d."""
        prv = d - timedelta(days=1)
        for _ in range(30):
            if self.is_trading_day(prv):
                return prv
            prv -= timedelta(days=1)
        raise RuntimeError(f"no trading day found within 30 days before {d}")

    def sessions_between(self, start: date, end: date) -> list[date]:
        """Trading days in [start, end]."""
        out, d = [], start
        while d <= end:
            if self.is_trading_day(d):
                out.append(d)
            d += timedelta(days=1)
        return out
