"""Directory listing for the console's calibration file picker.

Why this exists
---------------
``gripper.import_calibration`` takes a host path: the daemon pins it and
re-resolves it on every connect (``docs/GRIPPER_INTEGRATION.md`` §5.3), so the
operator has to name a file that lives on the **control machine**.  A browser's
own file dialog cannot supply that —— a ``File`` object carries no real path ——
so the listing has to come from the side that has the filesystem.

What it lists, and what it deliberately does not
------------------------------------------------
Sub-directories and ``*.json`` regular files, nothing else.  This is a
calibration picker, not a general file manager: a directory full of logs and
binaries would be noise, and the manual path box is the escape hatch for a
calibration named without a ``.json`` extension.  Hidden entries are listed,
though —— the daemon's own ``~/.litegrip`` and ``~/.config/litearm-studio`` are
dot-directories, and hiding them would hide exactly the files the operator came
for.

Every ``*.json`` entry carries the fields of
:func:`~litearm_studio_daemon.gripper.calibration.candidate_dict`, so the picker
can render a file with the same row markup the browser dialog uses —— and so an
operator sees *before* importing that a file is invalid and why.

Pure layer: no Qt, no SDK, no session.  The filesystem root is injectable
(``home=``) so the whole thing can be tested against a ``tmp_path`` tree, the
same way :func:`~litearm_studio_daemon.gripper.can_link.list_channels` takes its
``sys_class_net=``.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from ..errors import GripperBrowseError
from . import calibration, constants

#: Hard cap on returned entries.  A user-named directory can be arbitrarily
#: large, and both the WS frame and the 60 s command timeout need a bound; the
#: response says ``truncated`` so the UI can tell the operator.
MAX_ENTRIES = 2000

#: Files larger than this are listed but not validated.  A calibration is a few
#: hundred bytes; anything past this is not one, and reading it would spend the
#: command's timeout on nothing.
MAX_INSPECT_BYTES = 4 * 1024 * 1024


def _resolve_dir(path: str | os.PathLike[str] | None, base: Path) -> Path:
    """The absolute directory to list.  ``None``/empty means *base* (the home).

    ``~`` expands; anything still relative is resolved **against the home**, not
    against the daemon's working directory —— a relative path resolving against
    an undefined process CWD is a footgun, and the console never sends one (it
    echoes back the absolute path this function returned).
    """
    if path is None:
        return base
    raw = os.fspath(path)
    if not raw.strip():
        return base
    target = Path(raw).expanduser()
    if not target.is_absolute():
        target = base / target
    return Path(os.path.normpath(str(target)))


def _oversize_root(path: Path, size: int, channel: str | None,
                   travel_mm: float) -> calibration.CalibrationInfo:
    """An invalid row for a ``*.json`` too large to read, shaped like a real one.

    Going through :class:`CalibrationInfo` rather than hand-building the dict is
    what keeps this row's keys identical to a validated one's —— the UI has one
    row renderer and no reason to special-case size.
    """
    return calibration.CalibrationInfo(
        provenance=calibration.PROVENANCE_INVALID,
        limits=None,
        path=str(path),
        channel=channel,
        max_stroke_mm=float(travel_mm),
        problems=(
            f"文件 {size} 字节，超出 {MAX_INSPECT_BYTES} 字节上限，未做校验 —— "
            "标定文件只有几百字节，请确认这是不是标定文件",
        ),
    )


def _file_entry(entry: os.DirEntry[str], travel_mm: float, channel: str | None,
                max_inspect_bytes: int) -> dict[str, Any] | None:
    """A pickable ``*.json`` row, or ``None`` when the entry cannot be described."""
    try:
        stat = entry.stat()          # follows symlinks; fails on a dead target
    except OSError:
        return None
    try:
        readable = os.access(entry.path, os.R_OK)
    except OSError:                  # pragma: no cover - path vanished mid-listing
        readable = False
    row: dict[str, Any] = {
        "name": entry.name,
        "path": entry.path,
        "type": "file",
        "readable": readable,
        "symlink": entry.is_symlink(),
        "size": stat.st_size,
        "mtime": stat.st_mtime,
    }
    if stat.st_size > max_inspect_bytes:
        info = _oversize_root(Path(entry.path), stat.st_size, channel, travel_mm)
    else:
        info = calibration.inspect_file(entry.path, travel_mm, channel=channel)
    row.update(calibration.candidate_dict(info, channel or ""))
    return row


def _dir_entry(entry: os.DirEntry[str]) -> dict[str, Any]:
    """A navigable directory row.

    ``readable`` means "can be entered": listing a directory needs read, and
    crossing it needs execute.  The UI greys an unreadable one instead of
    letting the click fail.
    """
    try:
        readable = os.access(entry.path, os.R_OK | os.X_OK)
    except OSError:                  # pragma: no cover - path vanished mid-listing
        readable = False
    return {
        "name": entry.name,
        "path": entry.path,
        "type": "dir",
        "readable": readable,
        "symlink": entry.is_symlink(),
    }


def list_dir(
    path: str | os.PathLike[str] | None = None,
    *,
    home: Path | None = None,
    travel_mm: float = constants.DEFAULT_TRAVEL_MM,
    channel: str | None = None,
    max_entries: int = MAX_ENTRIES,
    max_inspect_bytes: int = MAX_INSPECT_BYTES,
) -> dict[str, Any]:
    """List one directory: sub-directories and validated ``*.json`` files.

    Returns ``{"path", "parent", "truncated", "entries"}``.  ``path`` is the
    absolute directory actually listed —— the caller navigates from *that*, so
    ``~``, trailing slashes and relative input never drift.  ``parent`` is
    ``None`` at the filesystem root.

    Every ``*.json`` entry carries the ``candidate_dict`` fields plus
    ``name/path/type/readable/symlink/size/mtime``.  ``inUse`` is **not** here:
    which candidate is in effect is the session's answer, not the lister's.

    Raises :class:`~litearm_studio_daemon.errors.GripperBrowseError` when the
    path does not exist, is not a directory, or cannot be read.
    """
    base = Path(home).expanduser() if home is not None else Path.home()
    target = _resolve_dir(path, base)

    if not target.is_dir():
        raise GripperBrowseError(f"{target} 不是一个可访问的目录")

    dirs: list[dict[str, Any]] = []
    files: list[dict[str, Any]] = []
    try:
        with os.scandir(target) as scan:
            for entry in scan:
                try:
                    is_dir = entry.is_dir()          # follows symlinks
                    is_file = entry.is_file()
                except OSError:
                    continue
                if is_dir:
                    dirs.append(_dir_entry(entry))
                elif is_file and entry.name.lower().endswith(".json"):
                    row = _file_entry(entry, travel_mm, channel, max_inspect_bytes)
                    if row is not None:
                        files.append(row)
                # Everything else —— plain files, sockets, broken symlinks —— is
                # not something this picker can offer.
    except OSError as exc:
        raise GripperBrowseError(f"无法读取目录 {target}: {exc}") from exc

    dirs.sort(key=lambda e: (e["name"].casefold(), e["name"]))
    files.sort(key=lambda e: (e["name"].casefold(), e["name"]))
    entries = dirs + files                # directories first, like any picker
    truncated = len(entries) > max_entries
    if truncated:
        entries = entries[:max_entries]

    parent = target.parent
    return {
        "path": str(target),
        "parent": None if parent == target else str(parent),
        "truncated": truncated,
        "entries": entries,
    }
