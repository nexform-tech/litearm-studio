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
#   (both SDKs come from the tree's `sdk/` submodules — see .gitmodules)
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

echo "[deb 1/5] copying the tree (without node_modules/.venv) and installing the pinned SDKs"
rm -rf "$WORK"
mkdir -p "$WORK"
tar -C "$SOURCE_DIR" \
    --exclude=./node_modules --exclude=./.venv --exclude=./.git \
    --exclude=./packaging/build --exclude=./.win-build \
    -cf - . | tar -C "$WORK" -xf -
cd "$WORK"

# 两个 SDK 是本仓的 git submodule, 源码随上面那次复制一起进来 —— 既不需要宿主上另有
# 一份 checkout, 也不需要额外挂载, 装的就是这次提交钉住的那个 tag。
for sdk in litearm-python litegrip-python; do
    if [ ! -d "sdk/$sdk" ]; then
        echo "[deb] sdk/$sdk 不存在 —— 先在仓库根目录跑 'make sdk'（或 git submodule update --init）" >&2
        exit 2
    fi
done
"$PY" -m pip install -q ./sdk/litearm-python ./sdk/litegrip-python

echo "[deb 2/5] checking the window backend is GTK, not a silent fallback"
"$PY" -c "import gi; gi.require_version('WebKit2', '4.1'); \
    from gi.repository import WebKit2; print('[deb] PyGObject + WebKit2 4.1 visible')"

# ⚠ Pinned explicitly, exactly as the release job does: a build machine that lost its
# WebKitGTK must fail here rather than quietly ship the 4x larger self-contained Qt build.
export LITEARM_STUDIO_WINDOW_BACKEND=gtk
export LITEARM_STUDIO_VERSION="$VERSION"

# ⚠ The directory shape, exactly as the release job does: dpkg installs a tree anyway, so
# nothing is unpacked at launch and every start is ~300 ms quicker (packaging/build.py's
# `bundle_mode()` has the measurements). The single-file artifact is a separate download
# for people who are not installing a package — it is not what this package is built from.
export LITEARM_STUDIO_BUNDLE_MODE=onedir

echo "[deb 3/5] packaging the executable as a directory (version $VERSION)"
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
