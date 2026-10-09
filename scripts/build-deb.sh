#!/usr/bin/env bash
# Build the Debian package — the one command, on any machine with Docker.
#
# Who reads this: anyone who wants a `.deb` to install or test, without setting up an Ubuntu
# 22.04 toolchain by hand.
#
#     scripts/build-deb.sh                       # version: <latest tag>~local.<short sha>
#     scripts/build-deb.sh --version 0.17.5      # a specific version
#     scripts/build-deb.sh --no-ui               # reuse the existing dist/ build
#     scripts/build-deb.sh --rebuild-image       # after editing packaging/deb.Dockerfile
#
# Output: packaging/dist/litearm-studio_<version>_amd64.deb
#
# ⚠ Why a container instead of the host toolchain: see packaging/deb.Dockerfile. Short
# version — the frozen runtime links against the build machine's glibc, so a package built
# on a newer distro will not start on the Ubuntu releases we ship to.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${LITEARM_DEB_BUILDER_IMAGE:-litearm-studio-deb-builder:22.04}"
DOCKERFILE="$ROOT/packaging/deb.Dockerfile"
#: The arm SDK is not on PyPI; the release job checks it out next to the repository.
SDK_DIR="${LITEARM_PYTHON_SDK:-$(dirname "$ROOT")/litearm-python}"
VERSION="${LITEARM_STUDIO_VERSION:-}"
BUILD_UI=1
REBUILD_IMAGE=0

while [ $# -gt 0 ]; do
    case "$1" in
        --version) VERSION="${2:?--version needs a value}"; shift 2 ;;
        --no-ui) BUILD_UI=0; shift ;;
        --image) IMAGE="${2:?--image needs a value}"; shift 2 ;;
        --rebuild-image) REBUILD_IMAGE=1; shift ;;
        -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "[deb] unknown argument: $1" >&2; exit 2 ;;
    esac
done

if ! command -v docker >/dev/null 2>&1; then
    echo "[deb] docker is required to build a package: it pins the Ubuntu 22.04 toolchain" >&2
    echo "      the frozen runtime must be linked against (see packaging/deb.Dockerfile)." >&2
    exit 2
fi
if [ ! -d "$SDK_DIR" ]; then
    echo "[deb] no litearm-python checkout at $SDK_DIR" >&2
    echo "      it is not on PyPI: clone nexform-tech/litearm-python next to this repo," >&2
    echo "      or point LITEARM_PYTHON_SDK at an existing checkout." >&2
    exit 2
fi

if [ -z "$VERSION" ]; then
    # ⚠ `~local.<sha>` and not `+local.<sha>`: Debian sorts `1.2.3~x` BELOW `1.2.3`, so the
    # next real release still upgrades over this test build. `+` would sort above it and turn
    # installing the released package into a downgrade.
    tag="$(git -C "$ROOT" describe --tags --abbrev=0 2>/dev/null || echo v0.0.0)"
    sha="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
    VERSION="${tag#v}~local.${sha}"
fi

if [ "$REBUILD_IMAGE" = 1 ] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "[deb] building the build image $IMAGE (once; ~4 min)"
    docker build -f "$DOCKERFILE" -t "$IMAGE" "$ROOT"
fi

if [ "$BUILD_UI" = 1 ]; then
    echo "[deb] building the UI (pnpm build)"
    (cd "$ROOT" && pnpm build >/dev/null)
fi
if [ ! -f "$ROOT/dist/index.html" ]; then
    echo "[deb] no UI build at dist/index.html — run without --no-ui" >&2
    exit 2
fi

mkdir -p "$ROOT/packaging/dist"
echo "[deb] version $VERSION"
started=$(date +%s)
docker run --rm \
    -v "$ROOT":/src:ro \
    -v "$ROOT/packaging/deb_build.sh":/deb_build.sh:ro \
    -v "$ROOT/packaging/dist":/out \
    -v "$SDK_DIR":/sdk-litearm:ro \
    -e "VERSION=$VERSION" \
    "$IMAGE" bash /deb_build.sh

artifact="$ROOT/packaging/dist/litearm-studio_${VERSION}_amd64.deb"
echo "[deb] $(($(date +%s) - started))s -> $artifact"
sha256sum "$artifact"
