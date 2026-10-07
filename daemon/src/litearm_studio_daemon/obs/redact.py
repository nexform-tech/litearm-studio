"""Keep credentials, personal data and image bytes out of every log record.

Who reads this: anyone adding a field to a log call, and anyone reviewing
whether a new log line is safe to write to disk.

The rule this module enforces is **redact by construction**, not by care. A
daemon log record is written to a file that survives the process, may be
attached to a bug report and may be piped into a log platform; the activation
path carries the device UID, the operator's registration form and a signed
licence blob, and the firmware path carries a whole firmware image. Those must
never appear, and "remember not to log them" is not a control.

Two mechanisms, in order:

1. :func:`command_arguments` — commands whose *parameters* are sensitive get an
   explicitly built summary instead of the raw dict. The summary says what came
   in (how many bytes, which fields) so the record is still useful, without the
   values. This runs first because it can see the command name.
2. :func:`sanitize` — every value that reaches a record walks through this, which
   drops any key named in :data:`SENSITIVE_KEYS` at any depth and truncates
   anything too long to be a field.

A **do not**: do not add a field to a record and rely on it being "just a
number". `sanitize` is the only gate between a call site and the JSONL file, so
a value that has not been through it is unvetted.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, Mapping, Tuple

#: Values longer than this are replaced by a truncated form plus a byte count.
#: It exists because a log field is for reading, not for carrying documents: a
#: 200 KB string in a JSONL line makes the file unusable in a terminal, in `jq`
#: and in most UIs.
MAX_STRING_CHARS = 512

#: Field names that must never carry a value, matched case-insensitively at any
#: depth. Some are credentials, some are personal data, some are binary blobs.
#:
#: `uid` is here because it is the device's licence identifier and is treated as
#: a credential by the activation service; the *presence* of a UID is often
#: useful (`has_uid`), the value is not ours to persist.
#:
#: ⚠ Deliberately **not** a generic word. `data`, `value` or `args` would redact
#: ordinary command parameters (`movej` sends `{"q": [...]}`, `set_speed` sends
#: `{"percent": 40}`) and turn the command log into noise. The firmware image's
#: `data` key is handled by :func:`command_arguments`, which knows the command.
SENSITIVE_KEYS: frozenset = frozenset({
    "image", "blob", "raw", "payload",
    "token",
    "license", "licence", "lic",  # the signed blob from the activation service
    "uid", "device_uid", "deviceuid",
    "contact",          # the operator's registration form (name/phone/email/…)
    "signature", "secret", "password", "api_key", "apikey", "auth",
})

#: Keys that carry binary/large payloads and are only sensitive **for certain
#: commands**. Checked by :func:`command_arguments`, never by :func:`sanitize`.
_PAYLOAD_KEYS: frozenset = frozenset({"data", "image", "blob", "raw", "bytes", "payload"})

#: Replaces a sensitive value. Spelled out rather than removed so a reader can
#: tell "the daemon does not log this" from "the daemon had nothing to log".
REDACTED = "[redacted]"

#: Parameters of an `activate` request that stay useful without the payload:
#: whether consent was granted, and the diagnostic version string. Everything
#: else in that request — the contact form above all — is dropped.
_ACTIVATION_SAFE_KEYS = ("consent", "diagnostics", "code")

#: Commands whose parameters are *entirely* replaced by a summary. The set is
#: small and explicit on purpose: adding a command here is a decision that its
#: arguments are not safe to log.
_OPAQUE_ARGUMENT_COMMANDS = ("firmware_inspect", "firmware_upgrade")


def _is_sensitive(key: str) -> bool:
    return key.strip().lower() in SENSITIVE_KEYS


def _shorten(text: str) -> str:
    if len(text) <= MAX_STRING_CHARS:
        return text
    return f"{text[:MAX_STRING_CHARS]}… ({len(text)} chars)"


def sanitize(value: Any, *, _depth: int = 0) -> Any:
    """A JSON-safe copy of ``value`` with sensitive keys replaced by a marker.

    Rules, applied recursively:

    * a mapping or sequence is walked, never passed through as-is;
    * a key in :data:`SENSITIVE_KEYS` becomes ``"[redacted]"`` whatever its
      value — including a nested dict, so ``{"contact": {...}}`` cannot smuggle
      the form through;
    * a non-JSON leaf (an SDK object, a bytes buffer, an exception) becomes its
      ``repr``, shortened, because it cannot be serialised and losing the line
      is worse than losing the object;
    * strings longer than :data:`MAX_STRING_CHARS` are truncated with a count.

    ``_depth`` guards against a self-referential structure; nothing in the
    daemon produces one, but a log call must not be able to hang the caller.
    """
    if _depth > 12:
        return "…"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return _shorten(value)
    if isinstance(value, Mapping):
        out: Dict[str, Any] = {}
        for key, item in value.items():
            name = str(key)
            out[name] = REDACTED if _is_sensitive(name) else sanitize(item, _depth=_depth + 1)
        return out
    if isinstance(value, (list, tuple, set, frozenset)):
        return [sanitize(item, _depth=_depth + 1) for item in value]
    return _shorten(repr(value))


def command_arguments(method: str, params: Mapping[str, Any]) -> Dict[str, Any]:
    """Safe ``fields`` for one command, given its raw parameters.

    Three shapes, by how sensitive the command is:

    * :data:`_OPAQUE_ARGUMENT_COMMANDS` — only the parameter **names** and each
      value's size survive. A firmware image is megabytes of base64; a licence
      token identifies the activation session. Neither belongs in a file.
    * ``activate`` — the request is rebuilt from the keys that are not personal
      data, so the record can still say "consent granted, studio 1.4.2" without
      carrying the operator's name and phone number.
    * anything else — walked by :func:`sanitize`; a payload-like key (`data`,
      `image`, `blob`, …) is replaced by a size summary rather than sanitized,
      so a command that uploads bytes cannot put them in the file even though
      the key name alone is not treated as sensitive.

    ⚠ The activation path is the one place where the parameter dict *is* the
    payload. If you add a field to ``ActivationRequest``, decide here whether it
    is safe, because the default for that shape is "not copied".
    """
    if method in _OPAQUE_ARGUMENT_COMMANDS:
        summary: Dict[str, Any] = {}
        for key in sorted(params):
            item = params[key]
            name = str(key)
            if _is_sensitive(name):
                summary[name] = REDACTED
            elif name.lower() in _PAYLOAD_KEYS:
                summary[name] = _payload_note(item)
            elif isinstance(item, bool):
                # `confirm` is a safety gate the operator had to tick; its value
                # is the one thing about an upgrade request worth recording.
                summary[name] = item
            else:
                summary[name] = sanitize(item)
        return summary

    if method == "activate":
        out: Dict[str, Any] = {}
        for key in _ACTIVATION_SAFE_KEYS:
            if key in params:
                value = params[key]
                # `consent` is {"granted": bool} and carries nothing personal;
                # `diagnostics` is three version strings.
                out[key] = sanitize(value)
        out["contact_fields"] = _contact_field_names(params.get("contact"))
        return out

    out = {}
    for key, item in params.items():
        name = str(key)
        if _is_sensitive(name):
            # A named credential (`token`, `uid`) is redacted outright; only a
            # generic payload key gets the softer size note.
            out[name] = REDACTED
        elif name.lower() in _PAYLOAD_KEYS:
            out[name] = _payload_note(item)
        else:
            out[name] = sanitize(item)
    return out


def _payload_note(value: Any) -> str:
    """What a payload key looked like, without what it held."""
    if isinstance(value, (str, bytes, bytearray)):
        return f"<{len(value)} chars, not logged>"
    return REDACTED


def _contact_field_names(contact: Any) -> Iterable[str]:
    """The *names* of the submitted registration fields, never their values.

    Field names are a fixed part of the contract (see ``ActivationContact``), so
    recording them confirms "the form was filled" without persisting a name,
    phone number, email address or region.
    """
    if not isinstance(contact, Mapping):
        return []
    return sorted(str(key) for key in contact)


def appears_redacted(fields: Mapping[str, Any]) -> bool:
    """Does this record carry a redaction marker? Used by tests and review only."""
    for value in fields.values():
        if value == REDACTED:
            return True
        if isinstance(value, Mapping) and appears_redacted(value):
            return True
        if isinstance(value, (list, tuple)):
            for item in value:
                if isinstance(item, Mapping) and appears_redacted(item):
                    return True
    return False


def assert_clean(record: Mapping[str, Any], *, forbidden: Tuple[str, ...] = ()) -> None:
    """Raise if ``record`` still contains a sensitive key or a forbidden value.

    This is the tripwire the tests use: it turns "we remembered to redact" into a
    check that fails when someone forgets. ``forbidden`` carries exact strings
    (a UID, a phone number) that must not appear anywhere in the serialised
    record.
    """
    blob = repr(record)
    for needle in forbidden:
        if needle and needle in blob:
            raise AssertionError(f"record leaks {needle!r}: {blob[:400]}")
    _assert_keys_clean(record, path="$")


def _assert_keys_clean(value: Any, *, path: str) -> None:
    if isinstance(value, Mapping):
        for key, item in value.items():
            name = str(key)
            if _is_sensitive(name) and item != REDACTED:
                raise AssertionError(f"sensitive key {path}.{name} carries a value")
            _assert_keys_clean(item, path=f"{path}.{name}")
    elif isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            _assert_keys_clean(item, path=f"{path}[{index}]")
