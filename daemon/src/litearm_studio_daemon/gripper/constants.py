"""Every policy number in the console lives here.

Keeping them in one module means they can be unit-tested and audited without
instantiating Qt, the SDK, or a CAN bus.  Nothing here may import PyQt5 or
``litegrip`` at module scope — this file is part of the pure layer.

Where a value mirrors a constraint in the LiteGrip SDK, the SDK location is
named so the two can be re-checked when the SDK moves.
"""

from __future__ import annotations

# ── Control loop ────────────────────────────────────────────────────────────
# 200 Hz, the SDK's own MIT stream rate (can_bus.py:328 interval_s=0.005).  The
# rate is not free and this is the number that was measured, not a default: a
# move commanded at ``v`` advances the command by ``v·dt`` per tick, and when
# the jaws meet something the servo turns that whole advance into force before
# contact is noticed.  Against a blocked jaw the torque is
# ``kp·v·dt/rad_to_mm + kd·v`` at the drive — the first term is the rate's, and
# at the default 50 mm/s it is 5.4 N at 200 Hz but 10.7 N at 100 Hz, on top of a
# rate-independent 21.4 N of velocity feed-forward.  Measured on the test rig
# (``tests/test_motion_fsm.py``): a blocked move peaks at 29.6 N at 200 Hz and
# 35.8 N at 100 Hz, against a 40 N mechanical rating and a designed squeeze of
# 21.4 N.  Halving the rate therefore spends most of the margin the mechanism
# has, and it does not buy quiet either: the console's transmit is one 8-byte
# MIT frame per tick (``pack_mit_frame``), about 3 kB/s of bus time on a 1 Mbit
# link — a few per cent of it — while the frames that actually load the bus are
# the drive's own status stream, which the host does not set.  Lowering this
# would cost the squeeze margin above and change nothing an operator can hear.
# See CONTACT_LEAD_RAD below for the same arithmetic from the other end.
CTRL_HZ = 200
CTRL_DT = 1.0 / CTRL_HZ

TELEMETRY_HZ = 50
PLOT_HZ = 25

# ── Motion ──────────────────────────────────────────────────────────────────
# Speed range/default follow litearm-studio's gripper panel (5–150, default 50).
SPEED_MIN_MM_S = 5.0
SPEED_MAX_MM_S = 150.0
SPEED_DEFAULT_MM_S = 50.0

# 0 → 50 mm/s in 125 ms.  Fast enough to feel immediate, slow enough that the
# MIT loop sees no velocity step.
ACC_DEFAULT_MM_S2 = 400.0
ACC_MIN_MM_S2 = 50.0

# Arrival band.  The 16-bit q quantization is ~0.025 mm, so this band is
# servo-limited, not encoder-limited.
TOL_MM = 0.4
SETTLE_S = 0.15

# Stall detection, same order of magnitude as the SDK's own stall_delta
# (gripper.py calibrate_guided default 4e-4).
STALL_RAD = 5.0e-4
STALL_WINDOW = 20  # ticks of "no motion" before it counts as stalled

# Backstop for a move that neither arrives nor counts as stalled: it creeps
# without converging.  The deadline is proportional to the *ideal* duration of
# the move it belongs to, not fixed, because a fixed one aborts legal moves —
# at the lowest speed the UI offers (SPEED_MIN_MM_S) a full-stroke move takes
# 24 s, so any constant short enough to be a useful backstop would refuse to let
# the slow end of the speed slider work at all.
#
# The two faster detectors still cover the ordinary cases: a frozen axis trips
# the stall counter in 0.1 s, and a jam met at cruise speed trips lost-motion
# contact detection in about 20 ms.  What is left for this deadline is a short
# move that never reaches cruise, where neither of those can fire.
STALL_TIMEOUT_MIN_S = 3.0
STALL_TIMEOUT_FACTOR = 2.5

# ── Gains ───────────────────────────────────────────────────────────────────
KP_MOVE = 100.0  # SDK DEFAULT_KP (GripperParams)
KD_DEFAULT = 2.0  # SDK DEFAULT_KD
KP_GRASP = 150.0  # SDK grasp() default
KP_PROBE = 60.0  # SDK calibrate()/calibrate_guided() default
KP_BACKOFF = 80.0

# ── Force ───────────────────────────────────────────────────────────────────
# NM_TO_N mirrors litegrip.constants.UnitConversion.NM_TO_N.  The SDK applies
# this module constant, NOT the dead config.nm_to_n field.
NM_TO_N = 10.0
N_TO_NM = 1.0 / NM_TO_N

FORCE_MAX_N = 40.0  # mechanical rating — hard UI cap
FORCE_SOFT_WARN_N = 35.0
FORCE_DEFAULT_N = 12.0
# tau_max 10 Nm × NM_TO_N.  Display only, as a grey unselectable annotation —
# never reachable as a setpoint.
FORCE_THEORETICAL_MAX_N = 100.0

GRASP_STALL_CYCLES = 20

# How far 放开 opens past where the jaws are, to let go of what they are holding.
#
# Measured from the *measured* position and not from the grasp's target: a grasp
# drives to 0 mm under a force cap (``MotionFSM.grasp``), so its target is the
# closed end, and ten millimetres past that would be a command back into the
# object.  It is the operator's number, and it is at the bottom of the accepted
# travel range (``STROKE_MIN_MM``): a gripper configured with the shortest travel
# the console accepts can still open this far from a fully closed pinch.  A
# longer travel clamps at its own top, so the move is short rather than refused.
RELEASE_OPEN_MM = 10.0

# Contact detection for a force-carrying move, in two independent channels.
#
# ``CONTACT_LOST_MM`` is the primary detector and needs no hardware knowledge:
# the trajectory integrates the path it *would* have taken and compares it with
# where the jaws actually are, so a growing gap means something is in the way.
# The threshold is above the worst tracking lag of a free move (about 0.4 mm at
# full acceleration) and small enough to catch contact within 20 ms at speed.
CONTACT_LOST_MM = 1.0

# ``CONTACT_TAU_NM`` is the fast path for a hard object met at low speed, where
# the lost-motion gap accumulates slowly.  It sits above the ~0.6 Nm the
# mechanism draws merely to accelerate itself, which is what stops it firing at
# the start of every move — the reason it is not the primary detector.
CONTACT_TAU_NM = 1.5

# On a *plain* move the lost-motion gap above is a model, and on its own it is
# wrong often enough to matter: it says "the jaws should have come this far by
# now", which assumes the mechanism tracks the reference once the reference is
# at cruise.  One that lags it — friction, a tight linkage, a load, or simply too
# little gain for the speed asked for — accumulates the same millimetre while
# travelling perfectly well.  Measured in simulation against a mechanism drawing
# 0.3 Nm of Coulomb friction, a 20 mm/s move was declared "位置未随时间变化" while
# covering 87% of the distance the trajectory asked for: a stop that is not a
# safety measure but a fault, and the one an operator experiences as the axis
# lurching a couple of millimetres per command instead of going where it was
# sent.  It bites hardest at the slow end of the speed range, which is where a
# careful operator works.
#
# So on a plain move the gap only counts as an obstruction when the jaws are
# also far slower than the trajectory asked them to be.  The comparison is a
# *fraction* of the reference rather than an absolute speed, so a move at
# 5 mm/s is judged as still as one at 150 mm/s and the slow end stays usable.
# A real obstruction is unaffected — the jaws are held against something, so
# their speed collapses against whatever was asked of them — and a jaw that
# creeps into an object instead of stopping dead is left to the stall counter
# and the move deadline, both of which are unchanged and both of which still
# bound the case.
CONTACT_STILL_RATIO = 0.25

# The ratio above settles whether a *moving* jaw is lagging or held.  It cannot
# settle the other half of the same question: a jaw whose speed has collapsed
# because the console never pushed it hard enough looks exactly like one held by
# an object.  That is what the reference being anchored to the measurement costs.
# At cruise the commanded position is ``measured + v·dt``, so the position error
# the servo sees is one tick of travel and the torque behind it is ``kp·v·dt``:
# 0.2 Nm at 20 mm/s, 1.6 Nm at 150, plus ``kd·v``.  A mechanism drawing more
# friction than that does not move at the slow end of the speed range at all, and
# every detector below then reads the standstill it was handed as an obstruction.
# Measured against the plant at 1.0 Nm of Coulomb friction, a 20 mm/s move was
# declared "位置未随时间变化" 2 mm in, having never reached cruise.
#
# So a plain move's command may lead the measured position by this much, on top
# of the tick's own step.  It is a *bounded* lead, which is what keeps the
# anchored reference safe: the squeeze a plain move can apply stays
# ``kp·(CONTACT_LOST_MM + CONTACT_LEAD_RAD·rad_to_mm)/rad_to_mm`` — 25 N on the
# test rig's 46.7 mm/rad, inside the 40 N rating — instead of growing with an
# integrator.
#
# It is also applied *only* while the trajectory's ideal path is ahead of the
# jaws, so it self-titrates: a mechanism that keeps up never sees it, and one
# that does not is given exactly as much extra push as its own friction, no more.
# That is what separates it from simply commanding the ideal path, which would
# leave the axis ``kp·lead/kd`` — 0.2 rad/s, 9 mm/s — above the speed it was
# asked for, on every move, healthy or not.
#
# Sized by measurement, against the plant with Coulomb friction added.  At
# 20 mm/s the lead below unsticks 1.1 Nm — 11 N of drag, a hundred times the
# simulated unit's own free travel, and the case an operator meets as "the axis
# twitches a couple of millimetres per command and reports an obstruction".
# The flip points came out sharp: 0.002 rad covers 0.9 Nm, 0.003 covers 1.0,
# 0.004 covers 1.1.  A real mechanism's friction is not known to 10 %, so the
# margin is deliberate rather than the minimum.
#
# How much it covers is not one number, because only ``kp·lead`` in the push is
# constant: ``kp·v·dt`` and ``kd·v`` both shrink with the speed, so the lead is
# 60 % of the push at the slider's bottom and 13 % of it at the default.  Measured
# over the same plant in 0.05 Nm steps, the friction a move can still shift runs
# from 0.55 Nm at 5 mm/s to 1.1 at 50.  A mechanism stiffer than that at the
# bottom of the range is genuinely beyond the push the drive is given, and the
# console reports it as the stall it is instead of creeping a millimetre at a
# time — which is the honest half of the report this constant answers.
#
# The cost is the blocked-move peak, which rises from 29.6 N with no lead to
# 30.7 N here — still inside the 40 N rating and the bound the test suite
# derives from it.  A stiffer mechanism is *not* reachable by raising this: 1.5
# Nm wants 0.008 rad, whose 34.1 N peak is already over that bound.  The honest
# answer there is more ``kp``/``kd``, not more lead — the ratio of the two is
# what decides it, ``kp·lead`` being the push and ``kd`` what makes the approach
# speed right, so this is a gain question wearing a millimetre's clothing.
#
# It does nothing for a force-carrying move, where the position gain is the
# approach gain and this much lead would read as contact on its own.
CONTACT_LEAD_RAD = 0.004

# How old the reading may be and still count as evidence.
#
# Both detectors above compare the trajectory against the jaws' measured
# position, and a measurement is not a measurement when it is a cache: the SDK's
# ``get_state`` returns whatever the last ``poll`` brought in, so a tick that
# found no status frame is describing the axis as it was some frames ago.  A
# frozen reading accumulates lost motion at the reference speed while the jaws
# move perfectly well — 1 mm in 50 ms at 20 mm/s — and no velocity check can veto
# it, because the same stale frame reports a velocity of zero.
#
# ``LINK_STALE_MS`` (200) is the line where the link is called dead.  This is the
# much tighter one: at the control rate a status frame arrives every tick, so
# three ticks of silence means the reading in hand is not describing now.
CONTACT_FRESH_MS = 30.0

# Position gain while closing under a force setpoint.  Deliberately far below
# KP_MOVE: whatever gain is in force during the approach becomes the squeeze
# applied before contact is noticed (``kp`` × the lost-motion threshold), so a
# stiff gain would put a spike through the setpoint on every grasp.  At the
# values above that pre-contact squeeze is ~4 N, regardless of the setpoint.
KP_GRASP_APPROACH = 25.0

# Torque feed-forward is ramped in over this long rather than stepped.  A step
# makes the fingers bounce off the object and the damping term fight the
# rebound, which spiked a 40 N grip to 56 N.
FORCE_RAMP_S = 0.05

#: How far short of the commanded end a stalled plain 张开/闭合 may stop and still
#: count as having arrived.
#:
#: Such a move is a *press*: it drives past the calibrated limit toward the
#: mechanical stop, so its stall is the arrival, and the only way a stall can be
#: an obstruction instead is to happen on the inner side of that end.  A
#: millimetre is the scale of both errors in play — the SDK's own ``stop_tol``
#: (0.02 rad) is about that on this linkage, and so is the gap between a probed
#: limit and the stop the jaws actually press to.  That second gap is why the
#: SDK's own ``MoveResult.ok`` is not the test here: it asks the stop to sit
#: within ``stop_tol`` of the *calibrated* limit, so a stop that overshot a
#: slightly shallow probe reads as a failure, and 张开 would report 「行程中被挡住」
#: on a gripper whose jaws had simply opened all the way.
PRESS_REACH_TOL_MM = 1.0

#: The SDK ``MotionConfig.stop_lead_mm`` this console runs its plain 张开/闭合 with.
#:
#: ``open()``/``close()`` hardcode ``press=True`` (litegrip actions.py:335,349),
#: so every plain move presses *past* the calibrated limit onto the mechanical
#: stop.  That press is the law that breaks the closing-side dead-band (issue
#: #72) and it is kept; what is not kept is how hard it seats.  Within
#: ``press_zone_mm`` of the limit the command may sit ``stop_lead_mm`` ahead of
#: the measured position, so the press torque is ``kp × stop_lead_mm /
#: rad_to_mm`` — at the SDK's own 0.7 mm that is 100 × 0.7 / 53.3 ≈ 1.3 N·m on
#: this unit, and with the ramp's velocity feed-forward on top a full 张开 read
#: as ±2.2–2.4 N·m, felt as 「一直出力」 and warming the coil every cycle.
#:
#: Lowering the lead lowers that torque and nothing else: the ``press_overshoot``
#: target still lands ~4.4 mm past the limit against a ~2.8 mm gap to the stop,
#: so the move still stalls *on* the stop and still counts as an arrival.  Too
#: low and the lead can no longer break static friction there, so the move stalls
#: short and 张开/闭合 reports 「未顶到限位」.
PRESS_STOP_LEAD_MM = 0.4

# ── Stroke ──────────────────────────────────────────────────────────────────
#: The travel of the gripper this console drives, in millimetres.
#:
#: A property of the bench, not a preference: it is the constant the whole
#: console reads, and there is deliberately no flag, setting or widget that
#: changes it.  A console that could be told the wrong travel would report every
#: millimetre wrong while looking perfectly healthy, and one that *was* told 10
#: mm (which is what the calibration page's old spinbox did on 2026-09-28)
#: derives a scale below :data:`RAD_TO_MM_MIN`, so the plausibility check turns
#: the whole calibration into a problem and the gate refuses motion — the
#: operator is then holding an unusable console and a file that looks fine.
#: Moving this console to another unit means editing this number and re-probing.
#:
#: Deliberately NOT the SDK's 120 mm.  ``GripperConfig.max_stroke_mm``, the
#: README's spec table and every calibration file the SDK writes are built around
#: 120 mm, but that is the nominal stroke of the unit those files were taken on —
#: it is not a measurement of this one, and it is not even the SDK's own number
#: (its guided probe hardcodes 120.0 while the other two calibrations divide by
#: the configured value).  The bench unit's jaws were measured with calipers at
#: 85 mm across the full travel, and this number decides two things that have to
#: be right for the operator to trust the display: the millimetres per rad the
#: angles are converted with, and the top of the slider.
DEFAULT_TRAVEL_MM = 85.0

#: How far inside the probe's recorded open limit the commanded range ends.
#:
#: The probe finds that limit by pressing into it at 40 N under kp=60, and the
#: linkage gives about a millimetre under the load before the stall is declared,
#: so the recorded extreme lies slightly *past* the mechanical end of the travel.
#: Commanding to the recorded extreme would therefore press the stop at the end
#: of every full-open move; commanding to the record inset by this much reaches
#: the same physical place without the press.  This is also what makes the two
#: recorded angles convert to the measured travel rather than to a number that
#: depends on how hard the probe pushed.
SPAN_INSET_MM = 1.0

# Band a travel may fall in.  Nothing sets the travel any more, so this is no
# longer a range a control is bounded by — it is the plausibility band
# :func:`~litearm_studio_daemon.gripper.calibration.validate_limits` holds a *file's* own
# numbers to: a file whose angles and scale imply a stroke of 3 mm or 9000 mm is
# describing a different machine, and one of the two files is wrong.
STROKE_MIN_MM = 10.0
STROKE_MAX_MM = 300.0
# Plausibility band for the derived mm/rad.  A travel that cannot belong to a
# file's angles shows up here, as a problem rather than as a slider that covers a
# fraction of the jaws' travel: this unit's 85 mm over its recorded span is 62.9
# mm/rad, and the same number derived at 10 mm would be 8.0.
#
# The same band is deliberately NOT applied to the mm/rad a file carries.  That
# one is a nominal stroke over a span, so it reads 120 mm for a 60 mm unit and a
# 120 mm unit alike — see ``calibration.validate_limits`` — and banding it would
# mean banding the wrong quantity.
RAD_TO_MM_MIN = 30.0
RAD_TO_MM_MAX = 200.0
# How far outside its own calibrated travel the measured angle may sit before
# the calibration is judged to describe a different gripper.
#
# It cannot be "outside by any amount", because a calibration that stops short
# of the hard stops — the safer kind, and the one this console recommends —
# leaves the axis legitimately parked outside the range it may be commanded to.
# The largest such margin on this unit is 0.0866 rad (5.6 mm, the gap between
# the software red line and the mechanical boundary), so anything above that has
# to pass.  A calibration taken against another encoder frame is off by
# *radians* — the case that prompted this check was off by 1.885 rad — so
# anything well below that has to fail.  0.15 rad sits 1.7x above the first and
# 12.6x below the second, which leaves the check insensitive to how the file was
# written and impossible to miss when the file is from another unit.
CALIB_MISMATCH_RAD = 0.15

# ── Calibration ─────────────────────────────────────────────────────────────
# Guided probe, mirroring calibrate_guided()'s defaults (gripper.py:516).
GUIDED_KP = KP_PROBE  # 60.0
GUIDED_STEP_RAD = 0.08
GUIDED_STALL_DELTA = 4.0e-4
GUIDED_STALL_CYCLES = 6
GUIDED_MAX_ITER = 40
GUIDED_STEP_INTERVAL_S = 0.3
GUIDED_BACKOFF_RAD = 0.15

# A probe step is bounded so that the press it can build up never exceeds the
# mechanical rating.  At a stall the MIT law's torque is exactly ``kp × step``
# (the velocity term has nothing left to damp), so the SDK's own kp=60 with
# step=0.08 asks for 4.8 Nm — 48 N, over the 40 N rating — with nothing between
# it and the hard stop except the drive's 10 Nm limit.  The step is therefore
# derived from the cap rather than chosen: ``torque_from_force(FORCE_MAX_N)/kp``,
# which is 0.0667 rad at kp=60 and still covers a full stroke inside max_iter.
GUIDED_MAX_FORCE_N = FORCE_MAX_N

# The probe is the one place motion is allowed without a valid calibration, so
# it needs a clamp that does not consult the very config it is trying to
# determine.  This is it, and it is a *jump* detector rather than a bound on how
# far the probe may travel.
#
# A reading that moves further than the mechanism can, in one 5 ms tick, is not
# a reading: it is a wrapped encoder, a frame from another CAN id, or a state
# that went stale and came back.  Half a radian per tick is ~6500 mm/s, an order
# of magnitude beyond the drive, so no legitimate probe can trip it, while a 2π
# wrap or a dropped-frame jump to zero trips it at once.
#
# An earlier draft bounded the absolute distance from where the probe started
# instead, and that cannot be set correctly: a probe that starts at one stop and
# ends at the other legitimately covers a whole travel (~1.9 rad) plus the stall
# detector's overshoot past each stop, so any bound tight enough to look like a
# limit refuses a legitimate probe.  The anti-windup property it was standing in
# for is structural anyway — the reference is re-anchored to the measurement at
# every step, so the position error can never exceed one step.
PROBE_MAX_JUMP_RAD_PER_TICK = 0.5

# How long a probe may keep running while none of its frames are reaching the
# motor, before it is stopped and the reason reported.
#
# A probe records a limit when the angle it reads stops changing, so it cannot
# tell a hard stop from a frame that was never sent — and it needs 1.8 s of
# stillness (`GUIDED_STALL_CYCLES × GUIDED_STEP_INTERVAL_S`) to record one.  This
# is well inside that window, so the cause is reported *instead of* a limit that
# was never reached; and it is 100 frames, far longer than any transient a bus
# produces, so it cannot fire on a hiccup.
PROBE_REFUSED_FAIL_S = 0.5

# The manual probe is driven by a hand, so its plausibility guard is set by what
# a hand can do rather than by what the motor can — and that makes it tighter,
# which matters.  The failure it has to catch is a dropped frame leaving the
# SDK's cached position at zero, and the size of that jump is however far the
# jaws had been pushed: from a mid-travel position 0 is a few tenths of a rad,
# comfortably *inside* the SDK's own ``|pos| < 50`` guard and inside a motor-rate
# threshold too.  Adopted as an extreme, it would overstate the travel and so
# understate every millimetre the console reads.  At 1 m/s — 6.7× the console's
# own top speed — the jump is caught.  A yank faster than that costs one sample
# out of thousands, and the SDK already tells the operator to work the jaws to
# both stops several times.
MANUAL_MAX_HAND_SPEED_MM_S = 1000.0

# Two-point manual calibration: the operator works the jaws to each extreme by
# hand and records it, so there is no duration to set — the operator says when,
# and each point is recorded deliberately rather than as the extreme of a sweep.
# What that leaves is a wait that can only end when someone presses a button, and
# the axis is limp throughout it, so each wait is bounded.
#
# Five minutes per point: the procedure is two hand moves, and the SDK's own
# version gives the whole sweep thirty seconds.  Generous because the timeout
# ends in a failed probe and the operator has to start again, and bounded at all
# because the alternative is a console left holding the motor enabled and limp
# for as long as someone forgets about it.
TWO_POINT_TIMEOUT_S = 300.0

# Guard against a runaway reading being adopted as a limit.
MANUAL_POS_GUARD_RAD = 50.0

# ── Link health ─────────────────────────────────────────────────────────────
LINK_RX_WINDOW_S = 1.0
LINK_STALE_MS = 200.0

# ── The CAN interface itself ────────────────────────────────────────────────
# What 连接 configures before it tries to open the bus.  The bitrate and the
# classic-CAN framing are the ones the README documents; iproute2's own ceiling
# for a CAN bitrate is 1000000 ("BITRATE := { 1..1000000 }", ip link help type
# can), which is also the range this refuses to hand to a privileged command.
CAN_CHANNEL = "can0"
CAN_BITRATE = 1_000_000
CAN_BITRATE_MIN = 1
CAN_BITRATE_MAX = 1_000_000

# How long a bus-off controller waits before restarting itself, set when the
# interface is configured.  Zero — the kernel default, and what the console used
# to leave behind — means "never": a controller that goes bus-off (no node
# acknowledged its frames, so its error counter filled) stays there until someone
# runs ``ip link set down/up``, and every frame sent meanwhile fails with
# ENETDOWN.  That is the state a silent drive puts the console in, and the
# operator sees it as "网络已断开" on the first thing that tries to send — which
# is 使能, since connect only opens a socket.  100 ms is the value SocketCAN's own
# documentation uses: long enough not to hammer a bus that is genuinely broken,
# short enough that a transient one heals before the operator notices.
CAN_LINK_RESTART_MS = 100

# Probing is a kernel read and answers immediately; the setup runs a password
# dialog that a person has to answer, so its timeout is a backstop against
# hanging for ever, not a service level.
CAN_LINK_PROBE_TIMEOUT_S = 5.0
CAN_LINK_SETUP_TIMEOUT_S = 120.0

# ── Faults ──────────────────────────────────────────────────────────────────
ERROR_DISABLED = 0x0
ERROR_ENABLED = 0x1
ERROR_UV = 0x9
ERROR_OC = 0xA
ERROR_MOS_OVER_TEMP = 0xB
ERROR_COIL_OVER_TEMP = 0xC

# error_code values that mean "fine" rather than "fault".
OK_ERROR_CODES = (ERROR_DISABLED, ERROR_ENABLED)

# Temperatures from which a reading stops being merely warm.  The driver's own
# over-temperature cut-out is near 100 °C; warning well before it leaves the
# operator time to finish the cycle or let the jaws idle instead of discovering
# the limit by having the motor shut down mid-grasp.
TEMP_MOS_WARN_C = 70
TEMP_COIL_WARN_C = 80

UV_FAULT_WINDOW_S = 60.0
UV_FAULT_MAX = 3
UV_DEGRADED_SPEED_MM_S = 25.0  # auto speed cap once the supply looks unstable

# ── Worker / GUI ────────────────────────────────────────────────────────────
# Cap on the interval the simulator will integrate in one step.  A GUI that was
# paused (breakpoint, suspend-to-RAM, a modal file dialog) must not be able to
# fast-forward the physics and teleport the jaws across their travel.
SIM_MAX_STEP_S = 0.05

#: How long ``zero()`` waits for a guided probe to finish before giving up.
#: The probe's own bounds are 40 steps of 0.3 s plus two backoffs, so a healthy
#: run is well inside 20 s; this is the timeout for a run that has stopped making
#: progress, and it is deliberately generous because aborting a probe costs the
#: operator the whole procedure.
ZERO_PROBE_TIMEOUT_S = 120.0

#: How long ``write_zero`` waits for the tick to answer.  The write is a limp
#: stream, a disable, the frame, a re-enable and a read-back — well under a second
#: on real hardware — so this is a backstop against a command that never landed,
#: not a service level.
WRITE_ZERO_TIMEOUT_S = 10.0

#: How long ``load_template``/``import_calibration`` wait for the tick to report
#: the load they asked for.  One tick is 5 ms plus one backend call, so this is a
#: backstop against a command that never landed, not a service level.
CALIBRATION_LOAD_TIMEOUT_S = 5.0

COMMAND_QUEUE_MAX = 256
GUI_WATCHDOG_S = 3.0
# Ceiling on the interval one control tick will integrate.  A process that was
# descheduled, or a tick that spent ten seconds inside a blocking SDK call, must
# not hand the profile a step it would read as "the jaws have not moved for ten
# seconds" — the stall detector would fire on a move that was never attempted.
MAX_TICK_DT_S = 0.1
HEARTBEAT_INTERVAL_MS = 500
SHUTDOWN_WAIT_MS = 4000
# Consecutive failing ticks before the FSM gives up and goes to FAULT.
MAX_CONSECUTIVE_TICK_ERRORS = 20

FACTORY_CALIBRATION_GATE_KEY = "safety/allow_factory_calibration"


def describe_error(code: int) -> str:
    """Chinese fault text for a DM error code.

    Prefers the SDK's own strings so the console and the SDK never disagree;
    falls back to a local copy when the SDK is not importable (pure-layer tests
    run without it).
    """
    try:
        from litegrip import describe_error as _sdk_describe

        return _sdk_describe(code)
    except Exception:  # pragma: no cover - exercised only without the SDK
        return _FALLBACK_ERROR_TEXT.get(code, f"未知错误 (0x{code:X})")


# Mirrors litegrip/constants.py describe_error().  Kept in sync by
# tests/test_units.py::test_error_text_matches_sdk.
_FALLBACK_ERROR_TEXT = {
    ERROR_DISABLED: "已失能",
    ERROR_ENABLED: "已使能",
    ERROR_UV: "欠压故障 (UV)",
    ERROR_OC: "过流故障 (OC)",
    ERROR_MOS_OVER_TEMP: "MOS 过温故障",
    ERROR_COIL_OVER_TEMP: "线圈过温故障",
}

# Extra operator guidance that the SDK's terse strings do not carry.
FAULT_HINTS = {
    ERROR_UV: "请检查夹爪 24V 供电",
    ERROR_OC: "请检查机械是否卡死",
    ERROR_MOS_OVER_TEMP: "等待 MOS 管冷却",
    ERROR_COIL_OVER_TEMP: "等待线圈冷却",
}
