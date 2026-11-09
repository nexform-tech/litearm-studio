"""桌面自己的语言 —— 界面第一次打开时的默认语言。

**为什么需要这个文件。** 首屏语言不能只信 webview 的 `navigator.language`:
Linux 的 WebKitGTK 只从进程的 POSIX locale (`LANG` / `LC_ALL`) 推它, 而桌面自己的
翻译走的是 gettext 的 `LANGUAGE` 列表。中文桌面很常见的「中文界面 + 英文终端」配置
正是 `LANG=en_US.UTF-8` + `LANGUAGE=zh_CN:zh`: GNOME 看起来是中文, webview 却报
`en-US`, 于是操作员第一次打开界面看到的是英文 (见 `server` 的 `/api/ui-language.js`
与 `src/i18n/index.ts`)。

这里的顺序以 `LANGUAGE` 优先 (它是桌面实际用来的语言列表), 再退到
`LC_ALL` / `LC_MESSAGES` / `LANG`。进程里一个 locale 变量都没有时 (裸 SSH 会话、
systemd 服务), 才退到系统级的 `/etc/default/locale` —— 那正是桌面登录会用到的那份。
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Iterable, List, Mapping, Optional

#: 桌面登录写下的系统级默认值。只在进程环境里**完全没有** locale 变量时才读它:
#: 有 `LANG=C.UTF-8` 的服务进程是刻意留在 C locale 的, 不该被系统文件改回中文。
DEFAULT_LOCALE_FILE = Path("/etc/default/locale")

#: 这两个不是"语言", 它们只表示"不做本地化"。
_C_LOCALES = frozenset({"c", "posix"})

#: `zh_CN.UTF-8` / `en_US.utf8` / `sr_RS@latin` 里的语言与地区。
_LOCALE_RE = re.compile(
    r"^(?P<lang>[A-Za-z]{2,3})(?:[_-](?P<region>[A-Za-z]{2}|[0-9]{3}))?$")

#: 我们认的 locale 变量, 按 gettext 的优先级排列 (LANGUAGE 单独处理, 它是列表)。
_LOCALE_NAMES = ("LC_ALL", "LC_MESSAGES", "LANG")


def _bcp47(value: str) -> Optional[str]:
    """`zh_CN.UTF-8@x` → `zh-CN`; `C` / `POSIX` / 认不出的值 → `None`。

    `navigator.language` 与 i18next 用的是 BCP 47 (`zh-CN`), 而 locale 是
    `language_REGION.encoding@modifier` —— 这里做唯一一次转换。
    """
    text = value.strip()
    if not text:
        return None
    text = text.split("@", 1)[0]          # 丢掉 @modifier
    text = text.split(".", 1)[0]          # 丢掉 .encoding
    if text.lower() in _C_LOCALES:
        return None
    match = _LOCALE_RE.match(text)
    if match is None:
        return None
    language = match.group("lang").lower()
    region = match.group("region")
    return f"{language}-{region.upper()}" if region else language


def _ordered(values: Mapping[str, str]) -> List[str]:
    """按桌面翻译的优先级把一份 locale 变量摊成候选列表。"""
    candidates: List[str] = []
    language = values.get("LANGUAGE", "")
    if language:
        candidates.extend(language.split(":"))
    for name in _LOCALE_NAMES:
        value = values.get(name, "")
        if value:
            candidates.append(value)
    return candidates


def _read_locale_file(path: Path) -> dict[str, str]:
    """读 `/etc/default/locale` 的 `NAME=value` 行 —— 读不到就是空, 绝不抛。

    值可能带引号 (`LANG="zh_CN.UTF-8"`), 也可能写成 `export LANG=...`; 两种都收。
    这不是 shell 解析: 只认识这里要的四项, 别的一律忽略。
    """
    values: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return values
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, raw = line.split("=", 1)
        name = name.strip()
        if name.startswith("export "):
            name = name[len("export "):].strip()
        if name not in ("LANGUAGE", *_LOCALE_NAMES):
            continue
        raw = raw.strip()
        if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
            raw = raw[1:-1]
        values[name] = raw
    return values


def desktop_languages(environ: Optional[Mapping[str, str]] = None,
                      locale_file: Optional[Path] = DEFAULT_LOCALE_FILE) -> List[str]:
    """桌面翻译用的语言列表 (BCP 47), 去重且保持优先级; 认不出就是空列表。

    `environ` / `locale_file` 是给测试用的注入点; 生产路径直接用本进程的环境与
    系统文件。**空列表是一个合法的答案**: 前端会退回 `navigator`, 与没有这个接口时
    完全一致。
    """
    env = os.environ if environ is None else environ
    candidates = _ordered(env)
    if not candidates and locale_file is not None:
        # 只有环境里**一个 locale 变量都没有**时才看系统文件 —— 见 DEFAULT_LOCALE_FILE。
        candidates = _ordered(_read_locale_file(locale_file))

    languages: List[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        tag = _bcp47(candidate)
        if tag is None or tag.lower() in seen:
            continue
        seen.add(tag.lower())
        languages.append(tag)
    return languages


def script(languages: Iterable[str]) -> str:
    """`/api/ui-language.js` 的正文: 把列表写到页面的 window 上。

    `json.dumps` 同时负责转义: 这些值来自环境变量, 不能直接拼进 JS 源码。
    """
    return (f"window.__LITEARM_UI_LANGUAGES__ = "
            f"{json.dumps(list(languages), ensure_ascii=False)};\n")
