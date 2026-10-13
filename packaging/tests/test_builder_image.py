"""Tests for the pin in `packaging/deb.Dockerfile`: the build image's dependency list.

Who reads this: anyone changing what the `.deb` build installs. The image bakes the
daemon's dependencies so a build needs no network and a cached image behaves like a fresh
one; the lists had no check at all before this file, so the two could drift apart silently
until a build failed — or, worse, until a bundle shipped without something.
"""
from __future__ import annotations

import pathlib
import re
import tomllib

ROOT = pathlib.Path(__file__).resolve().parents[2]
DOCKERFILE = ROOT / "packaging" / "deb.Dockerfile"
PYPROJECT = ROOT / "daemon" / "pyproject.toml"

#: Extras of `daemon/pyproject.toml` the image installs. `ui-qt` is deliberately absent:
#: Qt is the self-contained fallback for machines without the system WebKitGTK, and baking
#: it would add ~200 MB to every image for a backend the release build does not use.
EXTRAS = ("test", "ui")


#: The Dockerfile delimits the pin with these comments, so this test does not have to
#: guess which of its `pip install` steps is the dependency list (`pyserial` and the venv's
#: own tooling are installed elsewhere).
START = "--- the dependency pin"
END = "# --- end of the dependency pin ---"


def _pin_requirements() -> list[str]:
    """The pinned requirements of the image's dependency list."""
    text = DOCKERFILE.read_text(encoding="utf-8")
    assert START in text and END in text, (
        "the dependency pin's delimiters are gone from packaging/deb.Dockerfile — "
        "either restore them or update this test")
    block = text.split(START, 1)[1].split(END, 1)[0]
    tokens = [token for token in block.replace("\\", " ").split()
              if not token.startswith("#")]
    start = tokens.index("-q") + 1
    return tokens[start:]


def _name(requirement: str) -> str:
    """`'"uvicorn[standard]==0.54.0"'` → `"uvicorn"`.

    The shell quotes an extras-bearing requirement (`[standard]` is a glob), so the quotes
    come off here; everything from the first version/extras/marker character onwards is the
    part that is not the name.
    """
    return re.split(r"[<>=!\[;\s]", requirement.strip("\"'"), maxsplit=1)[0].lower()


def _pyproject_requirements() -> set[str]:
    with PYPROJECT.open("rb") as handle:
        project = tomllib.load(handle)["project"]
    extras = project.get("optional-dependencies", {})
    requirements = list(project["dependencies"])
    for extra in EXTRAS:
        assert extra in extras, f"daemon/pyproject.toml has no `{extra}` extra"
        requirements += extras[extra]
    return {_name(requirement) for requirement in requirements}


def test_image_installs_the_daemons_dependencies():
    """Every dependency the daemon declares is in the image, and nothing else is."""
    pinned = {_name(requirement) for requirement in _pin_requirements()}
    assert pinned == _pyproject_requirements() | {"pyinstaller"}


def test_image_pins_every_version():
    """`pinned and reusable` is the image's whole claim — so each entry carries a version.

    An unpinned entry resolves to whatever upstream published today, which is what made a
    cached image and a fresh one disagree over time.
    """
    unpinned = [req for req in _pin_requirements() if "==" not in req]
    assert unpinned == [], f"unpinned in packaging/deb.Dockerfile: {unpinned}"


def test_image_does_not_bake_the_daemon_or_the_sdks():
    """The daemon and both SDKs come from the checkout, never from the image.

    A baked copy would be shadowed by the editable install `deb_build.sh` performs — or
    worse, shadow it — and the `.deb` would then carry code from an older commit than the
    one being packaged.
    """
    pinned = {_name(requirement) for requirement in _pin_requirements()}
    assert "litearm-studio-daemon" not in pinned
    assert "litearm-python" not in pinned
    assert "litegrip" not in pinned
