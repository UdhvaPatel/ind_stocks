"""Cross-validate the two independent end-of-day sources (official NSE vs Yahoo).

Every session where both sources have a close is compared. A disagreement is
recorded, never silently averaged away: the official NSE value is the one used
for scoring, and the flag is published in the data-quality report.
"""
from __future__ import annotations

import pandas as pd

from .clean import empirical_factor

AGREE_TOL = 0.001      # 0.1%: counted as "agrees"
FLAG_TOL = 0.005       # 0.5%: reported as a disagreement


def cross_check(symbol: str, yahoo: pd.DataFrame | None, events: dict,
                nse: pd.DataFrame | None) -> dict:
    """Compare closes for one symbol. `nse` holds that symbol's official rows."""
    report = {"symbol": symbol, "compared": 0, "agree": 0, "agree_pct": None,
              "max_diff_pct": None, "disagreements": [],
              "missing_in_yahoo": [], "missing_in_nse": []}
    if yahoo is None or nse is None or not len(yahoo) or not len(nse):
        report["note"] = "one source unavailable"
        return report

    official = nse.drop_duplicates("date", keep="last").set_index("date")["close"]
    # Convert Yahoo's adjusted close back to traded prices with the measured
    # factor (its event list is incomplete), so only real bad prints are flagged.
    n = nse.drop_duplicates("date", keep="last").set_index("date").sort_index()
    adjm = empirical_factor(n, yahoo["close"])
    vendor = (yahoo["close"].reindex(n.index) * adjm.vendor_factor).dropna()
    report["vendor_adjustment_artefacts"] = [str(d) for d in adjm.artefacts]
    start = max(official.index.min(), vendor.index.min())
    official = official[official.index >= start]
    vendor = vendor[vendor.index >= start]

    both = official.index.intersection(vendor.index)
    diff = (vendor.loc[both] / official.loc[both] - 1.0).abs()
    report["compared"] = int(len(both))
    report["agree"] = int((diff <= AGREE_TOL).sum())
    if len(both):
        report["agree_pct"] = round(100.0 * report["agree"] / len(both), 2)
        report["max_diff_pct"] = round(100.0 * float(diff.max()), 3)
    for d in diff.index[diff > FLAG_TOL]:
        report["disagreements"].append({
            "date": str(d), "nse_close": round(float(official.loc[d]), 2),
            "yahoo_close_unadj": round(float(vendor.loc[d]), 2),
            "diff_pct": round(100.0 * float(diff.loc[d]), 3),
        })
    report["missing_in_yahoo"] = [str(d) for d in official.index.difference(vendor.index)]
    report["missing_in_nse"] = [str(d) for d in vendor.index.difference(official.index)
                                if d <= official.index.max()]
    return report


def summarise(reports: list[dict]) -> dict:
    compared = sum(r["compared"] for r in reports)
    agree = sum(r["agree"] for r in reports)
    return {
        "symbols": len(reports),
        "sessions_compared": compared,
        "agree_within_0_1_pct": round(100.0 * agree / compared, 3) if compared else None,
        "disagreements_over_0_5_pct": sum(len(r["disagreements"]) for r in reports),
        "missing_in_yahoo": sum(len(r["missing_in_yahoo"]) for r in reports),
        "missing_in_nse": sum(len(r["missing_in_nse"]) for r in reports),
        "worst": sorted(
            ({"symbol": r["symbol"], **d} for r in reports for d in r["disagreements"]),
            key=lambda x: -x["diff_pct"])[:25],
    }
