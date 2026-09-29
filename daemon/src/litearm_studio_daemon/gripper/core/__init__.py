"""Pure control logic: trajectory generation and the control state machines.

No module here imports the SDK or Qt, and each is a function of the values
passed to it, which is what makes the whole control layer testable without
hardware — and what lets the simulator exercise the same code the real backend
runs, rather than a parallel implementation of it.

:mod:`~litearm_studio_daemon.gripper.core.worker` holds the entire loop in
:class:`WorkerLoop`, with no Qt in it at all: the daemon owns the thread, and the
loop is driven a tick at a time in tests.
"""
