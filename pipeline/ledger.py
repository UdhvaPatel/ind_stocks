"""Append-only prediction ledger (PLAN.md 7.1).

One JSON line per stock per session, written before the market opens and
committed to git: the commit time is the tamper-evident timestamp. Lines are
only ever appended. A record that already exists is never rewritten, so a
re-run of the morning job is harmless.
"""
from __future__ import annotations

import hashlib
import json
import os
from datetime import date, datetime, timezone
from pathlib import Path

from . import config
from .config import IST

LEDGER_SCHEMA = 1


def ledger_dir() -> Path:
    return config.DATA_DIR / "ledger"


def month_path(d: date) -> Path:
    return ledger_dir() / f"predictions-{d:%Y-%m}.jsonl"


def record_id(for_date: date, symbol: str, model_version: str) -> str:
    return f"{for_date.isoformat()}|{symbol}|{model_version}"


def data_hash(entry: dict) -> str:
    """Fingerprint of the inputs a record was built from."""
    blob = json.dumps({"as_of": entry["as_of"], "prev": entry["prev"], "atr": entry["atr"],
                       "overnight_z": entry["overnight_z"]}, sort_keys=True)
    return hashlib.sha1(blob.encode()).hexdigest()[:16]


def make_record(entry: dict, for_date: date, model_version: str,
                made_at: datetime | None = None, vix: float | None = None) -> dict:
    """Turn one engine book entry into an immutable ledger record."""
    made_at = made_at or datetime.now(timezone.utc)
    d = entry["decision"]
    return {
        "schema": LEDGER_SCHEMA,
        "id": record_id(for_date, entry["symbol"], model_version),
        "symbol": entry["symbol"],
        "for_date": for_date.isoformat(),
        "as_of": entry["as_of"],
        "made_at": made_at.astimezone(timezone.utc).isoformat(timespec="seconds"),
        "model_version": model_version,
        "data_hash": data_hash(entry),
        "inputs": {"prev": entry["prev"], "atr": entry["atr"], "setup": entry["setup"],
                   "overnight_z": entry["overnight_z"], "vix": vix,
                   "slippage": entry["slippage"]},
        "claims": entry["claims"],
        "plans": entry["plans"],
        "call": {"call": d["call"], "kind": d["kind"], "reference_kind": d["reference_kind"],
                 "label": d["label"]},
        # Where the record was made. Only records made by the scheduled GitHub workflow can be
        # checked independently (its run log and commit), so only those count as verified live.
        "source": runner_info(),
    }


def runner_info() -> dict:
    on_actions = os.environ.get("GITHUB_ACTIONS") == "true"
    return {"runner": "github-actions" if on_actions else "local",
            "run_id": os.environ.get("GITHUB_RUN_ID") if on_actions else None,
            "repository": os.environ.get("GITHUB_REPOSITORY") if on_actions else None}


OPEN_IST = (9, 15)


def made_before_open(record: dict) -> bool:
    """True when the record's own timestamp is before 09:15 IST on the session it is for."""
    try:
        made = datetime.fromisoformat(record["made_at"]).astimezone(IST)
        day = date.fromisoformat(record["for_date"])
    except (KeyError, ValueError, TypeError):
        return False
    return made < datetime(day.year, day.month, day.day, *OPEN_IST, tzinfo=IST)


def verified(record: dict) -> bool:
    """Counts as live evidence: made by the scheduled workflow, before the open."""
    return made_before_open(record) and (record.get("source") or {}).get("runner") == "github-actions"


def _line(record: dict) -> str:
    return json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def read_month(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with open(path, encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def append(records: list[dict]) -> int:
    """Append records that are not in the ledger yet. Returns how many were written."""
    written = 0
    by_month: dict[Path, list[dict]] = {}
    for rec in records:
        by_month.setdefault(month_path(date.fromisoformat(rec["for_date"])), []).append(rec)
    for path, recs in by_month.items():
        existing = {r["id"] for r in read_month(path)}
        new = [r for r in sorted(recs, key=lambda r: r["id"]) if r["id"] not in existing]
        if not new:
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8", newline="\n") as fh:
            for rec in new:
                fh.write(_line(rec) + "\n")
        written += len(new)
    return written


def load(start: date | None = None, end: date | None = None) -> list[dict]:
    """All ledger records with for_date in [start, end]."""
    out = []
    for path in sorted(ledger_dir().glob("predictions-*.jsonl")):
        for rec in read_month(path):
            d = date.fromisoformat(rec["for_date"])
            if (start is None or d >= start) and (end is None or d <= end):
                out.append(rec)
    return out


def has_plan_for(for_date: date, model_version: str) -> bool:
    return any(r["for_date"] == for_date.isoformat() and r["model_version"] == model_version
               for r in read_month(month_path(for_date)))


def fingerprint() -> dict[str, str]:
    """SHA-1 of every existing ledger line, to prove later runs changed none of them."""
    out = {}
    for path in sorted(ledger_dir().glob("predictions-*.jsonl")):
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                if line.strip():
                    out[json.loads(line)["id"]] = hashlib.sha1(line.strip().encode()).hexdigest()
    return out
