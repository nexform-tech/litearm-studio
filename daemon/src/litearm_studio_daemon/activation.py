"""激活服务 (`act.nexform.tech`) 的客户端, 以及凭据文件 (`lic.json`) 的解析。

契约见 `docs/ACTIVATION.md`。分两半, 各自能单独测:

* :func:`parse_license` —— 凭据文件的**唯一**解析点: 在线领回来的和用户手动导入的
  都走这里 ⇒ "格式"只有一份实现, 两个入口不会漂。
* :func:`request_license` —— 往激活服务 POST 一次注册信息, 拿回这台机器的凭据。

⚠ **本模块是全仓库唯一出网的地方**。除它之外, 守护进程与前端都不碰网络 —— 这条边界
写清楚是为了将来做安全评审时能一眼答出来"这台机器会把什么发到哪里"。

⚠ 密钥不在这里, 也不该在: 服务端只是**按 UID 存取**厂商离线签好的凭据文件, 它签不了
新的。客户侧 / 服务侧都没有能算 MAC 的代码, 这是规格的硬要求。
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Optional, Tuple

from .errors import DaemonError

#: 生产地址。域名还没上线时, 任何一次提交都会如实报"连不上"——**不要**把它改成
#: "先假装成功", 那会让现场拿着一个没生效的授权去开机器。
DEFAULT_ACTIVATION_URL = "https://act.nexform.tech"

#: 服务路径 —— 契约里的一部分, 站点那边要实现的就是它。
ACTIVATION_PATH = "/api/v1/license"

#: 凭据文件自身的版本 (`lic.json` 的 `format` 字段)。认不出的版本要**拒绝并说清楚**,
#: 不能猜着解析: 猜错的结果是把一台机器写成"已激活"或写坏授权记录。
LICENSE_FORMAT = 1

#: 同意文案的版本号。⚠ 用户同意的是**某一版文案**, 将来文案改了, 靠这个字段区分
#: "他当时同意的是哪一版"。占位值是刻意的 —— 文案待法务定稿。
CONSENT_TEXT_VERSION = "draft-1"

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

#: 联系人字段的字符上限。服务端还会再判一次; 这里只是不让一次手误的粘贴把几 MB
#: 塞进请求里。`phone` 允许留空, 其余三个是必填 —— "联系方式"至少要有一个能找到人的。
CONTACT_REQUIRED = ("name", "organization", "email")
CONTACT_OPTIONAL = ("phone",)
_CONTACT_MAX = 200


def _contact_text(contact: dict, key: str, *, required: bool) -> str:
    raw = contact.get(key)
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        if required:
            raise ActivationError("missing_contact", f"缺少联系人字段 {key}")
        return ""
    if not isinstance(raw, str):
        raise ActivationError("missing_contact", f"联系人字段 {key} 必须是文本")
    text = raw.strip()
    if len(text) > _CONTACT_MAX:
        raise ActivationError("missing_contact", f"联系人字段 {key} 过长 (上限 {_CONTACT_MAX} 字)")
    return text


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
    if not isinstance(consent, dict) or consent.get("required") is not True:
        raise ActivationError("consent_required", "未同意发送注册信息 —— 请先勾选同意")

    contact = payload.get("contact")
    if not isinstance(contact, dict):
        raise ActivationError("missing_contact", "缺少联系人信息")

    request: Dict[str, Any] = {
        "uid": uid.strip().lower(),
        "contact": {key: _contact_text(contact, key, required=key in CONTACT_REQUIRED)
                    for key in CONTACT_REQUIRED + CONTACT_OPTIONAL},
        "consent": {
            "required": True,
            "diagnostics": consent.get("diagnostics") is True,
            # ⚠ 记的是**文案版本**: 将来同意文案改了, 靠它区分"他当时同意的是哪一版"。
            "text_version": CONSENT_TEXT_VERSION,
        },
    }
    if request["consent"]["diagnostics"]:
        # 只有勾了才带上。内容是版本号这类环境信息 —— 内网地址/主机名**刻意不采集**。
        diag = payload.get("diagnostics")
        diag = diag if isinstance(diag, dict) else {}
        request["diagnostics"] = {
            key: str(diag.get(key) or "")[:64] for key in ("studio", "sdk", "firmware")
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
            "未配置激活服务地址 —— 请用 --activation-url 指定, 或手动导入凭据文件")
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
