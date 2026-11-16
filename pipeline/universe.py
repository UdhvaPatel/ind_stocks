"""The stock universe: which symbols get a plan, and which are archived."""
from __future__ import annotations

import json

import pandas as pd

from . import config, fetch_nse, store
from .http import Http


def fetch_lists(http: Http) -> dict[str, pd.DataFrame]:
    cfg = config.universe_cfg()
    names = list(dict.fromkeys(cfg["plan_lists"] + cfg["tracked_lists"]))
    return {name: fetch_nse.fetch_constituents(http, cfg["list_files"][name]) for name in names}


def refresh_universe(http: Http) -> dict:
    """Download constituent lists, update tracked symbols, write data/universe.json."""
    cfg = config.universe_cfg()
    lists = fetch_lists(http)

    tracked = sorted({s for name in cfg["tracked_lists"] for s in lists[name]["symbol"]})
    store.save_tracked_symbols(tracked)

    seen, stocks = set(), []
    for name in cfg["plan_lists"]:
        for row in lists[name].itertuples(index=False):
            if row.symbol in seen:
                continue
            seen.add(row.symbol)
            stocks.append({"symbol": row.symbol, "name": row.name, "industry": row.industry,
                           "isin": row.isin, "list": name})
    stocks.sort(key=lambda s: s["symbol"])

    universe = {
        "schema": 1,
        "generated_at": config.now_ist().isoformat(timespec="seconds"),
        "stocks": stocks,
        "indices": [{"key": k, "label": v["label"]} for k, v in cfg["indices"].items()],
    }
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    (config.DATA_DIR / "universe.json").write_text(
        json.dumps(universe, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    return universe


def load_universe() -> dict:
    return json.loads((config.DATA_DIR / "universe.json").read_text(encoding="utf-8"))


def plan_symbols() -> list[str]:
    return [s["symbol"] for s in load_universe()["stocks"]]
