"""LiteGrip gripper support for the studio daemon.

This package is the Qt-free control core of ``litegrip-studio``, lifted into the
daemon (both repositories are Apache-2.0 and owned by the same organization) and
adapted to the studio's single-WebSocket contract.  What was lifted, and what is
new here, is listed in ``docs/GRIPPER_INTEGRATION.md`` §3.1.

Layers, unchanged from the lifted code:

``constants``, ``units``, ``calibration``, ``telemetry``
    Pure policy and arithmetic.  Standard library only; ``calibration`` never
    asks the SDK what it loaded.
``core``
    The trajectory, the motion state machine, the calibration state machines and
    :class:`~litearm_studio_daemon.gripper.core.worker.WorkerLoop` — the one
    thread that touches a backend.  No Qt, no threads of its own.
``backend``
    The only layer that touches hardware.  ``plant`` is a pure dynamics model,
    ``sim`` puts a real-time clock and fault injection behind it, ``real`` wraps
    the SDK (imported lazily, and only on Linux).

New in this package:

``config``
    The per-channel device record the daemon persists next to its settings.
``session``
    Adapts :class:`WorkerLoop` to the daemon: the tick runs on its own thread,
    the loop's signal object is replaced by a callback that emits WebSocket
    frames, and ``gripper.*`` commands are translated into queued commands.
"""

from __future__ import annotations

__all__: list[str] = []
