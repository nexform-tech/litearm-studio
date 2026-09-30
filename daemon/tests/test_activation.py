"""激活服务客户端与凭据文件解析 —— 契约见 `docs/ACTIVATION.md`。

全部用例**不联网**: HTTP 那一层通过 `request_license(post=...)` 注入假应答。
"""
from __future__ import annotations

import json
import urllib.error

import pytest

from litearm_studio_daemon.activation import (
    ACTIVATION_PATH,
    CONSENT_TEXT_VERSION,
    ActivationError,
    LicenseFileError,
    build_request,
    parse_license,
    request_license,
)

UID = "101112131415161718191a1b"
MAC = "00112233445566778899aabbccddeeff"


def license_doc(**over):
    doc = {"format": 1, "uid": UID, "cust_id": 1042, "issued": 20260929,
           "flags": 0, "mac": MAC}
    doc.update(over)
    return doc


#: 一份填满的注册信息 —— 八个字段与激活网站的表单一一对应。
CONTACT = {
    "name": "张三",
    "phone": "13800000000",
    "organization": "某大学",
    "wechatId": "zhangsan_wx",
    "email": "z@example.com",
    "region": "上海",
    "industry": "教育",
    "purpose": "科研教学",
}


def payload(**over):
    doc = {
        "uid": UID,
        "contact": dict(CONTACT),
        "consent": {"granted": True},
    }
    doc.update(over)
    return doc


# --------------------------------------------------------------------- 凭据文件

def test_parse_license_reads_the_documented_fields() -> None:
    lic = parse_license(license_doc())
    assert lic["uid"] == UID
    assert lic["cust_id"] == 1042 and lic["issued"] == 20260929 and lic["flags"] == 0
    # ⚠ mac 出给 SDK 时必须是 16 字节, 不是那 32 个字符。
    assert lic["mac"] == bytes.fromhex(MAC) and len(lic["mac"]) == 16


def test_parse_license_accepts_json_text_and_normalises_case() -> None:
    """手动导入那条路拿到的是**文件内容** (文本), 所以两种输入都要吃。"""
    lic = parse_license(json.dumps(license_doc(uid=UID.upper(), mac=MAC.upper())))
    assert lic["uid"] == UID and lic["mac"] == bytes.fromhex(MAC)


@pytest.mark.parametrize("raw,reason", [
    ("这不是 JSON", "not_json"),
    ("[1, 2]", "not_json"),
    ({"uid": UID}, "missing_field"),                        # 缺 format
    (license_doc(format=2), "unsupported_format"),          # 版本认不出 -> 不猜
    (license_doc(mac=None), "bad_field"),
    (license_doc(mac="00" * 15), "bad_field"),              # 少一个字节
    (license_doc(mac="zz" * 16), "bad_field"),              # 非十六进制
    (license_doc(flags=0x2), "bad_field"),                  # 保留位
    (license_doc(cust_id="1042"), "bad_field"),             # 类型不对
    (license_doc(issued=-1), "bad_field"),                  # 超范围
])
def test_parse_license_rejects_bad_files_with_a_reason(raw, reason) -> None:
    """判据必须**指出是哪个字段**, 而且带短码给界面选文案。"""
    with pytest.raises(LicenseFileError) as ei:
        parse_license(raw)
    assert ei.value.reason == reason


def test_parse_license_refuses_a_credential_for_another_machine() -> None:
    with pytest.raises(LicenseFileError) as ei:
        parse_license(license_doc(), expected_uid="ff" * 12)
    assert ei.value.reason == "uid_mismatch"
    assert UID in str(ei.value) and "ff" * 12 in str(ei.value)


def test_parse_license_lets_a_valid_credential_for_this_machine_through() -> None:
    assert parse_license(license_doc(), expected_uid=UID.upper())["cust_id"] == 1042


# --------------------------------------------------------------------- 请求体

def test_build_request_keeps_only_the_agreed_fields() -> None:
    req = build_request(payload())
    # 请求的键集就是**同意书里逐项列出的那些** —— 多一个都算暗字段。
    assert set(req) == {"uid", "contact", "consent", "diagnostics"}
    assert req["uid"] == UID
    # 八个字段与激活网站的表单同集 (`litearm-activation/src/lib/validation.ts`)。
    assert req["contact"] == CONTACT
    # 只有一份同意: 它覆盖全部字段, 所以没有逐项开关。
    assert req["consent"] == {"granted": True, "text_version": CONSENT_TEXT_VERSION}
    # 订单号那一层还没启用: 空值不许作为空字段发出去。
    assert "code" not in req


def test_build_request_refuses_without_consent() -> None:
    """**同意是硬门禁, 判在守护进程这一层** —— 界面禁用按钮挡不住直连 WS 的客户端。"""
    for consent in ({}, {"granted": False}, None):
        with pytest.raises(ActivationError) as ei:
            build_request(payload(consent=consent))
        assert ei.value.reason == "consent_required"


@pytest.mark.parametrize("field", ["name", "phone", "organization", "email", "region"])
def test_build_request_requires_the_contact_fields(field: str) -> None:
    for missing in ("去掉这个键", "留空串", "只有空白"):
        contact = dict(CONTACT)
        if missing == "去掉这个键":
            contact.pop(field)
        elif missing == "留空串":
            contact[field] = ""
        else:
            contact[field] = "   "
        with pytest.raises(ActivationError) as ei:
            build_request(payload(contact=contact))
        assert ei.value.reason == "missing_contact"
        assert field in str(ei.value)


def test_build_request_fills_absent_optional_fields_with_empty_strings() -> None:
    """选填的三个**始终在请求里** —— 网站那张表每一项都有, 缺键会让它自己判空。"""
    contact = {k: v for k, v in CONTACT.items() if k not in ("wechatId", "industry", "purpose")}
    req = build_request(payload(contact=contact))
    assert req["contact"]["wechatId"] == ""
    assert req["contact"]["industry"] == ""
    assert req["contact"]["purpose"] == ""


@pytest.mark.parametrize("field,value,reason", [
    # 判据与网站 zod 同表: 姓名不许数字、手机号 11 位、邮箱要有 @ 与点。
    ("name", "张3", "bad_name"),
    ("name", "张", "missing_contact"),                     # 少于 2 字
    ("phone", "1380000000", "bad_phone"),
    ("phone", "12800000000", "bad_phone"),                 # 第二位不是 3-9
    ("email", "z@example", "bad_email"),
    ("email", "z example.com", "bad_email"),
    ("purpose", "长" * 501, "contact_too_long"),
    ("organization", "长" * 129, "contact_too_long"),
])
def test_build_request_mirrors_the_website_form_rules(field, value, reason) -> None:
    with pytest.raises(ActivationError) as ei:
        build_request(payload(contact={**CONTACT, field: value}))
    assert ei.value.reason == reason
    assert field in str(ei.value)


def test_build_request_accepts_the_names_a_real_customer_has() -> None:
    """姓名判据不能把真实姓名挡在外面: 拉丁、连字符、撇号、间隔号、全角空格都要过。"""
    for name in ("张三", "Anne-Marie", "O'Brien", "买买提·艾力", "佐藤 優子"):
        assert build_request(payload(contact={**CONTACT, "name": name}))["contact"]["name"] == name


def test_build_request_rejects_a_bad_uid() -> None:
    for uid in ("", "0a1b", 12345, "zz" * 12):
        with pytest.raises(ActivationError) as ei:
            build_request(payload(uid=uid))
        assert ei.value.reason == "bad_uid"


def test_build_request_carries_the_versions_in_the_same_consent() -> None:
    """版本信息与联系人字段在**同一份同意书**里 —— 没有单独的开关。"""
    diag = {"studio": "0.1.0", "sdk": "2.1.0", "firmware": "Litearm1.8.0-7J"}
    assert build_request(payload(diagnostics=diag))["diagnostics"] == diag

    # 界面没给内容 -> 空串, 不是崩溃, 也不是缺字段。
    assert build_request(payload())["diagnostics"] == {"studio": "", "sdk": "", "firmware": ""}


def test_build_request_passes_an_order_code_through_when_present() -> None:
    """预留字段: 站点将来按它核对订单。今天界面上没有这个输入框。"""
    assert build_request(payload(code=" ORDER-42 "))["code"] == "ORDER-42"


# --------------------------------------------------------------------- 服务调用

def fake_post(status: int, body: dict | bytes | str):
    calls: list[tuple[str, dict, float]] = []

    def post(url, request, timeout):
        calls.append((url, request, timeout))
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        return status, raw

    return post, calls


def test_request_license_posts_to_the_contracted_url() -> None:
    post, calls = fake_post(200, license_doc())
    lic = request_license("https://act.nexform.tech/", payload(), post=post)
    assert lic["cust_id"] == 1042
    url, sent, _timeout = calls[0]
    assert url == "https://act.nexform.tech" + ACTIVATION_PATH
    assert sent == payload()


def test_request_license_refuses_before_any_network_when_unconfigured() -> None:
    post, calls = fake_post(200, license_doc())
    with pytest.raises(ActivationError) as ei:
        request_license("", payload(), post=post)
    assert ei.value.reason == "unconfigured"
    assert calls == [], "未配置却已经发出请求"


@pytest.mark.parametrize("status,body,reason", [
    (404, {"error": {"code": "not_found", "message": "没有这台机器的凭据"}}, "not_found"),
    (429, {"error": {"code": "rate_limited"}}, "rate_limited"),
    (503, {"error": {"code": "maintenance"}}, "maintenance"),
    (500, b"<html>500</html>", "server"),
    (418, {"error": {"code": "weird"}}, "server"),          # 不认识的码 -> 如实说"服务端"
])
def test_request_license_maps_service_errors(status, body, reason) -> None:
    post, _ = fake_post(status, body)
    with pytest.raises(ActivationError) as ei:
        request_license("https://act.nexform.tech", payload(), post=post)
    assert ei.value.reason == reason
    assert str(status) in str(ei.value)


@pytest.mark.parametrize("body", [
    b"not json",
    {"uid": UID},                                  # 缺字段的凭据
    license_doc(uid="ff" * 12),                    # 给的是**别的机器**的凭据
])
def test_request_license_rejects_an_unusable_body(body) -> None:
    """领回来的文件也要过同一道解析 —— 服务端发错文件时, 本地就拦下, 不写进设备。"""
    post, _ = fake_post(200, body)
    with pytest.raises(ActivationError) as ei:
        request_license("https://act.nexform.tech", payload(), post=post, expected_uid=UID)
    assert ei.value.reason == "bad_response"


def test_request_license_reports_an_unreachable_service() -> None:
    def post(url, request, timeout):
        raise urllib.error.URLError("Name or service not known")

    with pytest.raises(ActivationError) as ei:
        request_license("https://act.nexform.tech", payload(), post=post)
    assert ei.value.reason == "unreachable"
