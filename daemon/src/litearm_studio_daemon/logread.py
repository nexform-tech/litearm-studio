"""Reading the daemon's JSONL files back — the endpoint behind `/api/logs`.

Who reads this: anyone wiring the page to the log history, and anyone wondering why
the history is read from a file rather than kept in memory.

Why the file and not a memory buffer (issue #80): the browser's IndexedDB store is
scoped to the page's origin, and the daemon's port can change between launches, so
that store moves out from under the page. The daemon's log file does not. It is the
authoritative history, and this module is how the page reads it back after a reload,
after a reconnect, or after a gap.

How the read works:

* rotated files are ordered oldest → newest by the `RotatingFileHandler` suffix
  (`daemon.jsonl.3` is older than `daemon.jsonl.1`, which is older than
  `daemon.jsonl`) — do not sort those names as strings, `daemon.jsonl.10` would land
  next to `daemon.jsonl.1`;
* the file being written is read **snapshot-first** (`size()` at the start) so a
  record appended mid-read cannot appear twice or tear a line;
* a page walks backwards with an opaque cursor of `(file, line index)`. The index
  is into a per-file list of line offsets, which is why the reader caches a file's
  index rather than byte-searching on every page.

A line that fails to parse is skipped, not fatal: half a line at the end of a file
the daemon is still writing is normal, and one bad line must not hide the thousands
of good ones behind it.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .obs import handlers, schema

#: One page of history. The page's UI loads 200 at a time; the cap keeps a hostile or
#: buggy client from asking for the whole file in one request.
DEFAULT_LIMIT = 200
MAX_LIMIT = 1000

#: `RotatingFileHandler`'s suffix: `daemon.jsonl.1`, `daemon.jsonl.2`, …
_ROTATED = re.compile(rf"^{re.escape(handlers.LOG_FILE_NAME)}\.(\d+)$")


@dataclass(frozen=True)
class Cursor:
    """Where a backwards walk has reached.

    A cursor is the **record's own timestamp plus a tiebreaker**, not a position in a
    file. That choice is what makes it survive rotation: `daemon.jsonl` can become
    `daemon.jsonl.1` between two requests and the next request still means the same
    thing, whereas a `(file, line)` cursor would be pointing at a file that no longer
    holds those bytes.

    `tie` is the record's `_seq` (the daemon's own monotonic write counter), and it is
    what makes the order **total**: two records can share a `ts_ns` (a burst written in
    one tick, or one command emitting its ledger and a state update together), and a
    cursor of "the timestamp I reached" would then either re-read one of them forever
    or step over the other. `_seq` is unique per record within a run, so neither can
    happen. It survives rotation for the same reason the timestamp does — it travels
    with the record, not with a file position.
    """

    ts_ns: int
    tie: int = 0

    @classmethod
    def parse(cls, raw: Any) -> Optional["Cursor"]:
        if not isinstance(raw, str) or not raw:
            return None
        head, _, tail = raw.partition("-")
        try:
            return cls(int(head), int(tail) if tail else 0)
        except ValueError:
            return None

    def encode(self) -> str:
        return f"{self.ts_ns}-{self.tie}"


def log_files(directory: Path) -> List[Path]:
    """Oldest → newest: rotated files first (highest suffix oldest), live file last."""
    if not directory.is_dir():
        return []
    live = directory / handlers.LOG_FILE_NAME
    rotated: List[Tuple[int, Path]] = []
    for path in directory.iterdir():
        match = _ROTATED.match(path.name)
        if match:
            rotated.append((int(match.group(1)), path))
    rotated.sort(key=lambda item: item[0], reverse=True)   # .3 oldest → .1 newest
    files = [path for _, path in rotated]
    if live.exists():
        files.append(live)
    return files


class LogReader:
    """Reads the daemon's log files backwards with a stable cursor.

    Instantiate per request (it caches line offsets, which is cheap but not free) or
    keep one on the app; both work because the only mutable state is the index cache,
    which is keyed by file and invalidated by rotation.
    """

    def __init__(self, directory: Optional[Path] = None) -> None:
        self.directory = directory if directory is not None else handlers.read_log_dir()
        self._index: Dict[str, List[int]] = {}

    def available(self) -> bool:
        return self.directory is not None and bool(log_files(self.directory))

    # ------------------------------------------------------------------ public API
    def history(self, *, limit: int = DEFAULT_LIMIT,
                before: Optional[Cursor] = None,
                keep: Optional[Any] = None) -> Dict[str, Any]:
        """Up to `limit` records, **newest first**, strictly older than `before`.

        `before=None` starts at the newest record. `keep` is a predicate receiving the
        parsed record — it exists so `/api/logs` can reuse the same walk for its filters
        instead of re-reading the file once per filter.

        Returns `{"records": [...], "cursor": <older than the last returned>, "more":
        bool, "fileCount": n}`. `cursor` is `None` when the walk has reached the end of
        the oldest file, which is how the page knows to stop offering "load older".

        ⚠ The walk is **oldest file first, collecting into a list that is set aside
        only when it fills**: the newest records must win a collision, and a newer file
        always holds newer records. Picking greedily per file would return records from
        an older file when a newer one still had some left.

        ⚠ Records **from the live file only are returned newest-first within the same
        nanosecond** (`_walk_backwards` yields backwards). But a filtered page's
        "newest first" is only exact *within* a file, and a file boundary is also a time
        boundary (the rotation happened at a later `ts_ns`), so the overall order is
        correct: every record in a newer file is newer than every record in an older one.
        """
        if self.directory is None:
            return {"records": [], "cursor": None, "more": False, "fileCount": 0}
        limit = max(1, min(int(limit), MAX_LIMIT))
        files = log_files(self.directory)
        if not files:
            return {"records": [], "cursor": None, "more": False, "fileCount": 0}

        # 收集顺序 = 从最新往最旧。两条独立的上限:
        #   * `matched` 是**返回**的条数 (受 keep 过滤影响);
        #   * `scanned` 是**读过**的条数 —— 游标要跟着它走。
        # ⚠ 两者必须分开: 若游标只跟 `matched` 走, 一个稀疏的过滤条件会让这一页返回
        # 0 条、游标原地不动, 翻页就永远在同一段上打转。
        matched: List[Dict[str, Any]] = []
        scanned = 0
        reached_oldest = True
        last_scanned: Optional[Dict[str, Any]] = None
        stop = False
        for path in reversed(files):
            for _index, record in self._walk_backwards(path, None):
                if not _is_older(record, before):
                    continue
                scanned += 1
                last_scanned = record
                if keep is None or keep(record):
                    matched.append(record)
                # 返回够了就停; 没够了也停 —— 否则稀疏条件下会把整份历史读穿。
                if len(matched) >= limit or scanned >= limit:
                    reached_oldest = False
                    stop = True
                    break
            if stop:
                break

        # ⚠ 只要**停下来了** (而不是走完了最旧的那个文件), 就必须交回一个游标 ——
        # 哪怕这一页一条都没匹配 (`keep` 很挑时)。少了它, 页面会以为历史到此为止,
        # 而这段历史明明还在后面。游标取"读到的最后一条", 不是"匹配的最后一条":
        # 前者才能让下一次请求从**没读过**的地方继续。
        next_cursor = None
        if not reached_oldest and last_scanned is not None:
            next_cursor = Cursor(*_sort_key(last_scanned))
        return {
            "records": matched,
            "cursor": None if next_cursor is None else next_cursor.encode(),
            "more": not reached_oldest,
            "fileCount": len(files),
        }

    def events(self) -> Dict[str, Any]:
        """The event catalogue, plus what is actually in the files.

        The page needs the catalogue to label and filter; it needs the observed counts
        to answer "has this ever happened on this machine". Counts come from the live
        file only — a full scan of every rotated file on every page load is not worth
        it for a filter list.
        """
        catalog = schema.event_catalog()
        counts: Dict[str, int] = {}
        if self.directory is not None:
            files = log_files(self.directory)
            if files:
                for _, record in self._walk_backwards(files[-1], None):
                    name = str(record.get("event") or "")
                    if name:
                        counts[name] = counts.get(name, 0) + 1
        catalog["observed"] = counts
        return catalog

    # ------------------------------------------------------------------ internals
    def _line_offsets(self, path: Path) -> List[int]:
        """Byte offset of every line start in `path`, cached per (name, size).

        The cache key includes the size because the live file grows: a cached index for
        a 4 KB file must not be reused once it is 5 KB. Rotation changes the name, which
        also changes the key.
        """
        try:
            size = path.stat().st_size
        except OSError:
            return []
        key = f"{path.name}:{size}"
        cached = self._index.get(key)
        if cached is not None:
            return cached
        offsets: List[int] = []
        try:
            with path.open("rb") as handle:
                position = 0
                for line in handle:
                    offsets.append(position)
                    position += len(line)
                    if position >= size:
                        # ⚠ Stop at the snapshot size: bytes appended after this point
                        # belong to a record the caller has not been told about yet.
                        break
        except OSError:
            return []
        self._index[key] = offsets
        # Keep the cache from growing across a long-lived process: one entry per file is
        # enough, and rotation renames files.
        if len(self._index) > 32:
            for old_key in list(self._index)[:-8]:
                self._index.pop(old_key, None)
        return offsets

    def _walk_backwards(self, path: Path, start: Optional[int]) -> Iterable[Tuple[int, Dict[str, Any]]]:
        """Yield `(line index, record)` from `start` (or the end) backwards."""
        offsets = self._line_offsets(path)
        if not offsets:
            return
        index = len(offsets) - 1 if start is None else min(start, len(offsets) - 1)
        try:
            with path.open("rb") as handle:
                while index >= 0:
                    handle.seek(offsets[index])
                    # ⚠ `readline()` after `seek` is the only correct pairing here: the
                    # buffered iterator would keep its own position and desynchronise.
                    raw = handle.readline()
                    position = index
                    index -= 1
                    record = _parse(raw)
                    if record is not None:
                        yield (position, record)
        except OSError:
            return


def _ts_of(record: Dict[str, Any]) -> int:
    """A record's `ts_ns`, or 0 when it is missing/garbage.

    ⚠ 不是 `int()` 硬转: 一条字段残缺的记录也要能被**排到最后**而不是把整个回读打挂。
    文件是按时间顺序写的, 排到最旧那一端正是它该在的位置。
    """
    try:
        return int(record.get("ts_ns") or 0)
    except (TypeError, ValueError):
        return 0


def _seq_of(record: Dict[str, Any]) -> int:
    """The record's `_seq`; 0 for a record written before this field existed."""
    try:
        return int(record.get("_seq") or 0)
    except (TypeError, ValueError):
        return 0


def _sort_key(record: Dict[str, Any]) -> Tuple[int, int]:
    return (_ts_of(record), _seq_of(record))


def _is_older(record: Dict[str, Any], before: Optional[Cursor]) -> bool:
    """Pagination: keep only records strictly older than the cursor, in `(ts_ns, key)` order.

    ⚠ 严格序, 不是"时间严格小于": 同一纳秒里的两条记录必须也能分开, 否则游标落在
    这个纳秒上时, 要么把其中一条重复返回 (直到永远), 要么把另一条跳过 (历史里出现
    一个谁都解释不了的洞)。判据因此是 `(ts_ns, _seq)` 这个**全序**。
    """
    if before is None:
        return True
    ts, key = _sort_key(record)
    if ts != before.ts_ns:
        return ts < before.ts_ns
    return key < before.tie


def _parse(raw: bytes) -> Optional[Dict[str, Any]]:
    """One JSONL line → a record, or `None` if it is not usable.

    A torn last line (the daemon was mid-write when this ran) and a line from a
    different tool both land here; both are skipped so the rest of the file stays
    readable.
    """
    text = raw.decode("utf-8", errors="replace").strip()
    if not text:
        return None
    try:
        value = json.loads(text)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def severity_filter(min_severity: Optional[str]):
    """A predicate for `minimum level`, or `None` when no filter was asked for."""
    if not min_severity:
        return None
    wanted = schema.severity_number(schema.normalize_severity(min_severity))
    return lambda record: schema.severity_number(
        schema.normalize_severity(record.get("severity"))) >= wanted


def kind_filter(kind: Optional[str]):
    if not kind:
        return None
    return lambda record: record.get("kind") == kind


def event_filter(event: Optional[str]):
    if not event:
        return None
    return lambda record: record.get("event") == event


def query_filter(query: Optional[str]):
    """Case-insensitive substring over the fields a person would search.

    Deliberately **not** a full-text index: the values searched are the event name, the
    message and the command method, and a linear scan over one page of JSONL is faster
    than the machinery an index would need.
    """
    if not query:
        return None
    needle = query.strip().lower()
    if not needle:
        return None

    def matches(record: Dict[str, Any]) -> bool:
        fields = record.get("fields")
        method = fields.get("method") if isinstance(fields, dict) else None
        haystack = (str(record.get("event") or ""), str(record.get("body") or ""),
                    str(record.get("source") or ""), str(method or ""))
        return any(needle in part.lower() for part in haystack)

    return matches


def combine(*predicates) -> Optional[Any]:
    """All predicates together; `None` when every one of them is `None`."""
    active = [p for p in predicates if p is not None]
    if not active:
        return None
    return lambda record: all(p(record) for p in active)
