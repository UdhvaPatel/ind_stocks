"""Intraday cost model (PLAN.md 6.5). One code path for backtest, ledger and UI figures."""
from __future__ import annotations

import numpy as np

from . import config


def cost_cfg() -> dict:
    return config.load_yaml("costs.yaml")


def charges(buy_value, sell_value, cfg: dict | None = None):
    """Statutory charges and brokerage in rupees for one round trip (scalars or arrays)."""
    cfg = cfg or cost_cfg()
    buy_value = np.asarray(buy_value, dtype=float)
    sell_value = np.asarray(sell_value, dtype=float)
    b = cfg["brokerage"]
    brokerage = (np.minimum(b["max_per_order"], b["pct_per_order"] * buy_value)
                 + np.minimum(b["max_per_order"], b["pct_per_order"] * sell_value))
    turnover = buy_value + sell_value
    exchange = cfg["exchange_txn"] * turnover
    sebi = cfg["sebi_fee"] * turnover
    stt = cfg["stt_sell"] * sell_value
    stamp = cfg["stamp_duty_buy"] * buy_value
    gst = cfg["gst"] * (brokerage + exchange + sebi)
    return brokerage + exchange + sebi + stt + stamp + gst


def charges_breakdown(buy_value: float, sell_value: float, cfg: dict | None = None) -> dict:
    cfg = cfg or cost_cfg()
    b = cfg["brokerage"]
    brokerage = (min(b["max_per_order"], b["pct_per_order"] * buy_value)
                 + min(b["max_per_order"], b["pct_per_order"] * sell_value))
    turnover = buy_value + sell_value
    parts = {
        "brokerage": brokerage,
        "stt": cfg["stt_sell"] * sell_value,
        "exchange": cfg["exchange_txn"] * turnover,
        "sebi": cfg["sebi_fee"] * turnover,
        "stamp": cfg["stamp_duty_buy"] * buy_value,
    }
    parts["gst"] = cfg["gst"] * (parts["brokerage"] + parts["exchange"] + parts["sebi"])
    parts["total"] = sum(parts.values())
    return {k: round(v, 2) for k, v in parts.items()}


def slippage_per_side(turnover_cr, cfg: dict | None = None):
    """Slippage fraction per side from 20-day average turnover in crore (scalar or array)."""
    cfg = cfg or cost_cfg()
    t = np.asarray(turnover_cr, dtype=float)
    tiers = sorted(cfg["slippage"]["tiers"], key=lambda x: x["min_turnover_cr"])
    out = np.full(t.shape, tiers[0]["per_side"], dtype=float)
    for tier in tiers:
        out = np.where(t >= tier["min_turnover_cr"], tier["per_side"], out)
    return out if out.ndim else float(out)


def liquidity_tier(turnover_cr: float, cfg: dict | None = None) -> int:
    """1 = most liquid. Tier follows the slippage table."""
    cfg = cfg or cost_cfg()
    tiers = sorted(cfg["slippage"]["tiers"], key=lambda x: -x["min_turnover_cr"])
    for n, tier in enumerate(tiers, start=1):
        if turnover_cr >= tier["min_turnover_cr"]:
            return n
    return len(tiers)
