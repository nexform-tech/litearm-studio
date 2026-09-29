LiteArm Studio can read whether an arm is activated and, once the credential
format is settled, will submit the vendor-issued credential. This document is the
contract shared by the Studio activation panel, the daemon's `license` command,
and the vendor signer; read it before changing any of the three.

# Activation

## 1. What the firmware does

An unactivated arm refuses `ENABLE` with `ERR{0x10,0x08}` and behaves normally for
every other command. That refusal is the first predicate in the firmware's enable
path, so retrying it changes nothing and no bypass exists by design.

The record lives in flash sector 6 (`0x080C0000`, 64 bytes, magic `LTC1`). Erasing
that sector returns the device to "not activated" and there is no way back without
a new credential. The `dfu-flash` tool protects sector 6 and sector 7 (calibration)
for exactly this reason; anything that erases the whole chip destroys both.

## 2. The `license` command (read-only)

`{"t":"cmd","m":"license","p":{}}` maps to `Arm.license()`. It is safe at any time
and never changes device state.

`supported` is a **three-state** field, not a boolean. Three different problems
need three different sentences in the UI:

| `supported` | Meaning | What the panel says |
| --- | --- | --- |
| `true` | The record was read; the other fields are valid | Show the state and the UID |
| `false` | The firmware replied `ERR{0x2F,0x00}`: no such command | "This firmware has no activation query (activation exists from 1.8.0)" |
| `null` | Nothing was read this time | "Could not read the record; press Refresh" |

Response fields when `supported` is `true`:

| Field | Type | Notes |
| --- | --- | --- |
| `state` | int | `0` not activated, `1` activated, `2` activated with factory code |
| `stateName` | string | Readable name; unknown codes keep their value (`unknown_state_7`) |
| `activated` | bool | `state != 0` |
| `factoryMode` | bool | `flags` bit 0. It does **not** mean "activated" |
| `ver` | int | Record version (currently 1) |
| `uid` | string | 24 lowercase hex characters; see section 3 |
| `custId` | int | Customer number; `0` while not activated |
| `issued` | int | Issue date `YYYYMMDD`; `0` while not activated |
| `flags` | int | Only bit 0 is defined |

Do not collapse the three states. Reporting `supported: false` when nothing was
read tells the operator to update a firmware that may be current, and reporting
`true` with zeroed fields makes a locked arm look usable.

**Do not treat "not activated" as an error.** It is a normal response
(`activated: false`). Only a link failure is an error, and that one propagates so
the session can mark the link dead.

## 3. The device UID is the ordering key

`Arm.license()` returns the UID even while the arm is not activated. That string
(24 lowercase hex characters) is what the vendor signer takes:

```
tools/litearm-license sign --uid <24 hex> --cust-id <n> --key-file <key> \
    --issued <YYYYMMDD> --out lic.json
```

Two rules follow.

- The UID comes from the license record, never from the USB serial string. They
  are different values and only the former is signed.
- A credential is bound to one machine. The panel must show the UID prominently
  while the arm is locked, because handing it over is the operator's next action.

## 4. Old firmware reads as `null` today

`Arm.license()` watches only the `RSP_LICENSE(0x4F)` queue. A firmware without
`0x2F` answers `ERR{0x2F,0x00}`, which lands in a queue that call never reads, so
the call waits out its one-second timeout and raises `MotionTimeoutError` instead
of `UnsupportedByFirmwareError`. The daemon therefore maps both
`UnsupportedByFirmwareError` and `MotionTimeoutError` to `supported: null` and
lets every other exception propagate.

The fix belongs to the SDK (add `echo_cmd` to that `expect` call, in
litearm-python). When it lands, old firmware will report `supported: false` and no
longer stall for a second. The daemon already handles both.

## 5. Submitting a credential is not implemented

`CMD_ACTIVATE(0x3F)` takes 28 bytes: `cust_id u32 LE + issued u32 LE + flags u32 LE
+ mac[16]` (two SipHash-2-4 tags). The firmware writes sector 6 on success.

The credential file format is Studio's to define, and it is not settled yet. Until
it is, the panel offers no submit button: a button that can only fail is worse than
no button. The open questions are the JSON field names, how the 16-byte tag is
encoded, whether the signer writes the machine UID into the file (so Studio can
reject "this credential belongs to another arm" before sending), and whether the
signer takes a `--flags` argument at all.

## 6. Rules the panel must keep

- **Never compute or verify the tag.** The key lives in firmware and in the vendor
  signer only. Any customer-side code able to produce a tag voids the mechanism.
- **Never call `0x3F/0x02` a wrong credential.** The firmware folds "already
  activated", "tag mismatch", "bad compiled-in key" and "write failed" into that
  one code. Read the record back: `state != 0` means the arm is activated and the
  submission succeeded.
- **Never disable the arm to satisfy the "must be disarmed" gate** (`0x3F/0x04`).
  Dropping motor power is the operator's decision, not a side effect of a licence
  submission.
