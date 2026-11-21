"""Dalal Desk paper portfolio: pretend money behind the Desk's own plans (config/portfolio.yaml).

Morning (after the plan is in the ledger): `issue(for_date)` turns that session's ledger records
into orders for each book and appends them to data/portfolio/orders-YYYY-MM.jsonl, before 09:15
IST, with the same verification as the prediction ledger.

Evening and weekly: `summary(engine)` scores every book from the plan outcomes the scorer already
computed (data/scores: fill and exit per plan, after slippage) at the book's own share counts and
charges, adds the comparison lines, and writes data/portfolio.json. Nothing is kept as state apart
from the order ledger; the summary is rebuilt from it every time.
"""
from __future__ import annotations

import json
import math
from datetime import date, datetime, timezone

from . import config, costs, ledger, publish
from .decide import FAVOURABLE, NEUTRAL

TRADED = ("stopped", "t1", "t2", "time")
RULES = ("breakout", "pullback", "gap_reversal")


def cfg() -> dict:
    return config.load_yaml("portfolio.yaml")


def orders_dir():
    return config.DATA_DIR / "portfolio"


# ------------------------------------------------------------------ sizing
def size(lv: dict, c: dict) -> int:
    """Whole shares: lose at most `risk_per_trade` at the stop, use at most max_position_pct of capital."""
    try:
        entry, risk = float(lv["entry"]), float(lv.get("risk") or (float(lv["entry"]) - float(lv["stop"])))
    except (KeyError, TypeError, ValueError):
        return 0
    if not (entry > 0 and risk > 0 and math.isfinite(entry) and math.isfinite(risk)):
        return 0
    return max(0, math.floor(min(c["risk_per_trade"] / risk, c["capital"] * c["max_position_pct"] / entry)))


def _shrunk(rec: dict, kind: str) -> float:
    v = ((rec.get("evidence") or {}).get(kind) or {}).get("shrunk_r")
    return float(v) if isinstance(v, (int, float)) and math.isfinite(v) else -9.0


def _fill(cands: list[tuple[dict, str]], c: dict, max_positions: int) -> list[dict]:
    """Take candidates in order, one per stock, while positions and capital allow."""
    out, used, budget = [], set(), float(c["capital"])
    for rec, kind in cands:
        if len(out) >= max_positions or rec["symbol"] in used:
            continue
        lv = (rec.get("plans") or {}).get(kind) or {}
        n = size(lv, c)
        notional = n * float(lv.get("entry") or 0)
        if n <= 0 or notional > budget:
            continue
        budget -= notional
        used.add(rec["symbol"])
        out.append({"symbol": rec["symbol"], "kind": kind, "shares": n, "entry": lv["entry"], "stop": lv["stop"],
                    "t1": lv.get("t1"), "t2": lv.get("t2"), "record_id": rec["id"], "shrunk_r": round(_shrunk(rec, kind), 4)})
    return out


def desk_orders(records: list[dict], c: dict) -> list[dict]:
    """Only plans the tool itself called; best measured record first."""
    cands = [(r, r["call"]["kind"]) for r in records
             if r["call"].get("call") in (FAVOURABLE, NEUTRAL) and r["call"].get("kind") in (r.get("plans") or {})]
    cands.sort(key=lambda x: (-_shrunk(*x), x[0]["symbol"]))
    return _fill(cands, c, c["max_positions"])


def practice_orders(records: list[dict], c: dict) -> list[dict]:
    """The best-recorded plans of each type, whatever the call (to show how the plans behave)."""
    per = int(c["books"]["practice"].get("per_rule", 2))
    cands = []
    for kind in RULES:
        ranked = sorted((r for r in records if kind in (r.get("plans") or {})), key=lambda r: (-_shrunk(r, kind), r["symbol"]))
        cands += [(r, kind) for r in ranked[:per]]
    return _fill(cands, c, per * len(RULES))


def build_orders(records: list[dict], c: dict, extra: dict | None = None) -> dict[str, list[dict]]:
    books = {"desk": desk_orders(records, c), "practice": practice_orders(records, c)}
    books.update(extra or {})
    return books


# ------------------------------------------------------------ order ledger
def load_orders() -> list[dict]:
    out = []
    for path in sorted(orders_dir().glob("orders-*.jsonl")) if orders_dir().exists() else []:
        out += [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    return out


def issue(for_date: date, model_version: str, extra: dict | None = None, now: datetime | None = None) -> int:
    """Write the session's orders once (append-only). Returns the number of order lines written."""
    c = cfg()
    have = {o["id"] for o in load_orders()}
    records = [r for r in ledger.load(for_date, for_date) if r["for_date"] == for_date.isoformat() and r["model_version"] == model_version]
    if not records:
        return 0
    made = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat(timespec="seconds")
    lines = []
    for book, orders in build_orders(records, c, extra).items():
        oid = f"{for_date.isoformat()}|{book}|{c['portfolio_version']}"
        if oid in have:
            continue
        lines.append({"id": oid, "for_date": for_date.isoformat(), "book": book, "portfolio_version": c["portfolio_version"],
                      "model_version": model_version, "made_at": made, "source": ledger.runner_info(), "orders": orders})
    if lines:
        path = orders_dir() / f"orders-{for_date:%Y-%m}.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8", newline="\n") as fh:
            for line in lines:
                fh.write(json.dumps(line, sort_keys=True, separators=(",", ":")) + "\n")
    return len(lines)


# ----------------------------------------------------------------- scoring
def position_result(order: dict, outcome: dict | None, ccfg: dict, scale: float = 1.0) -> dict:
    """Rupee result of one order from the scorer's per-share fill and exit (after slippage)."""
    status = (outcome or {}).get("status") or "pending"
    res = {**order, "status": status, "fill": None, "exit": None, "pnl": 0.0, "charges": 0.0, "deployed": 0.0}
    if status not in TRADED:
        return res
    fill, exit_ = outcome.get("fill"), outcome.get("exit")
    if not isinstance(fill, (int, float)) or not isinstance(exit_, (int, float)):
        res["status"] = "unknown"
        return res
    n = order["shares"]
    charge = float(costs.charges(n * fill, n * exit_, ccfg))
    res.update({"fill": fill, "exit": exit_, "charges": round(charge * scale, 2),
                "pnl": round((n * (exit_ - fill) - charge) * scale, 2), "deployed": round(n * fill * scale, 2)})
    return res


def score_line(line: dict, scores: dict, ccfg: dict) -> dict | None:
    """One book on one session, or None while the session is not scored yet."""
    positions = []
    for o in line["orders"]:
        s = scores.get(o["record_id"])
        if s is None:
            return None
        positions.append(position_result(o, (s.get("plans") or {}).get(o["kind"]) if s.get("status") == "scored" else {"status": "void"}, ccfg))
    rec_ok = all(scores[o["record_id"]].get("verified") for o in line["orders"]) if line["orders"] else True
    verified = ledger.verified(line) and rec_ok
    traded = [p for p in positions if p["status"] in TRADED]
    return {"date": line["for_date"], "verified": verified, "reserved": round(sum(p["shares"] * float(p["entry"]) for p in positions), 2),
            "deployed": round(sum(p["deployed"] for p in positions), 2), "pnl": round(sum(p["pnl"] for p in positions), 2),
            "charges": round(sum(p["charges"] for p in positions), 2), "trades": len(traded),
            "wins": sum(1 for p in traded if p["pnl"] > 0), "positions": positions}


def every_plan_day(day: str, scores: dict, c: dict, ccfg: dict) -> dict | None:
    """Benchmark: every plan of every stock, same sizing, scaled down to the capital."""
    items = [s for s in scores.values() if s["for_date"] == day and s.get("status") == "scored"]
    if not items:
        return None
    positions = []
    for s in items:
        for kind, outcome in (s.get("plans") or {}).items():
            lv = (s.get("plan_levels") or {}).get(kind) or {}
            n = size(lv, c)
            if n:
                positions.append(({"symbol": s["symbol"], "kind": kind, "shares": n, "entry": lv["entry"]}, outcome))
    reserved = sum(o["shares"] * float(o["entry"]) for o, _ in positions)
    scale = min(1.0, c["capital"] / reserved) if reserved else 1.0
    res = [position_result(o, out, ccfg, scale) for o, out in positions]
    traded = [p for p in res if p["status"] in TRADED]
    return {"date": day, "pnl": round(sum(p["pnl"] for p in res), 2), "deployed": round(sum(p["deployed"] for p in res), 2),
            "trades": len(traded), "wins": sum(1 for p in traded if p["pnl"] > 0), "scale": round(scale, 4)}


def nifty_lines(nifty, days: list[str], c: dict, ccfg: dict) -> dict:
    """Nifty 50 held from the first day (delivery costs once) and day-traded open to close each day."""
    if nifty is None or not len(days):
        return {"hold": [], "day": []}
    from .research import delivery_cost_pct
    df = nifty
    idx = {d.isoformat(): k for k, d in enumerate(df.index)}
    hold, day_ = [], []
    first = idx.get(days[0])
    if first is None or first == 0:
        return {"hold": [], "day": []}
    start = float(df["close"].iloc[first - 1])
    entry_cost = delivery_cost_pct(ccfg["slippage"]["tiers"][0]["per_side"], {**ccfg, **config.load_yaml("costs.yaml")}) * c["capital"]
    for d in days:
        k = idx.get(d)
        if k is None:
            continue
        close, open_ = float(df["close"].iloc[k]), float(df["open"].iloc[k])
        hold.append({"date": d, "value": round(c["capital"] * (close / start - 1) - entry_cost, 2)})
        cap = c["capital"]
        day_.append({"date": d, "pnl": round(cap * (close / open_ - 1) - float(costs.charges(cap, cap * close / open_, ccfg)), 2)})
    return {"hold": hold, "day": day_}


def totals(days: list[dict]) -> dict:
    v = [d for d in days if d.get("verified", True)]
    return {"sessions": len(v), "pnl": round(sum(d["pnl"] for d in v), 2), "deployed": round(sum(d["deployed"] for d in v), 2),
            "trades": sum(d["trades"] for d in v), "wins": sum(d["wins"] for d in v),
            "idle_sessions": sum(1 for d in v if d["trades"] == 0),
            "best_day": max((d["pnl"] for d in v), default=None), "worst_day": min((d["pnl"] for d in v), default=None)}


def replay_preview(day_root, nifty, c: dict, ccfg: dict, last_n: int = 60) -> dict:
    """Context only: what the Desk book would have done over recent backtest days (from the day pages)."""
    days = []
    for path in sorted(day_root.glob("*/summary.json"))[-last_n:]:
        try:
            page = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if page.get("track") != "backtest":
            continue
        recs = []
        for row in page.get("rows", []):
            plan, call = row.get("plan") or {}, row.get("call") or {}
            if row.get("status") != "scored" or call.get("call") not in (FAVOURABLE, NEUTRAL) or plan.get("kind") != call.get("kind"):
                continue
            recs.append(({"symbol": row["symbol"], "kind": plan["kind"], "levels": plan.get("levels") or {}}, plan.get("outcome") or {}))
        picked, used, budget = [], set(), float(c["capital"])
        for o, out in recs[:]:
            n = size(o["levels"], c)
            notional = n * float(o["levels"].get("entry") or 0)
            if len(picked) >= c["max_positions"] or o["symbol"] in used or n <= 0 or notional > budget:
                continue
            budget -= notional
            used.add(o["symbol"])
            picked.append(position_result({"symbol": o["symbol"], "kind": o["kind"], "shares": n, "entry": o["levels"]["entry"]}, out, ccfg))
        traded = [p for p in picked if p["status"] in TRADED]
        days.append({"date": page["date"], "pnl": round(sum(p["pnl"] for p in picked), 2), "deployed": round(sum(p["deployed"] for p in picked), 2),
                     "trades": len(traded), "wins": sum(1 for p in traded if p["pnl"] > 0)})
    nl = nifty_lines(nifty, [d["date"] for d in days], c, ccfg) if days else {"hold": [], "day": []}
    return {"label": "Test replay (not live)", "days": days, "totals": totals(days), "nifty_day": nl["day"],
            "note": "What the same rules would have done on recent past days, replayed by the same code using only "
                    "the data available before each day. Daily bars, conservative fills. Not evidence of skill."}


def summary(engine, scores: dict, allocator: dict | None = None) -> dict:
    c = cfg()
    ccfg = engine.ccfg
    version = c["portfolio_version"]
    lines = [o for o in load_orders() if o.get("portfolio_version") == version]
    books = {}
    for book in sorted({o["book"] for o in lines} | {"desk", "practice"}):
        days = [d for d in (score_line(o, scores, ccfg) for o in sorted(lines, key=lambda x: x["for_date"]) if o["book"] == book) if d]
        meta = c["books"].get(book, {})
        books[book] = {"label": meta.get("label", book), "note": meta.get("note", ""), "days": days, "totals": totals(days)}
    pending = sorted({o["for_date"] for o in lines} - {d["date"] for b in books.values() for d in b["days"]})
    desk_days = [d["date"] for d in books["desk"]["days"]]
    every = [x for x in (every_plan_day(d, scores, c, ccfg) for d in desk_days) if x]
    nifty = engine.ds.indices.get("NIFTY50") if hasattr(engine.ds, "indices") else None
    nl = nifty_lines(nifty, desk_days, c, ccfg)
    verified = [d for d in books["desk"]["days"] if d["verified"]]
    return {**publish.stamp(engine.mcfg["model_version"]), "portfolio_version": version, "first_day": str(c["first_day"]),
            "capital": c["capital"], "risk_per_trade": c["risk_per_trade"], "max_positions": c["max_positions"],
            "verified_sessions": len(verified), "min_days_for_verdict": c["min_days_for_verdict"], "pending": pending,
            "books": books,
            "benchmarks": {"cash": {"label": "Doing nothing", "pnl": 0.0},
                           "every_plan": {"label": "Every plan, scaled to ₹1,00,000", "days": every, "totals": totals(every)},
                           "nifty_hold": {"label": "Nifty 50 bought on day one and held", "days": nl["hold"]},
                           "nifty_day": {"label": "Nifty 50 bought at each open, sold at each close", "days": nl["day"],
                                         "pnl": round(sum(x["pnl"] for x in nl["day"]), 2)}},
            "replay": replay_preview(config.DATA_DIR / "days", nifty, c, ccfg),
            "allocator": allocator}
