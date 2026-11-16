"""Phase 1 tests: parsers, split adjustment, calendar, cross-validation, storage."""
from datetime import date

import pandas as pd
import pytest

from pipeline import clean, fetch_nse, fetch_yahoo, ingest, store, validate
from pipeline.tradingcal import TradingCalendar

SEC = """SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER
RELIANCE, EQ, 13-Nov-2026, 1339.70, 1336.60, 1350.70, 1324.00, 1339.70, 1339.70, 1338.10, 13756247, 184072.11, 207960, 6440327, 46.82
21STCENMGM, BE, 13-Nov-2026, 55.04, 55.04, 55.90, 54.00, 54.10, 54.10, 54.55, 6389, 3.49, 57, -, -
TCS, EQ, 13-Nov-2026, 3000.00, 3010.00, 3050.00, 2990.00, 2995.00, 2994.00, 3015.00, 1000000, 30150.00, 50000, 600000, 60.00
"""

IDX = """Index Name,Index Date,Open Index Value,High Index Value,Low Index Value,Closing Index Value,Points Change,Change(%),Volume,Turnover (Rs. Cr.),P/E,P/B,Div Yield
Nifty 50,13-11-2026,25209.85,25246.35,25054.4,25144.3,-155.05,-.61,239573267,25397.2,20.49,3.08,1.4
India VIX,13-11-2026,16.6175,16.875,15.3025,15.5,-1.12,-6.75,-,-,-,-,-
"""


def _yahoo_result(ts, closes, splits=None, offset=19800):
    quote = {"open": closes, "high": [c * 1.01 if c else None for c in closes],
             "low": [c * 0.99 if c else None for c in closes], "close": closes,
             "volume": [1000 if c else None for c in closes]}
    res = {"meta": {"gmtoffset": offset}, "timestamp": ts,
           "indicators": {"quote": [quote], "adjclose": [{"adjclose": closes}]}}
    if splits:
        res["events"] = {"splits": {str(s["date"]): s for s in splits}}
    return res


# ------------------------------------------------------------------- parsers
def test_parse_sec_bhav_handles_spaces_and_dashes():
    df = fetch_nse.parse_sec_bhav(SEC)
    rel = df[df.symbol == "RELIANCE"].iloc[0]
    assert rel["date"] == date(2026, 11, 13)
    assert rel["close"] == 1339.70 and rel["prev_close"] == 1339.70
    assert rel["deliv_pct"] == 46.82
    assert rel["turnover"] == pytest.approx(184072.11e5, rel=1e-9)
    be = df[df.symbol == "21STCENMGM"].iloc[0]
    assert pd.isna(be["deliv_pct"]) and pd.isna(be["deliv_qty"])


def test_parse_index_close():
    df = fetch_nse.parse_index_close(IDX)
    nifty = df[df["index"] == "Nifty 50"].iloc[0]
    assert nifty["close"] == 25144.3 and nifty["pe"] == 20.49
    vix = df[df["index"] == "India VIX"].iloc[0]
    assert vix["close"] == 15.5 and pd.isna(vix["pe"])


class _FakeHttp:
    def __init__(self, text):
        self.text = text

    def get(self, url, params=None):
        if self.text is None:
            return None
        return type("R", (), {"text": self.text})()


def test_holiday_file_with_previous_date_is_rejected():
    # NSE serves the previous session's rows on a holiday: must not be accepted.
    assert fetch_nse.fetch_sec_bhav(_FakeHttp(SEC), date(2026, 11, 14)) is None
    assert fetch_nse.fetch_sec_bhav(_FakeHttp(SEC), date(2026, 11, 13)) is not None
    assert fetch_nse.fetch_sec_bhav(_FakeHttp(None), date(2026, 11, 13)) is None
    assert fetch_nse.fetch_sec_bhav(_FakeHttp("<html>Access Denied</html>"), date(2026, 11, 13)) is None


def test_parse_yahoo_daily_drops_null_rows_and_reads_splits():
    # 2024-10-25 03:45 UTC, then +1 day steps; one null bar in the middle.
    t0 = 1729827900
    ts = [t0, t0 + 86400, t0 + 3 * 86400, t0 + 4 * 86400]
    res = _yahoo_result(ts, [100.0, None, 102.0, 103.0],
                        splits=[{"date": t0 + 3 * 86400, "numerator": 2.0, "denominator": 1.0}])
    df, events = fetch_yahoo.parse_daily(res)
    assert len(df) == 3 and df.index[0] == date(2024, 10, 25)
    assert events["splits"] == [{"date": "2024-10-28", "ratio": 2.0}]


def test_parse_intraday_uses_exchange_time():
    res = _yahoo_result([1794541500, 1794541800], [100.0, 101.0])   # 09:15 and 09:20 IST
    df = fetch_yahoo.parse_intraday(res)
    assert df["ts"].iloc[0].strftime("%H:%M") == "09:15"
    assert df["ts"].iloc[1].strftime("%H:%M") == "09:20"


# --------------------------------------------------------- split adjustment
def test_split_factor_applies_only_before_the_split():
    dates = [date(2024, 10, 24), date(2024, 10, 25), date(2024, 10, 28), date(2024, 10, 29)]
    f = clean.split_factor(dates, [{"date": "2024-10-28", "ratio": 2.0}])
    assert list(f) == [2.0, 2.0, 1.0, 1.0]


def test_split_day_shows_no_fake_crash():
    dates = [date(2024, 10, 24), date(2024, 10, 25), date(2024, 10, 28), date(2024, 10, 29)]
    events = {"splits": [{"date": "2024-10-28", "ratio": 2.0}]}
    # Official prices halve on the bonus day (2700 -> 1340); adjusted ones must not.
    nse = pd.DataFrame({
        "date": dates, "open": [2700, 2690, 1340, 1345], "high": [2720, 2710, 1350, 1360],
        "low": [2680, 2670, 1330, 1340], "close": [2700.0, 2680.0, 1340.0, 1350.0],
        "prev_close": [2690.0, 2700.0, 1340.0, 1340.0], "vwap": [2700, 2690, 1340, 1350],
        "volume": [100, 100, 200, 200], "turnover": [1, 1, 1, 1], "trades": [1, 1, 1, 1],
        "deliv_qty": [50, 50, 100, 100], "deliv_pct": [50, 50, 50, 50]})
    frame, issues = clean.build_symbol_frame(None, events, nse)
    rets = frame["close"].pct_change().dropna()
    assert rets.abs().max() < 0.02
    assert frame.loc[date(2024, 10, 25), "close"] == 1340.0
    assert frame.loc[date(2024, 10, 25), "nse_close"] == 2680.0
    assert frame.loc[date(2024, 10, 25), "volume"] == 200
    assert not issues


def test_official_prices_win_and_newer_nse_session_is_appended():
    d1, d2, d3 = date(2026, 11, 11), date(2026, 11, 12), date(2026, 11, 13)
    yahoo = pd.DataFrame({"open": [10.0, 11.0], "high": [10.5, 11.5], "low": [9.5, 10.5],
                          "close": [10.2, 11.2], "adjclose": [10.2, 11.2],
                          "volume": [100, 100]}, index=[d1, d2])
    nse = pd.DataFrame({"date": [d2, d3], "open": [11.0, 11.3], "high": [11.6, 11.9],
                        "low": [10.5, 11.1], "close": [11.21, 11.8], "prev_close": [10.2, 11.21],
                        "vwap": [11.1, 11.5], "volume": [120, 130], "turnover": [1, 1],
                        "trades": [1, 1], "deliv_qty": [60, 65], "deliv_pct": [50.0, 50.0]})
    frame, _ = clean.build_symbol_frame(yahoo, {"splits": []}, nse)
    assert list(frame.index) == [d1, d2, d3]
    assert frame.loc[d2, "close"] == 11.21 and frame.loc[d2, "source"] == "nse+yahoo"
    assert frame.loc[d3, "close"] == 11.8 and frame.loc[d3, "source"] == "nse"
    assert frame.loc[d1, "source"] == "yahoo" and pd.isna(frame.loc[d1, "deliv_pct"])


def test_clean_bars_repairs_and_drops():
    idx = [date(2026, 1, d) for d in (5, 6, 7, 8)]
    df = pd.DataFrame({"open": [10, 10, 10, 0], "high": [9, 10, 11, 10], "low": [9.5, 10, 9, 9],
                       "close": [10.5, 10, 10, 10], "volume": [100, 0, 100, 100]}, index=idx)
    out, issues = clean.clean_bars(df)
    kinds = {i["issue"] for i in issues}
    assert kinds == {"high_low_inconsistent", "flat_zero_volume_bar", "missing_or_nonpositive_price"}
    assert list(out.index) == [idx[0], idx[2]]
    assert out.loc[idx[0], "high"] == 10.5 and out.loc[idx[0], "low"] == 9.5


# ------------------------------------------------------------------ calendar
def test_calendar_uses_data_then_rules():
    cal = TradingCalendar(open_days=[date(2026, 11, 9), date(2026, 11, 13)],
                          closed_days=[date(2026, 11, 10)],
                          holidays=[date(2026, 11, 24)], special_sessions=[date(2026, 11, 21)])
    assert not cal.is_trading_day(date(2026, 11, 10))          # confirmed holiday
    assert not cal.is_trading_day(date(2026, 11, 14))          # Saturday
    assert cal.is_trading_day(date(2026, 11, 21))              # special Saturday session
    assert cal.next_trading_day(date(2026, 11, 13)) == date(2026, 11, 16)
    assert cal.next_trading_day(date(2026, 11, 23)) == date(2026, 11, 25)
    assert cal.prev_trading_day(date(2026, 11, 11)) == date(2026, 11, 9)


# ---------------------------------------------------------- cross-validation
def test_cross_check_flags_disagreement_and_respects_splits():
    dates = [date(2024, 10, 24), date(2024, 10, 25), date(2024, 10, 28), date(2024, 10, 29)]
    events = {"splits": [{"date": "2024-10-28", "ratio": 2.0}]}
    yahoo = pd.DataFrame({"close": [1350.0, 1340.0, 1340.0, 1400.0]}, index=dates)
    nse = pd.DataFrame({"date": dates, "close": [2700.0, 2680.0, 1340.0, 1350.0]})
    rep = validate.cross_check("X", yahoo, events, nse)
    assert rep["compared"] == 4 and rep["agree"] == 3
    assert [d["date"] for d in rep["disagreements"]] == ["2024-10-29"]
    assert validate.summarise([rep])["disagreements_over_0_5_pct"] == 1


# ------------------------------------------------------------------- storage
def test_ingest_archives_tracked_symbols_and_breadth(tmp_vault, monkeypatch):
    store.save_tracked_symbols(["RELIANCE"])
    monkeypatch.setattr(fetch_nse, "fetch_sec_bhav", lambda http, d: fetch_nse.parse_sec_bhav(SEC))
    monkeypatch.setattr(fetch_nse, "fetch_index_close", lambda http, d: fetch_nse.parse_index_close(IDX))
    d = date(2026, 11, 13)
    assert ingest.ingest_nse_day(None, d) == "saved"
    assert ingest.ingest_nse_day(None, d) == "exists"            # idempotent
    eod = store.load_nse_eod()
    assert list(eod["symbol"]) == ["RELIANCE"]                   # TCS not tracked, BE dropped
    breadth = store.load_breadth().iloc[0]
    assert (breadth["advances"], breadth["declines"], breadth["unchanged"]) == (0, 1, 1)
    assert store.open_days() == [d]
    assert len(store.load_idx()) == 2


def test_closed_days_roundtrip(tmp_vault):
    store.add_closed_days([date(2026, 11, 10)])
    store.add_closed_days([date(2026, 10, 20)])
    assert store.closed_days() == {date(2026, 11, 10), date(2026, 10, 20)}
