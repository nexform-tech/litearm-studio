LiteArm Studio 可以读取机械臂是否已激活，并把厂商签发的凭据提交给设备。本文是这条链路的接口约定，由上位机激活面板、守护进程 `license` 命令和厂商签发工具三方共同遵守：改其中任何一个之前，请先读完本文。

# 激活

[English](ACTIVATION.md) | **简体中文**

## 1. 固件的行为

未激活的机械臂会以 `ERR{0x10,0x08}` 拒绝 `ENABLE`，其余命令一切正常。这个拒绝是固件使能流程里的第一条判据，因此重试没有用，并且按设计不存在绕过的办法。

授权记录存放在 flash 扇区 6（`0x080C0000`，64 字节，魔数 `LTC1`）。擦除该扇区会让设备回到「未激活」，没有新凭据就无法恢复。`dfu-flash` 工具会保护扇区 6 和扇区 7（标定数据），正是出于这个原因；任何整片擦除的操作都会同时毁掉这两者。

## 2. `license` 命令（只读）

`{"t":"cmd","m":"license","p":{}}` 对应 `Arm.license()`。任何时候调用都是安全的，不会改变设备状态。

`supported` 是**三态**字段，不是布尔值。三种不同的问题需要界面给出三种不同的说法：

| `supported` | 含义 | 面板显示 |
| --- | --- | --- |
| `true` | 已读到记录，其余字段有效 | 显示授权状态与 UID |
| `false` | 固件回复 `ERR{0x2F,0x00}`：没有这条命令 | 「这台固件没有授权查询功能（授权功能从 1.8.0 起提供）」 |
| `null` | 这次什么都没读到 | 「读不到授权记录，请点刷新」 |

`supported` 为 `true` 时的响应字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `state` | int | `0` 未激活，`1` 已激活，`2` 以出厂码激活 |
| `stateName` | string | 可读名称；未知状态码保留原值（`unknown_state_7`） |
| `activated` | bool | `state != 0` |
| `factoryMode` | bool | `flags` 的第 0 位。它**不**表示「已激活」 |
| `ver` | int | 记录版本（目前为 1） |
| `uid` | string | 24 位小写十六进制字符，见第 3 节 |
| `custId` | int | 客户编号；未激活时为 `0` |
| `issued` | int | 签发日期 `YYYYMMDD`；未激活时为 `0` |
| `flags` | int | 目前只定义了第 0 位 |

不要把三种状态合并。什么都没读到时报告 `supported: false`，会让操作员去升级一台可能已经是最新的固件；而用全零字段报告 `true`，会让被锁定的机械臂看起来像是可用的。

**不要把「未激活」当作错误。** 它是一个正常响应（`activated: false`）。只有链路故障才是错误，并且要向上传播，让会话把链路标记为断开。

## 3. 设备 UID 是签发的依据

即使机械臂未激活，`Arm.license()` 也会返回 UID。这串字符（24 位小写十六进制）就是厂商签发工具的输入：

```
tools/litearm-license sign --uid <24 位十六进制> --cust-id <n> --key-file <key> \
    --issued <YYYYMMDD> --out lic.json
```

由此得出以下规则。

- UID 取自授权记录，绝不取自 USB 序列号字符串。两者是不同的值，只有前者会被签名。
- 凭据只绑定一台机器。面板在机械臂被锁定时必须突出显示 UID，这样当激活服务没有这台机器的凭据时，操作员可以识别出是哪台机器。厂商在发货前已经按这个 UID 录入了凭据，所以通常的下一步是提交注册表单，把 UID 发给供应商是例外，不是第一步。
- 读不到授权记录时，守护进程**什么都不发送**：它绝不回退使用客户端提供的 UID。以未经核实的 UID 提交的注册信息会被记到错误的机器名下，而且写入本来也不会成功。操作员会被告知检查链路并重试；低于 1.8.0 的固件根本没有 license 命令，所以此时守护进程会指明是固件的问题，而不是链路的问题。

## 4. 旧固件目前读出为 `null`

`Arm.license()` 只监听 `RSP_LICENSE(0x4F)` 队列。没有 `0x2F` 命令的固件会回复 `ERR{0x2F,0x00}`，这个回复落在该调用从不读取的队列里，所以调用会等满 1 秒超时，抛出 `MotionTimeoutError`，而不是 `UnsupportedByFirmwareError`。因此守护进程把 `UnsupportedByFirmwareError` 和 `MotionTimeoutError` 都映射为 `supported: null`，其余异常一律向上传播。

修复属于 SDK（在 litearm-python 中，给那次 `expect` 调用加上 `echo_cmd`）。修复合入后，旧固件会报告 `supported: false`，也不会再卡住 1 秒。守护进程已经同时处理了这两种情况。

## 5. 凭据文件与激活服务

`CMD_ACTIVATE(0x3F)` 接收 28 字节：`cust_id u32 LE + issued u32 LE + flags u32 LE + mac[16]`（两个 SipHash-2-4 标签）。成功时固件会写入扇区 6。

Studio 自己从不生成这个标签。它**只有一个来源**，即激活服务：`POST https://act.nexform.tech/api/v1/license`（见第 6 节）。Studio 把操作员的注册信息连同设备 UID 一起发送，收到这块板子的凭据文件。回复会经过 `daemon/src/litearm_studio_daemon/activation.py` 中的解析器，由它校验格式和 UID。

### 凭据文件（`lic.json`）

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

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `format` | int，必填 | 文件格式版本，目前为 `1`。未知的值会被**拒绝**，绝不猜测。 |
| `uid` | string，必填 | 24 位小写十六进制，与操作员从设备上读到的字符串相同。文件中的 `uid` 与当前所连机械臂不一致时，Studio 会拒绝该文件。 |
| `cust_id` | int，必填 | 客户编号，原样传给固件。 |
| `issued` | int，必填 | 签发日期 `YYYYMMDD`。故意用整数：日期字符串会把解析器和时区带进传输格式。 |
| `flags` | int，可选，默认 0 | 只定义了第 0 位（出厂码）。 |
| `mac` | string，必填 | 16 字节，写成 32 位小写十六进制字符。用十六进制而不是 base64：经聊天软件和表格复制后依然完好。 |

不要添加解释性字段（客户名称、备注、有效期）。没有任何东西能验证它们，它们最终会变成「文件和设备说法不一致，该信哪个」的问题。文件名承载这类信息（`lic-<cust_id>-<uid 前 8 位>.json`）。

## 6. 注册与激活服务

### 请求

`POST <base>/api/v1/license`，`Content-Type: application/json`。`<base>` 来自 `--activation-url` 或环境变量 `$LITEARM_ACTIVATION_URL`，默认为 `https://act.nexform.tech`。

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

- `contact` 的字段与激活网站注册表单的**输入项一一对应**（`litearm-activation/src/lib/validation.ts` 中的 `activationFormSchema`）。以网站为准：凭据由它签发，所以它的字段和规则决定了这份约定。守护进程重复校验它们，只是因为这道关口必须设在掌管链路的那一层。

  | 请求字段 | 网站表单字段 | 必填 | 规则 |
  | --- | --- | --- | --- |
  | `name` | `contactName` | 是 | 2–32 个字符，只允许字母和姓名中的标点，不能含数字 |
  | `phone` | `phone` | 是 | `^1[3-9]\d{9}$` |
  | `organization` | `company` | 是 | 1–128 个字符 |
  | `wechatId` | `wechatId` | 否 | 最多 64 个字符 |
  | `email` | `email` | 是 | 最多 128 个字符，形如 `name@example.com` |
  | `region` | `region` | 是 | 1–64 个字符 |
  | `industry` | `industry` | 否 | 最多 64 个字符 |
  | `purpose` | `purpose` | 否 | 最多 500 个字符 |

  有两个键沿用了这份约定最初的名字，即 `name` 和 `organization`，分别对应网站的 `contactName` 和 `company`。其余键两边写法一致。八个键始终都在；未填写的可选字段以空字符串发送。所有值都会去除首尾空白。缺失、过长或格式错误的字段，会被守护进程以 `missing_contact`、`contact_too_long`、`bad_name`、`bad_phone` 或 `bad_email` 拒绝；不会发出网站本来就会拒绝的请求。
- `consent` 是**一份文件**，不是一组逐项开关：操作员阅读《激活注册信息同意书》，其中列出请求携带的每一项及其用途，然后对全部内容表示同意。这份文件按激活发送的内容命名，而不是叫「信息收集」：只看名字的操作员不应得出 Studio 在采集数据的结论。`consent.granted: false` 会在任何请求发出之前被守护进程**拒绝**。面板会禁用按钮，但守护进程才是关口：直接与 WebSocket 通信的客户端，不能在没有同意的情况下发出个人数据。
- `consent.text_version` 记录操作员同意的是**哪一版措辞**。每当所列项目或其用途发生变化，它就会变化。当前措辞是 `draft-4`：`draft-2` 列出了来源 IP，`draft-3` 不再列出，`draft-4` 增加了网站表单中除姓名、单位、邮箱和电话之外的四个字段：微信号、地区、行业和用途。
- `diagnostics` 始终随请求发送，因为它是同一份同意书里列出的项目之一。它只包含版本号，别无其他：局域网地址和主机名是刻意不采集的。服务端自己会记录来源 IP，这条记录在隐私政策中披露，而不在本文中披露，本文只涵盖 Studio 发送的内容。
- `code` 预留给订单/激活码。非空时 Studio 会发送它，但目前还没有对应的输入项。它保持不用，是因为服务只对厂商已提前（通常在发货前）在网站管理端录入凭据的 UID 作答：仅仅持有这台机器不足以获得凭据，所以这里不需要第二重验证。
- 守护进程会在发出任何内容**之前**从设备读取 UID。读取失败时，它以 `device_uid_unavailable` 拒绝；固件低于 license 命令的版本时，则改为 `firmware_unsupported`。两者都是一个字节都不发就拒绝，也都不同于服务端错误。

### 响应

`200`，响应体为第 5 节的凭据文件。

其他状态码必须携带：

```json
{ "error": { "code": "not_found", "message": "no license for this UID" } }
```

`code` 对应给操作员的提示。已知取值：`not_found`、`invalid_uid`、`consent_required`、`rate_limited`、`maintenance`、`code_required`，以及 `invalid_request`，后者在请求本身不成立时返回（请求体过大、不是 JSON，或注册信息不满足服务自己的规则）。最后一种是客户端的问题，因此不能报告为服务端错误。其他取值一律报告为普通的服务端错误。

**2xx 回复但响应体不是可用凭据，不属于服务端错误。** 其中两种情况会指明操作员的下一步，并以自己的名字报告：文件格式比当前版本新时报 `unsupported_format`（升级 Studio），服务返回了另一块板子的凭据时报 `uid_mismatch`（与供应商核对 UID）。响应体的其他问题一律报告为 `bad_response`。不要把前两种并入 `bad_response`：「稍后重试」是这条路径兑现不了的承诺。

### 规则

- 服务**保存**凭据，但不签名。签名密钥留在厂商的离线机器上，这正是该机制的要求。
- 同意书是请求内容的**唯一**披露渠道：它逐项列出每一项，而请求不携带任何其他内容。新增字段就意味着在同一次改动中向同意书新增一项；构造出的请求的键集合由测试锁定，所以隐藏字段会让测试失败。服务端的记录（来源 IP）改在隐私政策中披露；不要写进同意书，否则读起来像是 Studio 在采集。
- 凭据不是机密：它绑定一块板子的 UID，固件在其他任何地方都会拒绝它。无账号地通过普通 HTTPS 发送它是可以的。

## 7. 面板必须遵守的规则

- **绝不计算或验证标签。** 密钥只存在于固件和厂商签发工具中。客户端的任何代码只要能生成标签，该机制就失效了。
- **绝不让一次读失败抹掉 UID。** 保留上一条记录并标明它是旧读数。读失败有两条来路——链路报错，和设备干脆不应答（守护进程把它变成 `supported: null` 且 `ok: true`，见第 4 节）——两条必须表现一致。UID 是这块面板唯一的交付物，一次链路抖动就把它清空等于让操作员从头再来。`ActivationSection.refresh.test.tsx` 把这两条路都钉住了。
- **绝不把 `0x3F/0x02` 称为凭据错误。** 固件把「已激活」「标签不匹配」「内置密钥有误」和「写入失败」合并成这一个错误码。请回读记录：`state != 0` 就表示机械臂已激活，提交已成功。
- **绝不为了满足「必须失能」的关口（`0x3F/0x04`）而替用户失能机械臂。** 切断电机动力是操作员的决定，不是提交授权时的副作用。
- **激活不能让机械臂卡住。** 请求在守护进程唯一的命令线程之外运行，所以获取凭据期间运动命令仍然可用；只有两个 SDK 阶段（读取 UID、写入并回读）会占用该线程。由此需要知道一点：获取期间可以使能机械臂，随后固件会以 `0x3F/0x04` 拒绝写入。这是关口在起作用，不是缺陷，操作员会被告知先失能再重试。
- **传输层只接受同源页面。** 浏览器不会对 WebSocket 应用同源策略，所以没有这道关口的话，操作员访问的任何页面都能打开 `ws://127.0.0.1:<port>/ws` 来操控机械臂，包括用伪造的 `consent.granted` 调用 `activate`。守护进程会拒绝 `Origin` 与 `Host` 不匹配的握手，并要求 `Host` 是回环地址，后者才能阻止 DNS 重绑定（此时 `Origin` 和 `Host` 都是攻击者的域名）。完全没有 `Origin` 的握手来自原生客户端而不是网页，仍然允许。
