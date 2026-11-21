"""A vendor bar for an Indian session that is still trading must never be used as a close.

Regression: a run at 09:56 IST took Yahoo's 40-minute-old bar for that day as the
day's result and published a scored "session" for it.
"""
from datetime import date, datetime, time

import pandas as pd

from pipeline import config, dataset


def _at(monkeypatch, d: date, t: time):
    monkeypatch.setattr(config, "now_ist", lambda: datetime.combine(d, t, tzinfo=config.IST))


def _bars():
    idx = [date(2026, 11, 12), date(2026, 11, 13), date(2026, 11, 16), date(2026, 11, 17)]
    return pd.DataFrame({"close": [1.0, 2.0, 3.0, 4.0]}, index=idx)


def test_last_finished_session_day():
    at = lambda t: datetime.combine(date(2026, 11, 16), t, tzinfo=config.IST)
    assert config.last_finished_session_day(at(time(9, 56))) == date(2026, 11, 15)
    assert config.last_finished_session_day(at(time(15, 44))) == date(2026, 11, 15)
    assert config.last_finished_session_day(at(time(15, 45))) == date(2026, 11, 16)
    assert config.last_finished_session_day(at(time(21, 55))) == date(2026, 11, 16)
    us_central_evening = datetime(2026, 11, 15, 22, 26, tzinfo=config.timezone(config.timedelta(hours=-6)))
    assert config.last_finished_session_day(us_central_evening) == date(2026, 11, 15)   # 09:56 IST next day


def test_todays_bar_is_dropped_during_market_hours(monkeypatch):
    _at(monkeypatch, date(2026, 11, 16), time(9, 56))
    out = dataset.finished_only(_bars())
    assert list(out.index) == [date(2026, 11, 12), date(2026, 11, 13)]


def test_todays_bar_is_kept_after_the_close_but_future_rows_never(monkeypatch):
    _at(monkeypatch, date(2026, 11, 16), time(18, 30))
    out = dataset.finished_only(_bars())
    assert out.index[-1] == date(2026, 11, 16)


def test_empty_input_is_passed_through():
    assert dataset.finished_only(None) is None
    empty = pd.DataFrame({"close": []})
    assert dataset.finished_only(empty) is empty
