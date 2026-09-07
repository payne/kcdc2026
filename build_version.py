#!/usr/bin/env python3
"""
Regenerate docs/data/version.json — the small marker file the web app polls
to decide whether it needs to reload the (much larger) JSON/db data files or
pick up a new app shell, without downloading them speculatively.

Run this any time after copying updated data into docs/data/, e.g.:
    cp kcdc-2026-sessions.json youtubes.json docs/data/
    python3 build_db.py --output docs/data/kcdc.db --force
    python3 build_version.py

Usage:
    python3 build_version.py [--docs docs]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

DATA_FILES = ["kcdc-2026-sessions.json", "youtubes.json", "kcdc.db"]
APP_SHELL_FILES = ["index.html", "app.js", "style.css", "sw.js"]


def short_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--docs", type=Path, default=Path("docs"), help="path to the docs/ folder (default: docs)")
    args = parser.parse_args()

    docs = args.docs
    data_dir = docs / "data"

    files = {}
    data_combined = hashlib.sha256()
    for name in DATA_FILES:
        path = data_dir / name
        if not path.exists():
            print(f"warning: {path} missing, skipping", file=sys.stderr)
            continue
        digest = short_sha256(path)
        files[name] = digest
        data_combined.update(digest.encode())

    app_combined = hashlib.sha256()
    for name in APP_SHELL_FILES:
        path = docs / name
        if not path.exists():
            print(f"warning: {path} missing, skipping", file=sys.stderr)
            continue
        app_combined.update(short_sha256(path).encode())

    if not files:
        print("error: no data files found, nothing to version", file=sys.stderr)
        return 1

    version = {
        "dataVersion": data_combined.hexdigest()[:16],
        "appVersion": app_combined.hexdigest()[:16],
        "files": files,
    }

    out_path = data_dir / "version.json"
    out_path.write_text(json.dumps(version, indent=2) + "\n")
    print(f"wrote {out_path}")
    print(json.dumps(version, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
