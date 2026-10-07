"""固件镜像的离线解析与准入判据 —— 不碰设备, 因此**没有硬件也能测**。

来源与搬运说明
-------------
解析部分（`parse_ihex` / `summarize` / `to_binary` / `load_bin`）与版本串提取
（`extract_fw_version`）**逐字搬运**自上游工具仓 `gitee.com/yudao_hz_1/dfu-flash`
（HEAD `2dc3fb5`，文件 `dfu_flash.py` 与 `gui_flasher.py`，搬运日期 2026-10-06）。

相对上游只有两处**非逻辑**改动：

* 入口从"读本地文件路径"改成"吃 bytes" —— 守护进程的镜像来自 WebSocket 上传
  （浏览器的 `<input type=file>`），它不该、也不需要去读任意本地路径；
* 新增 `inspect()`：把上游散在 CLI `main()` 里的三条准入判据（基址 / 上界 /
  受保护区）收成一个函数，让命令层和测试共用同一份判据。

⚠ 那些判据**一条都不能省**，理由见各自的注释：它们拦的是"擦了不可再生的东西"
与"烧完变砖"。
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

# --------------------------------------------------------------------------
# 本板实测常量 (2026-09-13 验证, 沿用上游 dfu_flash.py)
# --------------------------------------------------------------------------
DFU_VID_PID = (0x0483, 0xDF11)          # ST ROM bootloader 的 DFU 设备
APP_BASE = 0x08000000                   # 应用起始 (BOOT_ADD0)
FLASH_END = 0x08100000                  # 1MB Flash 末 (H723VG)
LICENSE_SECTOR = (0x080C0000, 0x080E0000)  # 许可证 sector 6 (128KB, magic "LTC1")
PARAM_SECTOR = (0x080E0000, 0x08100000)  # flash_store 参数扇区 sector 7 (128KB)
# 受保护区 = 扇区 6 + 扇区 7, 物理连续 (0x080C0000..0x08100000, 256KB)。
# ⚠ 两者都是"只存在于设备、仓库里没有"的记录 (许可证 / 标定参数), 擦掉都不可恢复,
#   故按连续一块统一拦截。所有判据一律用 PROTECTED, 不要再用单个 PARAM_SECTOR。
PROTECTED = (LICENSE_SECTOR[0], PARAM_SECTOR[1])
FLASH_WORD = 32                         # H7 编程单位 = 256 bit; 见 to_binary 的注释

#: 固件版本串命名约定见 `litearm.h`: "Litearm<版本>[-<臂型>]"。
_FW_VER_RE = re.compile(rb"Litearm[0-9][0-9A-Za-z._+\-]*")


class ImageError(Exception):
    """镜像本身不合法（解析失败 / 基址不对 / 越界 / 覆盖受保护区）。

    与 `engine.DfuError`（设备侧失败）分开：调用方要能区分"这份文件不能用"
    与"烧到一半失败了"，两者给操作员的下一步动作完全不同。
    """

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        #: 面向界面的短码 (见 `dfu.RESULTS`)。界面文案只能按短码选，不能按 `str(e)`
        #: 选 —— 后者是中文，英文界面上必须换一句话。
        self.reason = reason


# --------------------------------------------------------------------------
# Intel HEX 解析 (上游逐字)
# --------------------------------------------------------------------------
def parse_ihex(text: str) -> dict[int, int]:
    """解析 Intel HEX 文本, 返回 {地址: 字节}。校验每行的和, 检测非法记录。"""
    mem: dict[int, int] = {}
    seg = 0            # type 02 的段基址
    ext = 0            # type 04 的线性基址
    for lineno, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line:
            continue
        if not line.startswith(":"):
            raise ImageError("image_unreadable", f"第 {lineno} 行不以 ':' 开头")
        try:
            rec = bytes.fromhex(line[1:])
        except ValueError as e:
            raise ImageError("image_unreadable",
                             f"第 {lineno} 行含非十六进制字符: {e}") from e
        if len(rec) < 5:
            raise ImageError("image_unreadable", f"第 {lineno} 行过短")
        if sum(rec) & 0xFF != 0:
            raise ImageError("image_unreadable", f"第 {lineno} 行校验和错误")
        cnt, off, typ = rec[0], (rec[1] << 8) | rec[2], rec[3]
        data = rec[4:4 + cnt]
        if len(data) != cnt:
            raise ImageError("image_unreadable", f"第 {lineno} 行长度字段与实际不符")
        if typ == 0x00:                                   # 数据
            base = (seg << 4) + ext
            for i, b in enumerate(data):
                a = base + off + i
                if a in mem:
                    raise ImageError("image_unreadable",
                                     f"第 {lineno} 行: 地址 0x{a:08X} 重复定义")
                mem[a] = b
        elif typ == 0x01:                                 # EOF
            break
        elif typ == 0x02:                                 # 扩展段地址
            seg, ext = int.from_bytes(data, "big"), 0
        elif typ == 0x03:                                 # 起始段地址
            pass
        elif typ == 0x04:                                 # 扩展线性地址
            ext, seg = int.from_bytes(data, "big") << 16, 0
        elif typ == 0x05:                                 # 起始线性地址
            pass
        else:
            raise ImageError("image_unreadable",
                             f"第 {lineno} 行: 未知记录类型 0x{typ:02X}")
    if not mem:
        raise ImageError("image_unreadable", "没有解析到任何数据记录")
    return mem


def summarize(mem: dict[int, int]) -> tuple[int, int, int, list[tuple[int, int]]]:
    """返回 (起始地址, 结束地址含, 字节数, 空洞列表)"""
    lo, hi = min(mem), max(mem)
    holes = []
    a = lo
    while a <= hi:
        if a not in mem:
            b = a
            while b <= hi and b not in mem:
                b += 1
            holes.append((a, b - 1))
            a = b
        else:
            a += 1
    return lo, hi, len(mem), holes


def to_binary(mem: dict[int, int]) -> tuple[bytes, int]:
    """按地址范围生成连续二进制 (空洞填 0xFF), 返回 (bin, 起始地址)。

    ⚠ 输出**保证按 32 B (H7 flash word) 对齐** —— 长度不足则尾部补 0xFF。
    下游所有烧录后端都依赖这个不变量: 长度不对齐时 ROM bootloader 需做
    read-modify-write, 对已写过的 flash word 二次编程会直接破坏 ECC
    (FLASH_SR1.DBECCERR) —— 实测见过 4 个坏 word 的砖机。
    """
    lo, hi, _, _ = summarize(mem)
    buf = bytearray(b"\xFF" * (hi - lo + 1))
    for a, b in mem.items():
        buf[a - lo] = b
    pad = (-len(buf)) % FLASH_WORD
    if pad:
        buf += b"\xFF" * pad
    return bytes(buf), lo


def load_bin(raw: bytes, base: int = APP_BASE) -> tuple[bytes, int]:
    """裸 `.bin` → (blob, 起始地址)。

    ⚠ 裸 `.bin` **不含地址信息** —— 按 STM32 应用基址 `0x08000000` 处理
      (Keil / STM32CubeIDE 导出的 .bin 就是这个约定)。
    ⚠ 尾部补齐到 32 B (H7 flash word): 长度不对齐会迫使 ROM bootloader 做
      read-modify-write, 而目标 word 若已被本轮写过就会二次编程 → 直接毁 ECC ——
      与 `to_binary()` 是同一条不变量。
    """
    if not raw:
        raise ImageError("image_unreadable", "BIN 文件为空")
    if base % FLASH_WORD:
        raise ImageError("image_unreadable",
                         f"烧录基址 0x{base:08X} 未对齐到 {FLASH_WORD} B flash word")
    pad = (-len(raw)) % FLASH_WORD
    if base + len(raw) + pad > FLASH_END:
        raise ImageError(
            "image_too_large",
            f"BIN 长度 {len(raw)} B 超出 Flash 上界 0x{FLASH_END:08X} "
            f"(从 0x{base:08X} 起可用 {FLASH_END - base} B)")
    return raw + b"\xFF" * pad, base


def extract_fw_version(blob: bytes) -> tuple[str | None, str]:
    """从烧录镜像里提取固件版本串 —— **纯离线**, 不连板子。

    依据: 固件的 `LITEARM_FW_VERSION` 是编译期字符串常量, 会原样编进 `.rodata`,
    所以在镜像里明文可见。实测同一串会出现在独立常量与开机横幅两处 —— 去重。

    返回 `(版本串, 备注)`。找不到、或出现**多个不同**版本串（同一镜像不该如此，
    说明构建异常）时返回 `(None, 原因)`, 由调用方**显式告警**而不是静默放行。
    """
    hits = sorted({m.group().decode("ascii", "replace") for m in _FW_VER_RE.finditer(blob)})
    if len(hits) == 1:
        return hits[0], ""
    if not hits:
        return None, "镜像里未找到 Litearm* 版本串 (固件过旧? 版本宏被改过?)"
    return None, f"镜像里有 {len(hits)} 个不同版本串: {', '.join(hits)}"


# --------------------------------------------------------------------------
# 准入判据 (上游 CLI 的 [1/4] 步, 收成一个函数)
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class ImageSummary:
    """一份通过准入判据的镜像 —— 界面在烧录前拿它给操作员看。"""

    #: 文件名（仅用于显示；不参与任何判据）。
    name: str
    #: `"hex"` 或 `"bin"`。
    format: str
    #: 起始地址（恒为 `APP_BASE`，否则早就被拒了）。
    base: int
    #: 烧录长度（已按 32 B 对齐补齐）。
    size: int
    #: 空洞数（HEX 才可能非零；空洞按 0xFF 填充）。
    holes: int
    #: 从镜像里离线提取的版本串；提取不到时为 `None`。
    version: str | None
    #: 版本串提取不到时的原因（正常时为空串）。
    version_note: str
    #: 整份镜像的 sha256（十六进制）。烧录日志里记它，出问题时可复现。
    sha256: str

    def to_dict(self) -> dict:
        return {
            "name": self.name, "format": self.format, "base": self.base,
            "size": self.size, "holes": self.holes, "version": self.version,
            "versionNote": self.version_note, "sha256": self.sha256,
        }


def inspect(name: str, data: bytes) -> tuple[bytes, ImageSummary]:
    """解析并校验一份镜像 → `(blob, summary)`；不合法则抛 `ImageError`。

    三条判据（顺序即失败优先级，全部来自上游 CLI，一条都不能省）：

    1. **起始地址必须是 `0x08000000`** —— 应用基址。烧到别处等于把应用搬到
       bootloader 找不到的地方；
    2. **不得越出 1 MB Flash**；
    3. **不得覆盖受保护区 `0x080C0000..0x08100000`**（扇区 6 许可证 + 扇区 7
       标定）。两者都**只存在于设备**、擦掉不可恢复 ⇒ 这里**硬拒绝**，没有
       "跳过"选项：一个覆盖该区的镜像本来就说明它选错了（应用不可能长到
       768 KB 以上还正常）。
    """
    is_bin = name.lower().endswith(".bin")
    if is_bin:
        blob, base = load_bin(data)
        lo, hi, n, holes = base, base + len(blob) - 1, len(blob), []
        fmt = "bin"
    else:
        try:
            text = data.decode("ascii")
        except UnicodeDecodeError as e:
            raise ImageError("image_unreadable",
                             f"不是 Intel HEX 文本（也不是 .bin）: {e}") from e
        try:
            mem = parse_ihex(text)
        except ImageError as e:
            # ⚠ 上游 CLI 让 `HexError` 直接冒到用户面前；这里补一句"这个文件像什么"，
            #   因为操作员最常见的错误是选了一个 .bin 却改了扩展名。
            raise ImageError(e.reason, f"{e}（这份文件既不是合法 HEX，也不是 .bin）") from e
        blob, base = to_binary(mem)
        lo, hi, n, holes = summarize(mem)
        fmt = "hex"

    if base != APP_BASE:
        raise ImageError(
            "image_not_at_app_base",
            f"镜像起始地址 0x{base:08X} 不是应用基址 0x{APP_BASE:08X} —— "
            f"应用只能烧到 0x{APP_BASE:08X}")

    end = hi + 1
    if end > FLASH_END:
        raise ImageError(
            "image_too_large",
            f"镜像结束地址 0x{end:08X} 超出 Flash 上界 0x{FLASH_END:08X} "
            f"(共 {n} B)")

    if base < PROTECTED[1] and end > PROTECTED[0]:
        raise ImageError(
            "image_covers_protected",
            f"镜像覆盖受保护扇区 0x{PROTECTED[0]:08X}..0x{PROTECTED[1] - 1:08X} —— "
            f"扇区 6 是许可证 (magic LTC1), 扇区 7 是出厂标定 (magic LTP1), "
            f"两者只存在于设备上, 擦掉不可恢复。这份镜像不能用。")

    version, note = extract_fw_version(blob)
    summary = ImageSummary(
        name=name, format=fmt, base=base, size=len(blob), holes=len(holes),
        version=version, version_note=note,
        sha256=hashlib.sha256(blob).hexdigest(),
    )
    return blob, summary
