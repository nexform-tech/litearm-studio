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

## 5. The credential file and the activation service

`CMD_ACTIVATE(0x3F)` takes 28 bytes: `cust_id u32 LE + issued u32 LE + flags u32 LE
+ mac[16]` (two SipHash-2-4 tags). The firmware writes sector 6 on success.

Studio never produces that tag. It gets it from **one of two sources**, and both end
in the same parser (`daemon/src/litearm_studio_daemon/activation.py`):

1. **The activation service** — `POST https://act.nexform.tech/api/v1/license`
   (see section 6). Studio sends the operator's registration details plus the
   device UID and receives the credential file for that board.
2. **A credential file** the operator imports by hand. This path never touches the
   network and exists for machines with no internet access.

### The credential file (`lic.json`)

```json
{
  "format": 1,
  "uid": "0a1b2c3d4e5f60718293a4b5",
  "cust_id": 1042,
  "issued": 20260929,
  "flags": 0,
  "mac": "3f2a91c47d0e5b6812ac4f90de7713b5"
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `format` | int, required | File format version. Currently `1`. An unknown value is **rejected**, never guessed at. |
| `uid` | string, required | 24 lowercase hex, the same string the operator reads off the device. Studio refuses a file whose `uid` is not the connected arm. |
| `cust_id` | int, required | Customer number, passed to the firmware unchanged. |
| `issued` | int, required | Issue date `YYYYMMDD`. Integer on purpose: a date string would drag a parser and a timezone into the wire. |
| `flags` | int, optional, default 0 | Only bit 0 (factory code) is defined. |
| `mac` | string, required | 16 bytes as 32 lowercase hex characters. Hex, not base64: it survives being copied through chat apps and spreadsheets. |

Do not add interpretive fields (customer name, notes, expiry). Nothing can verify
them, and they drift into "the file and the device disagree, which one do I
believe". The file name carries that information instead
(`lic-<cust_id>-<first 8 of uid>.json`).

## 6. Registration and the activation service

### The request

`POST <base>/api/v1/license`, `Content-Type: application/json`. `<base>` comes from
`--activation-url` or `$LITEARM_ACTIVATION_URL` and defaults to
`https://act.nexform.tech`.

```json
{
  "uid": "0a1b2c3d4e5f60718293a4b5",
  "contact": {
    "name": "Zhang San",
    "phone": "13800000000",
    "organization": "Example University",
    "wechatId": "zhangsan_wx",
    "email": "z@example.com",
    "region": "Shanghai",
    "industry": "Education",
    "purpose": "Teaching and research"
  },
  "consent": { "granted": true, "text_version": "draft-4" },
  "diagnostics": { "studio": "0.1.0", "sdk": "2.1.0", "firmware": "Litearm1.8.0-7J" },
  "code": ""
}
```

- `contact` carries **one field per input on the activation website's registration
  form** (`litearm-activation/src/lib/validation.ts`, the `activationFormSchema`).
  The website is the authority: it issues the credential, so its fields and its rules
  define this contract. The daemon re-checks them only because the gate has to sit in
  the one layer that owns the link.

  | Request field | Website form field | Required | Rule |
  | --- | --- | --- | --- |
  | `name` | `contactName` | yes | 2–32 characters, letters and name punctuation only, no digits |
  | `phone` | `phone` | yes | `^1[3-9]\d{9}$` |
  | `organization` | `company` | yes | 1–128 characters |
  | `wechatId` | `wechatId` | no | up to 64 characters |
  | `email` | `email` | yes | up to 128 characters, `name@example.com` |
  | `region` | `region` | yes | 1–64 characters |
  | `industry` | `industry` | no | up to 64 characters |
  | `purpose` | `purpose` | no | up to 500 characters |

  Two keys keep the names this contract started with — `name` and `organization` —
  and mean the website's `contactName` and `company`. Every other key is spelled the
  same on both sides. All eight keys are always present; an unfilled optional field
  travels as an empty string. Every value is trimmed. A field that is missing, too
  long or malformed is rejected by the daemon with `missing_contact`,
  `contact_too_long`, `bad_name`, `bad_phone` or `bad_email`; nobody sends a request
  the website would refuse.
- `consent` is **one document**, not a set of per-item switches: the operator reads
  the Activation Registration Consent, which lists every item the request carries
  together with the purpose of each, then agrees to all of it. The document is named
  after what activation sends, not after "information collection": an operator who
  reads the name alone must not conclude that Studio harvests data.
  `consent.granted: false` is **rejected** by the daemon before any request is sent.
  The panel disables the button, but the daemon is the gate — a client that talks to
  the WebSocket directly must not be able to send personal data without consent.
- `consent.text_version` records **which wording** the operator agreed to. It changes
  whenever the listed items or their purpose change. The current wording is
  `draft-4`: `draft-2` listed the source IP, `draft-3` does not, and `draft-4` added
  the four fields the website's form carries besides name, organisation, email and
  phone — WeChat ID, region, industry and purpose.
- `diagnostics` always travels with the request, because it is one of the items
  listed in that same consent. It carries versions, nothing else: LAN addresses and
  host names are deliberately not collected. The service records the source IP
  itself, and that record is disclosed in the privacy policy rather than in this
  document, which covers only what Studio sends.
- `code` is reserved for an order/activation code. Studio sends it when non-empty;
  no input for it exists yet. It stays unused because the service answers only for a
  UID whose credential an operator entered in advance on the website's admin side:
  possession of the machine is not enough to obtain a credential, so no second factor
  is needed here.

### The response

`200` with the credential file from section 5 as the body.

Any other status must carry:

```json
{ "error": { "code": "not_found", "message": "no license for this UID" } }
```

`code` maps to what the operator is told. Known values: `not_found`,
`invalid_uid`, `consent_required`, `rate_limited`, `maintenance`, `code_required`.
Anything else is reported as a plain server error.

### Rules

- The service **stores** credentials; it does not sign them. The signing key stays
  on the vendor's offline machine, exactly as the mechanism requires.
- The consent document is the **only** disclosure of what the request carries: it
  lists every item, one by one, and the request carries nothing else. Adding a field
  means adding an item to that document in the same change - the key set of the built
  request is pinned by a test, so a hidden field fails the suite. Server-side records
  (the source IP) are disclosed in the privacy policy instead; do not put them in the
  document, where they read as something Studio collects.
- The credential is not a secret: it is bound to one board's UID and the firmware
  rejects it anywhere else. Sending it over plain HTTPS without an account is fine.
- The operator needs a path that works with no internet. `import_license` is that
  path, and it is not a degraded mode: it is the same parser and the same firmware
  command.

## 7. Rules the panel must keep

- **Never compute or verify the tag.** The key lives in firmware and in the vendor
  signer only. Any customer-side code able to produce a tag voids the mechanism.
- **Never call `0x3F/0x02` a wrong credential.** The firmware folds "already
  activated", "tag mismatch", "bad compiled-in key" and "write failed" into that
  one code. Read the record back: `state != 0` means the arm is activated and the
  submission succeeded.
- **Never disable the arm to satisfy the "must be disarmed" gate** (`0x3F/0x04`).
  Dropping motor power is the operator's decision, not a side effect of a licence
  submission.
