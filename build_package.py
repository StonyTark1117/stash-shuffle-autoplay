#!/usr/bin/env python3
"""Build the static package source consumed by Stash's plugin manager."""

import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import zipfile


ROOT = Path(__file__).resolve().parent
PLUGIN_FILES = ("shuffle.yml", "shuffle.js", "shuffle.css")


def field(name: str) -> str:
    match = re.search(rf"(?m)^{re.escape(name)}:\s*(.+?)\s*$", (ROOT / "shuffle.yml").read_text())
    if not match:
        raise ValueError(f"Missing {name} in shuffle.yml")
    return match.group(1).strip('"\'')


def main() -> None:
    package = ROOT / "shuffle.zip"
    with zipfile.ZipFile(package, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for filename in PLUGIN_FILES:
            entry = zipfile.ZipInfo(filename, date_time=(1980, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o644 << 16
            archive.writestr(entry, (ROOT / filename).read_bytes())

    timestamp = datetime.datetime.fromtimestamp(
        int(os.environ.get("SOURCE_DATE_EPOCH", str(int(datetime.datetime.now(datetime.timezone.utc).timestamp())))),
        datetime.timezone.utc,
    ).strftime("%Y-%m-%d %H:%M:%S")
    index = (
        "- id: shuffle\n"
        f"  name: {json.dumps(field('name'))}\n"
        "  metadata:\n"
        f"    description: {json.dumps(field('description'))}\n"
        f"  version: {json.dumps(field('version'))}\n"
        f"  date: {json.dumps(timestamp)}\n"
        "  path: shuffle.zip\n"
        f"  sha256: {hashlib.sha256(package.read_bytes()).hexdigest()}\n"
    )
    (ROOT / "index.yml").write_text(index)


if __name__ == "__main__":
    main()
