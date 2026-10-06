"""激活服务 (`act.nexform.tech`) 的客户端, 以及凭据文件 (`lic.json`) 的解析。

契约见 `docs/ACTIVATION.md`。分两半, 各自能单独测:

* :func:`parse_license` —— 凭据文件的**唯一**解析点: 在线领回来的凭据也走这里
  ⇒ "格式"只有一份实现, 不会漂。
* :func:`request_license` —— 往激活服务 POST 一次注册信息, 拿回这台机器的凭据。

⚠ **本模块是全仓库唯一出网的地方**。除它之外, 守护进程与前端都不碰网络 —— 这条边界
写清楚是为了将来做安全评审时能一眼答出来"这台机器会把什么发到哪里"。

⚠ 密钥不在这里, 也不该在: 服务端只是**按 UID 存取**厂商离线签好的凭据文件, 它签不了
新的。客户侧 / 服务侧都没有能算 MAC 的代码, 这是规格的硬要求。
"""
from __future__ import annotations

import json
import re
import unicodedata
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Optional, Tuple

from .errors import DaemonError

#: 生产地址。域名还没上线时, 任何一次提交都会如实报"连不上"——**不要**把它改成
#: "先假装成功", 那会让现场拿着一个没生效的授权去开机器。
PRODUCTION_ACTIVATION_URL = "https://act.nexform.tech"


def _baked_activation_url() -> str:
    """打包时注入的地址 —— `packaging/build.py` 写进 `_build_activation_url.py`。

    源码运行时没有这个模块, 返回空串。与 `__init__._resolve_version` 同一套做法
    (构建产物不入库, 见 `.gitignore`)。
    """
    try:
        from ._build_activation_url import __activation_url__ as baked  # type: ignore[import-not-found]
    except ImportError:
        return ""
    return str(baked).strip()


def default_activation_url() -> str:
    """没有 `--activation-url` / `LITEARM_ACTIVATION_URL` 时用的地址。

    优先级: **打包期注入 > 内置生产地址**。

    ⚠ 打包期注入的意义不是"换域名方便"——而是**同一份源码能出指向不同环境的包**
    (staging / 正式)。终端用户改不了它, 而"连不上激活服务"是这条链路上最没法自助
    排查的一种失败: 界面上只会说连不上, 说不出该连哪。
    """
    return _baked_activation_url() or PRODUCTION_ACTIVATION_URL


#: 解析后的默认地址。**保留这个名字**: `session.Session` 的构造默认值直接引用它,
#: 改名会静默改掉那处的语义。
DEFAULT_ACTIVATION_URL = default_activation_url()

#: 服务路径 —— 契约里的一部分, 站点那边要实现的就是它。
ACTIVATION_PATH = "/api/v1/license"

#: 凭据文件自身的版本 (`lic.json` 的 `format` 字段)。认不出的版本要**拒绝并说清楚**,
#: 不能猜着解析: 猜错的结果是把一台机器写成"已激活"或写坏授权记录。
LICENSE_FORMAT = 1

#: 同意书的版本号。⚠ 用户同意的是**某一版文案**, 将来文案改了, 靠这个字段区分
#: "他当时同意的是哪一版"。`draft-N` 是刻意的 —— 文案待法务定稿。
#: `draft-4`: 表单与网站对齐, 新增微信号 / 所在地区 / 所属行业 / 用途说明。
CONSENT_TEXT_VERSION = "draft-4"

#: 一次请求的上限与超时。激活是**人等着**的动作, 超时要短到操作员不会以为界面卡死。
REQUEST_TIMEOUT_S = 10.0
MAX_RESPONSE_BYTES = 64 * 1024

_U32_MAX = 0xFFFFFFFF

#: 设备 UID 的形态: 24 位小写十六进制 (与 SDK 的 `LicenseInfo.uid_hex`、厂商签发器的
#: `--uid` 完全一致)。
_UID_RE = re.compile(r"[0-9a-f]{24}")


class LicenseFileError(DaemonError):
    """凭据文件本身不合法 (不是 JSON / 缺字段 / 字段不对 / 不是这台机器的)。

    `reason` 是给前端做 i18n 判据用的短码 (见 `docs/ACTIVATION.md`), `str(e)` 是
    给日志和兜底显示用的一句话。前端**不该**直接显示 `str(e)` 当主文案 —— 那会把
    中文写死在英文界面上。
    """

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason


class ActivationError(DaemonError):
    """激活服务这一侧的问题, 或这次提交本身不成立 (未同意 / UID 不对)。"""

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason


# --------------------------------------------------------------------------- 凭据文件

def _hex_bytes(value: Any, n: int, field: str) -> bytes:
    if not isinstance(value, str):
        raise LicenseFileError("bad_field", f"{field} 必须是十六进制字符串")
    text = value.strip().lower()
    if len(text) != n * 2:
        raise LicenseFileError("bad_field", f"{field} 需 {n * 2} 位十六进制, 给的是 {len(text)} 位")
    try:
        return bytes.fromhex(text)
    except ValueError:
        raise LicenseFileError("bad_field", f"{field} 含非十六进制字符") from None


def _uint(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise LicenseFileError("bad_field", f"{field} 必须是整数")
    if not 0 <= value <= _U32_MAX:
        raise LicenseFileError("bad_field", f"{field} 超出 u32 范围: {value}")
    return int(value)


def parse_license(raw: Any, *, expected_uid: Optional[str] = None) -> Dict[str, Any]:
    """凭据文件 (dict 或 JSON 文本) → `Arm.activate()` 要的四个参数。

    返回 `{"cust_id", "issued", "flags", "mac"(bytes), "uid"}`。

    ⚠ 判据一律**显式且严格**: 缺字段、类型不对、`format` 认不出、`flags` 留了保留位,
    统统拒绝并指出是哪个字段。折叠成一句"凭据无效"会让现场没法自助排查。
    """
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", "replace")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            raise LicenseFileError("not_json", "这不是一份凭据文件 (不是 JSON)") from None
    if not isinstance(raw, dict):
        raise LicenseFileError("not_json", "凭据文件的内容不是一个 JSON 对象")

    fmt = raw.get("format")
    if fmt is None:
        raise LicenseFileError("missing_field", "凭据文件缺少 format 字段")
    if fmt != LICENSE_FORMAT:
        # ⚠ 不猜: 版本比本上位机新时, 猜着解析可能把授权记录写坏。
        raise LicenseFileError(
            "unsupported_format",
            f"凭据格式为 {fmt!r}, 当前上位机只认 {LICENSE_FORMAT} (请升级上位机)")

    for field in ("uid", "cust_id", "issued", "mac"):
        if field not in raw:
            raise LicenseFileError("missing_field", f"凭据文件缺少 {field} 字段")

    uid = _hex_bytes(raw["uid"], 12, "uid").hex()
    if expected_uid is not None and uid != expected_uid.strip().lower():
        raise LicenseFileError(
            "uid_mismatch",
            f"这份凭据是给 {uid} 的, 当前这台机器是 {expected_uid.strip().lower()}")

    flags = _uint(raw.get("flags", 0), "flags")
    if flags & ~0x1:
        raise LicenseFileError("bad_field", f"flags 只允许 bit0, 给的是 0x{flags:X}")

    return {
        "uid": uid,
        "cust_id": _uint(raw["cust_id"], "cust_id"),
        "issued": _uint(raw["issued"], "issued"),
        "flags": flags,
        "mac": _hex_bytes(raw["mac"], 16, "mac"),
    }


# --------------------------------------------------------------------------- 服务请求

#: 注册表单的规则表 —— **逐项对应激活网站的那张表**
#: (`litearm-activation/src/lib/validation.ts` 的 `activationFormSchema`)。
#:
#: ⚠ 网站是权威: 它才是签发的那一端, 字段和判据都以它为准。这里再判一遍不是重复劳动 ——
#:   **门禁必须在唯一持有链路的那一层**, 界面上的禁用按钮挡不住直连 WebSocket 的客户端。
#:   网站改了规则, 这里和界面 `activationPayload.ts` 要一起改。
#:
#: ⚠ 字段名沿用早期契约: `name` / `organization` 与网站表单的 `contactName` / `company`
#:   是同一个输入框 (对照表见 `docs/ACTIVATION.md` §6)。
#:
#: 每项: (字段, 必填, 最短, 最长), 顺序与网站表单一致。`None` = 这一侧不设该长度判据
#: (手机号的长度由正则决定, 网站上也没有单独的 min/max)。
_CONTACT_RULES: Tuple[Tuple[str, bool, Optional[int], Optional[int]], ...] = (
    ("name", True, 2, 32),
    ("phone", True, None, None),
    ("organization", True, 1, 128),
    ("wechatId", False, None, 64),
    ("email", True, 1, 128),
    ("region", True, 1, 64),
    ("industry", False, None, 64),
    ("purpose", False, None, 500),
)

#: 必填字段 —— 与界面 `activationPayload.REQUIRED_CONTACT_FIELDS` 同序同集。
CONTACT_FIELDS: Tuple[str, ...] = tuple(f for f, required, _, _ in _CONTACT_RULES if required)

#: 格式判据 —— 与网站 `validation.ts` 的正则逐字相同。
_PHONE_RE = re.compile(r"1[3-9]\d{9}")
_EMAIL_RE = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")

#: 姓名里额外允许的符号 (与网站 `PERSON_NAME_RE` 同一张表); 其余只许文字 (含 CJK) 与组合音标
#: —— 数字与其它标点一律不许。
_NAME_PUNCT = frozenset("·・‧’'- \u3000")


def _is_person_name(text: str) -> bool:
    """姓名: 只含文字 / 组合音标 / 常见姓名符号。⚠ 与网站同一判据, 不许数字。"""
    return all(
        ch in _NAME_PUNCT or ch.isalpha() or unicodedata.category(ch).startswith("M")
        for ch in text
    )


def _contact_fields(contact: dict) -> Dict[str, str]:
    """注册表单 → 请求里的 `contact` (**八个字段都在这里判**: 缺 / 超长 / 格式)。

    `reason` 是给界面选文案的短码: `missing_contact`(缺必填)、`contact_too_long`、
    `bad_name`、`bad_phone`、`bad_email`。
    """
    values: Dict[str, str] = {}
    for field, required, min_len, max_len in _CONTACT_RULES:
        raw = contact.get(field)
        if raw is None:
            raw = ""
        if not isinstance(raw, str):
            raise ActivationError("missing_contact", f"字段 {field} 必须是文本")
        text = raw.strip()
        if required and not text:
            raise ActivationError("missing_contact", f"缺少字段 {field}")
        if max_len is not None and len(text) > max_len:
            raise ActivationError("contact_too_long", f"字段 {field} 过长 (上限 {max_len} 字)")
        if text and min_len is not None and len(text) < min_len:
            raise ActivationError("missing_contact", f"字段 {field} 至少 {min_len} 字")
        values[field] = text

    # 消息里带上字段名 (方便日志定位), 但**不回显填的值** —— 那是个人信息, 没必要多抄一份。
    if not _PHONE_RE.fullmatch(values["phone"]):
        raise ActivationError("bad_phone", "字段 phone 格式不正确: 需为 11 位手机号")
    if not _EMAIL_RE.fullmatch(values["email"]):
        raise ActivationError("bad_email", "字段 email 格式不正确: 例如 name@example.com")
    if not _is_person_name(values["name"]):
        raise ActivationError("bad_name", "字段 name 格式不正确: 只允许文字 (2-32 字), 不能含数字")
    return values


def build_request(payload: dict) -> dict:
    """界面提交的内容 → 发给激活服务的请求体 (**守护进程这一层是最终门禁**)。

    ⚠ **同意在这里判, 不是在界面上判**: 界面禁用按钮只是方便, 任何直连 WS 的客户端都能
    绕开它 —— 而隐私政策里写的是"用户同意后才发送"。判据必须在唯一持有链路的那一层。

    ⚠ **不采信客户端填的 UID 内容**: 调用方 (session) 会用设备回读的 UID 覆盖/核对它
    (见 `_device_uid`), 这里只判格式。
    """
    uid = payload.get("uid")
    if not isinstance(uid, str) or not _UID_RE.fullmatch(uid.strip().lower()):
        raise ActivationError("bad_uid", "设备 UID 需为 24 位十六进制")

    consent = payload.get("consent")
    if not isinstance(consent, dict) or consent.get("granted") is not True:
        raise ActivationError("consent_required", "未同意《激活注册信息同意书》—— 请先阅读并同意")

    contact = payload.get("contact")
    if not isinstance(contact, dict):
        raise ActivationError("missing_contact", "缺少注册信息")

    diag = payload.get("diagnostics")
    diag = diag if isinstance(diag, dict) else {}

    request: Dict[str, Any] = {
        "uid": uid.strip().lower(),
        "contact": _contact_fields(contact),
        "consent": {
            # ⚠ 只有**一份**同意: 它覆盖下面列出的每一项, 包括 diagnostics。
            #   所以这里没有"逐项同意"的开关 —— 要么整份同意, 要么不发。
            "granted": True,
            # ⚠ 记的是**文案版本**: 将来同意书改了, 靠它区分"他当时同意的是哪一版"。
            "text_version": CONSENT_TEXT_VERSION,
        },
        # 版本号这类环境信息, 与联系人字段同在**同一份同意书**里逐项列出。
        # 内容是版本号 —— 内网地址/主机名**刻意不采集**。
        "diagnostics": {
            key: str(diag.get(key) or "")[:64] for key in ("studio", "sdk", "firmware")
        },
    }
    code = payload.get("code")
    if isinstance(code, str) and code.strip():
        # 预留: 订单号/激活码那一层如果启用, 站点直接读这个字段。今天界面上没有它。
        request["code"] = code.strip()[:200]
    return request


def _post_json(url: str, payload: dict, timeout: float) -> Tuple[int, bytes]:
    """标准库的 HTTPS POST —— **刻意不引第三方 HTTP 客户端**。

    理由: 本包唯一的运行时依赖是 `pyserial`(经 SDK) + `fastapi`/`uvicorn`, 打包时全都要
    随包内嵌; 为了一个 POST 再背一个客户端库不划算。`ssl` 走系统默认信任库, Windows 上
    Python 也会加载系统证书, 不需要 `certifi`。
    """
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "application/json",
            # 只报"这是本上位机", 不带任何个人/设备信息 —— 个人信息都在 body 里, 由用户同意过。
            "User-Agent": "litearm-studio",
        })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:   # noqa: S310 - 地址由本包常量/命令行决定
            return int(resp.status), resp.read(MAX_RESPONSE_BYTES)
    except urllib.error.HTTPError as e:                              # 4xx/5xx 也是应答, 交给上层归类
        try:
            return int(e.code), e.read(MAX_RESPONSE_BYTES)
        finally:
            e.close()


def _service_error(status: int, body: bytes) -> ActivationError:
    """把服务端的错误应答折成带 `reason` 的异常 —— 能说清就说清, 说不清就如实说。"""
    code = None
    message = ""
    try:
        doc = json.loads(body.decode("utf-8", "replace"))
        err = doc.get("error") if isinstance(doc, dict) else None
        if isinstance(err, dict):
            code = err.get("code")
            message = str(err.get("message") or "")
    except ValueError:
        pass
    known = {"not_found", "invalid_uid", "consent_required", "rate_limited",
             "maintenance", "code_required"}
    reason = code if code in known else "server"
    detail = message or f"激活服务返回 HTTP {status}"
    return ActivationError(reason, f"{detail} (HTTP {status})")


def request_license(base_url: str, request: dict, *, timeout: float = REQUEST_TIMEOUT_S,
                    post: Callable[[str, dict, float], Tuple[int, bytes]] = _post_json,
                    expected_uid: Optional[str] = None) -> Dict[str, Any]:
    """提交注册信息, 拿回这台机器的凭据 (已按 `parse_license` 解析)。

    `post` 可注入 —— 测试用它替换掉真网络, 于是这条路径的用例不需要联网。
    """
    if not base_url:
        raise ActivationError(
            "unconfigured",
            "未配置激活服务地址 —— 请用 --activation-url 指定")
    url = base_url.rstrip("/") + ACTIVATION_PATH
    try:
        status, body = post(url, request, timeout)
    except ActivationError:
        raise
    except urllib.error.URLError as e:
        raise ActivationError("unreachable", f"连不上激活服务: {e.reason}") from None
    except OSError as e:
        raise ActivationError("unreachable", f"连不上激活服务: {e}") from None

    if not 200 <= status < 300:
        raise _service_error(status, body)
    try:
        doc = json.loads(body.decode("utf-8", "replace"))
    except ValueError:
        raise ActivationError("bad_response", "激活服务返回的不是合法 JSON") from None
    # ⚠ 领回来的文件也要**过同一道解析**, 且核对 UID: 服务端发错文件时, 本地就能拦下。
    try:
        return parse_license(doc, expected_uid=expected_uid)
    except LicenseFileError as e:
        raise ActivationError("bad_response", f"激活服务返回的凭据不可用: {e}") from None
