# Build image for the Debian package (`make deb`).
#
# Who reads this: anyone who has to produce a `.deb` outside the release workflow, and
# anyone wondering why a local build needs a container at all.
#
# ⚠ **Why Ubuntu 22.04 and not the host.** `packaging/build.py` freezes a Python runtime
# into an executable, and that runtime links against the build machine's glibc. Built
# on a newer distro it refuses to start on the older ones we ship to: a Debian 13 build
# (glibc 2.41) wants glibc >= 2.38 and dies on Ubuntu 22.04 (2.35) and 24.04 (2.39) alike.
# It would also collect the build machine's GTK to sit next to the target's system
# WebKitGTK. `.github/workflows/release.yml` builds on ubuntu-22.04 for the same reason;
# this image is that environment, pinned and reusable.
#
# Build it once (the entry point does this for you when it is missing):
#
#     docker build -f packaging/deb.Dockerfile -t litearm-studio-deb-builder:22.04 .
#
# Then a package build is ~90 seconds instead of ~4 minutes: without the image every run
# reinstalls the apt packages and the whole Python dependency set.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# `python3-gi` + `gir1.2-webkit2-4.1` are the system WebKitGTK the Linux build borrows (the
# alternative is bundling a 200 MB Chromium). `gir1.2-webkit2-4.1` is also what the produced
# `.deb` asks for; see packaging/deb.py's WEBKIT_DEPENDS.
#
# ⚠ `binutils` is not optional: PyInstaller needs `objdump`, and a minimal image does not
# have it — the build dies late, inside PyInstaller, with a message about it.
#
# ⚠ `libpython3.10` is not optional either: `python3-venv` alone does not bring the shared
# library PyInstaller links the frozen bundle against.
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends \
        python3-venv \
        python3-gi \
        gir1.2-webkit2-4.1 \
        binutils \
        libpython3.10 \
        git \
        ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# ⚠ `librsvg2-2` + `librsvg2-common` used to decide what the package carried: PyInstaller
# collected the GTK stack *plus* the Adwaita icon theme (whose icons are SVG), and loading an
# SVG through GdkPixbuf needs the `libpixbufloader-svg.so` loader that `librsvg2-common`
# installs. `packaging/hooks/hook-gi.py` now stops all of that from being collected — the
# desktop stack, the icon themes and the loaders come from the target machine — so neither
# of these two changes the artifact any more.
#
# They stay so that this image remains step for step with the `package` job's runner: a
# locally built `.deb` should come off the same machine as the released one. Do not add
# anything here for the GTK stack's sake again — that is what the hooks are for now.
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends \
        librsvg2-2 \
        librsvg2-common \
 && rm -rf /var/lib/apt/lists/*

# The build venv comes from the **system** python: `python3-gi` is installed for that
# interpreter, and `--system-site-packages` is the channel that makes it visible here.
# A venv made by a pip-installed python would not see `/usr/lib/python3/dist-packages`.
#
# ⚠ The SDKs are **not** baked in. They are git submodules of the repository being
# packaged (`sdk/`), and `deb_build.sh` installs them from the tree copy — so this image
# pins no SDK version, and a locally built `.deb` carries exactly the tag the checkout
# pins. Only their dependencies are baked here, so that step needs no network: `pyserial`
# is the whole of litearm-python's dependency list, and litegrip has none.
RUN /usr/bin/python3 -m venv --system-site-packages /venv \
 && /venv/bin/python -m pip install -q --upgrade pip setuptools wheel \
 && /venv/bin/python -m pip install -q pyserial

# The daemon's dependencies: its `dependencies` list plus the `test` and `ui` extras from
# daemon/pyproject.toml, and PyInstaller. They are **pinned to exact versions here, and
# this file is the pin** — the image exists so that a cached one and a freshly built one
# resolve the same thing, which an unpinned `pip install` cannot promise once upstream
# publishes. `packaging/tests/test_builder_image.py` reads both files and fails when the
# two lists drift, so a dependency added to pyproject.toml cannot miss the image.
#
# ⚠ `setuptools` above is upgraded for the same reason `deb_build.sh` can install the
# daemon into this venv: the editable install is PEP 660, and Ubuntu 22.04 ships
# setuptools 59, which cannot build one (it would fall back to downloading a modern
# setuptools at every build).
#
# --- the dependency pin (parsed by packaging/tests/test_builder_image.py) ---
RUN /venv/bin/python -m pip install -q \
        fastapi==0.143.0 \
        "uvicorn[standard]==0.54.0" \
        pyusb==1.3.1 \
        libusb-package==1.0.30.0 \
        pywebview==6.2.1 \
        pytest==9.1.1 \
        httpx==0.28.1 \
        pyinstaller==6.22.3
# --- end of the dependency pin ---

# `packaging/deb_build.sh` runs inside this image; `scripts/build-deb.sh` is the entry point
# on the host. Neither is copied in — they are mounted read-only per run, so editing them
# does not need a rebuild.
CMD ["bash", "-lc", "echo 'this image is meant to be run by scripts/build-deb.sh'"]
