"""Fail if any existing ledger line was changed or removed since a given commit.

    python -m pipeline.ledger_guard <base-commit>

The ledger is append-only: each month file may only grow at the end. Run by the
`ledger-guard` workflow on every push that touches data/ledger/.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

LEDGER = "data/ledger"


def git(*args: str) -> str:
    return subprocess.run(["git", *args], capture_output=True, text=True, check=True, encoding="utf-8").stdout


def violations(old_files: dict[str, str], new_files: dict[str, str]) -> list[str]:
    out = []
    for name, old in old_files.items():
        new = new_files.get(name)
        if new is None:
            out.append(f"{name}: deleted")
            continue
        old_lines, new_lines = old.splitlines(), new.splitlines()
        if new_lines[:len(old_lines)] != old_lines:
            first = next(i for i, (a, b) in enumerate(zip(old_lines + [None], new_lines + [None])) if a != b)
            out.append(f"{name}: line {first + 1} was changed or removed (only appending is allowed)")
    return out


def files_at(commit: str) -> dict[str, str]:
    names = [n for n in git("ls-tree", "-r", "--name-only", commit, "--", LEDGER).splitlines() if n.endswith(".jsonl")]
    return {n: git("show", f"{commit}:{n}") for n in names}


def main() -> None:
    base = sys.argv[1] if len(sys.argv) > 1 else "HEAD~1"
    if set(base) == {"0"}:                               # a new branch: nothing to compare
        print("no base commit; nothing to check")
        return
    try:
        old = files_at(base)
    except subprocess.CalledProcessError:
        print(f"base {base} not found; nothing to check")
        return
    new = {str(p.as_posix()): p.read_text(encoding="utf-8") for p in Path(LEDGER).glob("*.jsonl")}
    bad = violations(old, new)
    if bad:
        for b in bad:
            print("::error::ledger " + b)
        sys.exit(1)
    print(f"ledger: {len(old)} file(s) only appended to since {base[:10]}")


if __name__ == "__main__":
    main()
