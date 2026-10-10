#!/usr/bin/env python3
"""Compare the frozen bundle inside two packages — so "my build matches the release" is checkable.

Who reads this: anyone who changed the build image or the packaging scripts and wants to know
whether the artifact still carries what the released one carries. It exists because a minimal
build image silently dropped `librsvg` and the SVG pixbuf loader: the package built, installed
and started, and only the bundled Adwaita icons would have been broken.

    scripts/compare_bundles.py released.deb packaging/dist/litearm-studio_*_amd64.deb [--ignore PATTERN ...]

Both arguments may be a `.deb` or a bare one-file executable. The verdict is about the two
things that change behaviour:

* **libraries** (`*.so*`) — a missing one is a missing capability;
* **UI assets** (`dist/assets/*`) — the two builds may carry different content hashes, so names
  are compared with the hash stripped.

Everything else is Python-level: a release built on a GitHub runner carries packages that
runner happens to have (`apt_pkg`, `cryptography`, `certifi`, …) which a lean build does not
need. Those are listed for information and never fail the check. `--ignore` adds a glob to
skip entirely.

⚠ Needs `pip install pyinstaller` (it reads PyInstaller's own archive format).
"""
from __future__ import annotations

import fnmatch
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from PyInstaller.archive.readers import CArchiveReader

EXE_IN_DEB = Path("usr/lib/litearm-studio/litearm-studio-daemon")
#: `LogsPage-CuR9AlHP.js` -> `LogsPage.js`: the hash changes whenever the UI changes, so it
#: says nothing about whether the bundle is complete.
HASHED = re.compile(r"-[A-Za-z0-9_-]{8}(\.[a-z]+)$")


def bundle_path(argument: str) -> Path:
    """The one-file executable: either the argument itself, or inside the `.deb` it is."""
    path = Path(argument).resolve()
    if not path.is_file():
        raise SystemExit(f"[compare] no such file: {path}")
    if path.suffix != ".deb":
        return path
    temp = Path(tempfile.mkdtemp(prefix="bundle-compare-"))
    subprocess.run(["dpkg-deb", "-x", str(path), str(temp)], check=True)
    inside = temp / EXE_IN_DEB
    if not inside.is_file():
        raise SystemExit(f"[compare] {path} does not contain {EXE_IN_DEB}")
    return inside


def toc(path: Path, ignore: list[str]) -> dict[str, int]:
    """Uncompressed size per entry, keyed by a stable name (asset hashes stripped)."""
    out: dict[str, int] = {}
    for name, entry in CArchiveReader(str(path)).toc.items():
        if any(fnmatch.fnmatch(name, pattern) for pattern in ignore):
            continue
        key = HASHED.sub(r"\1", name) if name.startswith("dist/assets/") else name
        out[key] = out.get(key, 0) + entry[2]
    return out


def is_library(name: str) -> bool:
    """A system shared library, as opposed to a Python extension module.

    The distinction matters: `_ssl.cpython-310-x86_64-linux-gnu.so` and `bcrypt/_bcrypt.abi3.so`
    are Python modules that only exist for the Python that ships inside the bundle, while
    `libgtk-3.so.0` is a piece of the GTK stack. Both end in `.so`.
    """
    base = Path(name).name
    if "cpython-" in base or base.endswith(".abi3.so"):
        return False
    return ".so" in base


def is_asset(name: str) -> bool:
    return name.startswith("dist/assets/") or name.startswith("dist/")


def bucket(entries: dict[str, int]) -> tuple[dict[str, int], dict[str, int], dict[str, int]]:
    libs = {k: v for k, v in entries.items() if is_library(k)}
    assets = {k: v for k, v in entries.items() if is_asset(k) and k not in libs}
    rest = {k: v for k, v in entries.items() if k not in libs and k not in assets}
    return libs, assets, rest


def show(title: str, items: list[tuple[int, str]], limit: int) -> None:
    if not items:
        return
    print(f"\n{title} ({len(items)}):")
    for size, name in items[:limit]:
        print(f"  {size / 1e6:9.3f} MB  {name}")
    if len(items) > limit:
        print(f"  … and {len(items) - limit} more")


def main(argv: list[str]) -> int:
    ignore: list[str] = []
    positional: list[str] = []
    rest = argv[1:]
    while rest:
        argument = rest.pop(0)
        if argument == "--ignore":
            ignore.append(rest.pop(0) if rest else "")
        else:
            positional.append(argument)
    if len(positional) != 2:
        raise SystemExit("usage: compare_bundles.py REFERENCE CANDIDATE [--ignore PATTERN ...]")

    reference, candidate = toc(bundle_path(positional[0]), ignore), toc(bundle_path(positional[1]), ignore)
    for label, entries in (("reference", reference), ("candidate", candidate)):
        print(f"{label}: {len(entries)} entries, {sum(entries.values()) / 1e6:.1f} MB uncompressed")

    failed = False
    for label, pick in (("libraries", is_library), ("UI assets", is_asset)):
        missing = sorted(((reference[k], k) for k in reference.keys() - candidate.keys() if pick(k)),
                         reverse=True)
        show(f"MISSING {label} — the candidate cannot do what the reference does", missing, 40)
        failed = failed or bool(missing)

    missing_python = sorted(
        ((reference[k], k) for k in reference.keys() - candidate.keys()
         if not is_library(k) and not is_asset(k)), reverse=True)
    show("Python-level entries only in the reference (runner extras; expected, not a failure)",
         missing_python, 5)

    if failed:
        print("\n[compare] FAILED: see MISSING libraries/assets above.")
        return 1
    print("\n[compare] OK: every library and UI asset of the reference is present.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
