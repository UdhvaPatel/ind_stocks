"""Paths, configuration loading and the IST clock."""
from __future__ import annotations

import os
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
CONFIG_DIR = ROOT / "config"
DATA_DIR = ROOT / "data"          # published, derived analytics only
WEB_DIR = ROOT / "web"
# Raw vendor data. In CI this is a checkout of the private vault repository.
VAULT_DIR = Path(os.environ.get("IND_VAULT", ROOT / "vault"))

# India has no daylight saving, so a fixed offset is exact and needs no tzdata.
IST = timezone(timedelta(hours=5, minutes=30), name="IST")


@lru_cache(maxsize=None)
def load_yaml(name: str) -> dict:
    with open(CONFIG_DIR / name, encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


def universe_cfg() -> dict:
    return load_yaml("universe.yaml")


def now_ist() -> datetime:
    return datetime.now(IST)


def today_ist() -> date:
    return now_ist().date()
