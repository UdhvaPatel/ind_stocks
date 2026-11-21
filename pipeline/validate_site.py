"""Check the published files before they are committed. Exit 1 lists every problem.

    python -m pipeline.validate_site

Run by the workflow after each job and before the commit, so a broken or half-written
publish is never committed or deployed (the run fails and GitHub emails the owner).
"""
from __future__ import annotations

import json
import math
import sys

from . import config


def _load(rel: str, problems: list[str]):
    path = config.DATA_DIR / rel
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        problems.append(f"{rel}: missing")
    except ValueError as exc:
        problems.append(f"{rel}: not valid JSON ({exc})")
    return None


def finite(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def check() -> list[str]:
    problems: list[str] = []
    meta = _load("meta.json", problems)
    if not meta:
        return problems
    for key in ("schema", "model_version", "generated_at", "last_eod_date", "plan_for_date", "symbols"):
        if key not in meta:
            problems.append(f"meta.json: no '{key}'")
    symbols = meta.get("symbols") or []
    if len(symbols) < 40:
        problems.append(f"meta.json: only {len(symbols)} symbols")
    if meta.get("plan_for_date", "") <= meta.get("last_eod_date", ""):
        problems.append("meta.json: plan_for_date is not after last_eod_date")

    usable = 0
    for sym in symbols:
        name = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in sym)
        f = _load(f"symbols/{name}.json", problems)
        if not f:
            continue
        if not finite((f.get("last") or {}).get("close")) or f["last"]["close"] <= 0:
            problems.append(f"symbols/{name}.json: no valid last close")
        good = [k for k, card in (f.get("plans") or {}).items()
                if card and all(finite((card.get("levels") or {}).get(x)) for x in ("entry", "stop", "t1"))]
        usable += bool(good)
        if f.get("as_of") != meta.get("last_eod_date"):
            problems.append(f"symbols/{name}.json: as_of {f.get('as_of')} differs from meta {meta.get('last_eod_date')}")
    if symbols and usable < 0.9 * len(symbols):
        problems.append(f"only {usable} of {len(symbols)} stocks have usable plan levels")

    planner = _load("planner.json", problems)
    if planner and len(planner.get("stocks") or []) < 0.9 * len(symbols):
        problems.append(f"planner.json: only {len(planner.get('stocks') or [])} stocks")

    compare = _load("compare.json", problems)
    if compare:
        cols = compare.get("cols") or []
        for sym, rows in (compare.get("stocks") or {}).items():
            if cols and any(len(r) != len(cols) for r in rows):
                problems.append(f"compare.json: {sym} rows do not match the {len(cols)} named columns")
                break
        if len(compare.get("days") or []) != len(compare.get("daily") or []):
            problems.append("compare.json: days and daily scores differ in length")
        folder = config.DATA_DIR / "compare"
        for sym in compare.get("stocks") or {}:
            name = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in sym)
            if not (folder / f"{name}.json").exists():
                problems.append(f"compare/{name}.json: missing")

    port_path = config.DATA_DIR / "portfolio.json"
    if port_path.exists():
        port = _load("portfolio.json", problems)
        if port is not None:
            for key in ("portfolio_version", "books", "benchmarks", "capital"):
                if key not in port:
                    problems.append(f"portfolio.json: no '{key}'")
            for name, book in (port.get("books") or {}).items():
                for d in book.get("days", []):
                    if d.get("deployed", 0) > port.get("capital", 1e18) * 1.01:      # fills include slippage
                        problems.append(f"portfolio.json: {name} on {d.get('date')} put more than the capital to work")
                        break

    ids = set()
    for path in sorted((config.DATA_DIR / "ledger").glob("*.jsonl")):
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                problems.append(f"{path.name}:{n}: not valid JSON")
                continue
            if rec.get("id") in ids:
                problems.append(f"{path.name}:{n}: duplicate id {rec.get('id')}")
            ids.add(rec.get("id"))
    return problems


def main() -> None:
    problems = check()
    if problems:
        print("The published files failed validation; nothing will be committed:")
        for p in problems[:50]:
            print(" -", p)
        sys.exit(1)
    print("published files look valid")


if __name__ == "__main__":
    main()
