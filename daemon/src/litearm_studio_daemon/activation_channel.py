"""Internal test channel for activation requests.

The same Studio build is shipped to internal testers and customers. The
internal channel is therefore runtime configuration, not a build flavor: when a
token is present, the license request carries two extra headers; without it,
the request is byte-for-byte the production request.

Token sources, highest priority first:

1. ``LITEARM_ACTIVATION_CHANNEL_TOKEN``.
2. The ``token`` key in the JSON file at :func:`default_config_path`.

The activation service checks the token. A missing or wrong token is treated as
a normal production request, so a customer who finds this module still cannot
claim test credentials. The token is never logged.

Config file locations:

* ``LITEARM_STUDIO_ACTIVATION_CHANNEL_CONFIG`` overrides the path.
* Windows: ``%APPDATA%\\litearm-studio\\activation-channel.json``.
* Linux/macOS: ``$XDG_CONFIG_HOME/litearm-studio/activation-channel.json``,
  or ``~/.config/litearm-studio/activation-channel.json``.

Reading a missing, malformed, or foreign file means "no token"; it never
raises. Activation is not a diagnostic flow, and a broken optional config must
not stop a customer from activating.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Dict, Mapping, Optional
from urllib.parse import urlsplit

#: Environment override for the config file's location.
CONFIG_ENV = "LITEARM_STUDIO_ACTIVATION_CHANNEL_CONFIG"

#: Environment variable that carries the token directly.
TOKEN_ENV = "LITEARM_ACTIVATION_CHANNEL_TOKEN"

CHANNEL_HEADER = "X-Litearm-Channel"
TOKEN_HEADER = "X-Litearm-Channel-Token"

#: The only channel value the service accepts.
TEST_CHANNEL = "test"


def default_config_path(environ: Optional[Mapping[str, str]] = None) -> Path:
    """The per-user config file, expanded but not created."""
    env = os.environ if environ is None else environ

    override = str(env.get(CONFIG_ENV, "")).strip()
    if override:
        return Path(override).expanduser()

    if sys.platform == "win32":
        appdata = str(env.get("APPDATA", "")).strip()
        if appdata:
            return Path(appdata).expanduser() / "litearm-studio" / "activation-channel.json"

    base = str(env.get("XDG_CONFIG_HOME", "")).strip()
    root = Path(base).expanduser() if base else Path.home() / ".config"
    return root / "litearm-studio" / "activation-channel.json"


def channel_token(
    *,
    environ: Optional[Mapping[str, str]] = None,
    config_path: Optional[Path] = None,
) -> str:
    """Return the configured token, or an empty string.

    The environment variable wins over the file, so a temporary test run can
    override a file without editing it.
    """
    env = os.environ if environ is None else environ

    token = str(env.get(TOKEN_ENV, "")).strip()
    if token:
        return token

    path = config_path if config_path is not None else default_config_path(env)
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    if not isinstance(document, dict):
        return ""

    value = document.get("token")
    return value.strip() if isinstance(value, str) else ""


def channel_headers(token: str) -> Dict[str, str]:
    """Headers for a valid-looking token; empty when there is no token."""
    if not token:
        return {}
    return {CHANNEL_HEADER: TEST_CHANNEL, TOKEN_HEADER: token}


def is_https(url: str) -> bool:
    """True only for an HTTPS URL; the token must not cross a plain socket."""
    try:
        return urlsplit(url).scheme.lower() == "https"
    except ValueError:
        return False
