#!/usr/bin/env bash
# Build the one-file executable and the .deb from it — the part that runs INSIDE the
# Ubuntu 22.04 build image.
#
# Who reads this: anyone changing how a package is produced. The host-side entry point is
# `scripts/build-deb.sh`; it mounts the tree at /src and the output directory at /out.
#
# Environment (set by the entry point):
#   VERSION             version to stamp into the executable and the package (required)
#   SOURCE_DIR          checkout to package (default /src)
#   OUT_DIR             where the .deb lands (default /out)
#   (a checkout of litearm-python is expected at /sdk-litearm)
#
# This mirrors the `package` job of .github/workflows/release.yml step for step. When that
# job changes, change this too — a release built differently from what we test locally is
# worth less than no local build at all.
set -euo pipefail

VERSION="${VERSION:?VERSION is required}"
SOURCE_DIR="${SOURCE_DIR:-/src}"
OUT_DIR="${OUT_DIR:-/out}"
PY=/venv/bin/python
WORK=/build/studio

if [ ! -x "$PY" ]; then
    echo "[deb] no build venv at $PY — build the image first:" >&2
    echo "      docker build -f packaging/deb.Dockerfile -t litearm-studio-deb-builder:22.04 ." >&2
    exit 2
fi

# The arm SDK is not on PyPI and is installed from the host checkout: the package must carry
# the commit in *this* tree, not whatever the image was built with.
if [ -d /sdk-litearm ]; then
    rm -rf /sdk/litearm-python
    cp -a /sdk-litearm /sdk/litearm-python
fi
"$PY" -m pip install -q -e /sdk/litearm-python

echo "[deb 1/5] copying the tree (without node_modules/.venv)"
rm -rf "$WORK"
mkdir -p "$WORK"
tar -C "$SOURCE_DIR" \
    --exclude=./node_modules --exclude=./.venv --exclude=./.git \
    --exclude=./packaging/build --exclude=./.win-build \
    -cf - . | tar -C "$WORK" -xf -
cd "$WORK"

echo "[deb 2/5] checking the window backend is GTK, not a silent fallback"
"$PY" -c "import gi; gi.require_version('WebKit2', '4.1'); \
    from gi.repository import WebKit2; print('[deb] PyGObject + WebKit2 4.1 visible')"

# ⚠ Pinned explicitly, exactly as the release job does: a build machine that lost its
# WebKitGTK must fail here rather than quietly ship the 4x larger self-contained Qt build.
export LITEARM_STUDIO_WINDOW_BACKEND=gtk
export LITEARM_STUDIO_VERSION="$VERSION"

echo "[deb 3/5] packaging the one-file executable (version $VERSION)"
"$PY" packaging/build.py

echo "[deb 4/5] building the Debian package"
"$PY" packaging/deb.py \
    --binary packaging/dist/litearm-studio-daemon \
    --version "$VERSION" \
    --outdir "$OUT_DIR" \
    --work /tmp/deb-work

echo "[deb 5/5] done"
# The container may run as root while the checkout belongs to the caller's uid.
chown -R "$(stat -c %u "$SOURCE_DIR")":"$(stat -c %g "$SOURCE_DIR")" "$OUT_DIR" 2>/dev/null || true
ls -l "$OUT_DIR"
