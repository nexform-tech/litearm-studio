"""Shared fixtures for the daemon suite.

Two groups live here, both because a test must be reproducible on a machine it
does not own.

**Gripper calibration.** Read this before writing a gripper test that commands a
millimetre target. `ChannelConfig.mount` defaults to `normal`, so a channel with no
measured calibration file resolves to the SDK's *nominal template* (§5.3 row 5).
That is the production resting state, and its gate (`TEMPLATE`) deliberately
refuses every millimetre target. A test about motion therefore has to say where its
measured calibration comes from; it must not inherit whatever `$HOME` the machine
running the suite happens to have.

`measured_home` is that answer: a private `$HOME` holding one measured calibration
for `can0`, already in the resolution order's row 2. It is deliberately **not**
autouse — the calibration suite builds its own `$HOME` to walk the resolution order
row by row, and pre-seeding row 2 would shadow the rows those tests are about.
Request it where a measured calibration is the premise, which is what the autouse
fixtures in `test_gripper_session.py` and `test_gripper_server.py` do.

**The `log_meta` handshake frame.** The daemon announces its structured-log stream
position when a client connects (`server.Daemon._log_meta`), so a test that reads
"the next frame" after sending a command gets `log_meta` rather than the `res` it
meant to assert on. Use `await_response` / `next_frame` instead of `receive_json`
for that. Skipping is correct rather than reordering: the announcement has to
arrive *before* records start flowing, or a page cannot tell a gap from silence.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

import pytest

from litearm_studio_daemon import obs, ports
from litearm_studio_daemon.gripper import calibration, constants

#: A valid measured calibration for the reference 85 mm unit, normal mount.
#: The same numbers `test_gripper_calibration.py` pins the resolution order with.
MEASURED_CALIBRATION: dict[str, Any] = {
    "channel": constants.CAN_CHANNEL,
    "can_id": 0x08,
    "zero_position_rad": 1.775959,
    "max_position_rad": -0.064279,
    "travel_range_rad": 1.840238,
    "rad_to_mm": 46.73,
}


@pytest.fixture
def measured_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A private ``$HOME`` with exactly one measured calibration for ``can0``.

    Every caller gets a clean, identical answer to "what calibration is in
    effect", so none of them can read the calibration of the machine running the
    tests, and none can write to it either.
    """
    home = tmp_path / "home"
    path = home / ".litegrip" / f"{constants.CAN_CHANNEL}_calibration.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(MEASURED_CALIBRATION), encoding="utf-8")
    monkeypatch.setenv("HOME", str(home))
    # An environment override would outrank row 2 and silently replace the file
    # above (row 3), which is exactly the kind of surprise this fixture removes.
    monkeypatch.delenv(calibration.CALIB_ENV, raising=False)
    return home


@pytest.fixture(autouse=True)
def no_obs_sink():
    """Drop the structured-log sink after each test.

    The sink is process-global by design (one daemon per process in production),
    so a test that builds an app would otherwise leave its sink registered and
    route the next test's records into a dead daemon.
    """
    yield
    obs.set_sink(None)


@pytest.fixture(autouse=True)
def private_arm_port_record(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A private ``arm.json`` for the "last port the arm connected on" record.

    Autouse, because the leak would bite in both directions.  A successful
    ``connect()`` **writes** the record, so without this every connecting test
    would drop a fake port (``fake``, ``/dev/ttyACM0``…) into the home directory
    of whoever runs the suite.  And a record already sitting there would be read
    back as the first candidate of ``Session._connect_candidates`` — a developer
    who once picked a port in the UI would then connect to something else than CI
    does.
    """
    path = tmp_path / "arm.json"
    monkeypatch.setenv(ports.CONFIG_ENV, str(path))
    return path
