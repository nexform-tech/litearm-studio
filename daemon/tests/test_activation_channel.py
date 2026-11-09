"""Tests for the runtime internal activation channel.

The channel is configuration, not a build flavor: these tests pin where the
token is read from, which headers it produces, and the rule that it never
crosses a plain HTTP socket or appears in logs.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Dict, Mapping, Optional

import pytest

from litearm_studio_daemon import activation, activation_channel
from litearm_studio_daemon.activation_channel import (
    CHANNEL_HEADER,
    CONFIG_ENV,
    TOKEN_ENV,
    TOKEN_HEADER,
    channel_headers,
    channel_token,
    default_config_path,
    is_https,
)

TOKEN = "a" * 64


class _Response:
    status = 200

    def read(self, _limit: int) -> bytes:
        return b"{}"

    def __enter__(self) -> "_Response":
        return self

    def __exit__(self, *_exc: object) -> bool:
        return False


def _capture_urlopen(monkeypatch: pytest.MonkeyPatch) -> Dict[str, object]:
    captured: Dict[str, object] = {}

    def fake_urlopen(request, timeout):
        captured["request"] = request
        captured["timeout"] = timeout
        return _Response()

    monkeypatch.setattr(activation.urllib.request, "urlopen", fake_urlopen)
    return captured


def _headers(request) -> Dict[str, str]:
    return {key.lower(): value for key, value in request.headers.items()}


def _missing_config(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Keep the tests away from a developer's real ``~/.config`` file."""
    monkeypatch.delenv(TOKEN_ENV, raising=False)
    monkeypatch.setenv(CONFIG_ENV, str(tmp_path / "missing.json"))


def test_channel_headers_are_empty_without_a_token() -> None:
    assert channel_headers("") == {}


def test_channel_headers_carry_the_test_marker() -> None:
    assert channel_headers(TOKEN) == {
        CHANNEL_HEADER: "test",
        TOKEN_HEADER: TOKEN,
    }


def test_env_token_wins_over_the_file(tmp_path: Path) -> None:
    path = tmp_path / "activation-channel.json"
    path.write_text(json.dumps({"token": "file-token"}), encoding="utf-8")

    assert channel_token(
        environ={TOKEN_ENV: f"  {TOKEN}  "},
        config_path=path,
    ) == TOKEN


def test_file_token_is_read_and_trimmed(tmp_path: Path) -> None:
    path = tmp_path / "activation-channel.json"
    path.write_text(json.dumps({"token": f"  {TOKEN}  "}), encoding="utf-8")

    assert channel_token(environ={}, config_path=path) == TOKEN


@pytest.mark.parametrize("content", [None, "{", "[]", '{"token": 123}'])
def test_missing_or_malformed_file_means_no_token(
    tmp_path: Path, content: Optional[str]
) -> None:
    path = tmp_path / "activation-channel.json"
    if content is not None:
        path.write_text(content, encoding="utf-8")

    assert channel_token(environ={}, config_path=path) == ""


def test_a_directory_instead_of_a_file_means_no_token(tmp_path: Path) -> None:
    assert channel_token(environ={}, config_path=tmp_path) == ""


def test_config_env_overrides_the_path() -> None:
    env: Mapping[str, str] = {CONFIG_ENV: "/tmp/custom-channel.json"}
    assert default_config_path(env) == Path("/tmp/custom-channel.json")


def test_default_path_uses_xdg_config_home() -> None:
    env: Mapping[str, str] = {"XDG_CONFIG_HOME": "/tmp/xdg"}
    assert default_config_path(env) == Path(
        "/tmp/xdg/litearm-studio/activation-channel.json"
    )


def test_default_path_uses_appdata_on_windows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(activation_channel.sys, "platform", "win32")
    env: Mapping[str, str] = {"APPDATA": "/tmp/appdata"}
    assert default_config_path(env) == Path(
        "/tmp/appdata/litearm-studio/activation-channel.json"
    )


@pytest.mark.parametrize("url,expected", [
    ("https://act.nexform.tech/api/v1/license", True),
    ("HTTPS://act.nexform.tech/api/v1/license", True),
    ("http://act.nexform.tech/api/v1/license", False),
    ("ftp://act.nexform.tech/license", False),
    ("not a url", False),
])
def test_is_https(url: str, expected: bool) -> None:
    assert is_https(url) is expected


def test_post_adds_channel_headers_on_https(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _missing_config(monkeypatch, tmp_path)
    monkeypatch.setenv(TOKEN_ENV, TOKEN)
    captured = _capture_urlopen(monkeypatch)

    status, body = activation._post_json(
        "https://act.example/api/v1/license", {"uid": "x"}, 1.0
    )

    assert (status, body) == (200, b"{}")
    headers = _headers(captured["request"])
    assert headers[CHANNEL_HEADER.lower()] == "test"
    assert headers[TOKEN_HEADER.lower()] == TOKEN


def test_post_reads_the_config_file(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    path = tmp_path / "activation-channel.json"
    path.write_text(json.dumps({"token": TOKEN}), encoding="utf-8")
    monkeypatch.delenv(TOKEN_ENV, raising=False)
    monkeypatch.setenv(CONFIG_ENV, str(path))
    captured = _capture_urlopen(monkeypatch)

    activation._post_json("https://act.example/api/v1/license", {}, 1.0)

    assert _headers(captured["request"])[TOKEN_HEADER.lower()] == TOKEN


def test_post_omits_channel_headers_without_a_token(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _missing_config(monkeypatch, tmp_path)
    captured = _capture_urlopen(monkeypatch)

    activation._post_json("https://act.example/api/v1/license", {}, 1.0)

    headers = _headers(captured["request"])
    assert CHANNEL_HEADER.lower() not in headers
    assert TOKEN_HEADER.lower() not in headers


def test_post_does_not_send_the_token_over_http(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    _missing_config(monkeypatch, tmp_path)
    monkeypatch.setenv(TOKEN_ENV, TOKEN)
    captured = _capture_urlopen(monkeypatch)

    with caplog.at_level(logging.WARNING, logger="litearm_studio_daemon.activation"):
        activation._post_json("http://act.example/api/v1/license", {}, 1.0)

    headers = _headers(captured["request"])
    assert CHANNEL_HEADER.lower() not in headers
    assert TOKEN_HEADER.lower() not in headers
    assert "not HTTPS" in caplog.text
    assert TOKEN not in caplog.text
