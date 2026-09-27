# Makefile for LiteArm Documentation PDF Generation

SHELL := /bin/bash

# Configuration
PANDOC         ?= pandoc
PDF_ENGINE     ?= xelatex
DIST_DIR       := dist
CONFIG_DIR     := pdf-config
HEADER_TEX     := $(CONFIG_DIR)/header.tex
FILTER_LANG    := $(CONFIG_DIR)/filters/remove-lang-nav.lua
FILTER_CALLOUT := $(CONFIG_DIR)/filters/format-callouts.lua
FILTER_TABLES  := $(CONFIG_DIR)/filters/format-tables.lua

# Styling & Layout Flags aligned with Linker Hand O6 Product Manual
# Body: Noto Serif CJK SC (SongTi / SimSun) + Times New Roman
# Headings: Noto Sans CJK SC (HeiTi / SimHei) + Arial
MAIN_LATIN_FONT ?= $(shell fc-match "Times New Roman" -f "%{family}" 2>/dev/null)
ifeq ($(strip $(MAIN_LATIN_FONT)),)
  MAIN_LATIN_FONT := Liberation Serif
endif

SANS_LATIN_FONT ?= $(shell fc-match "Arial" -f "%{family}" 2>/dev/null)
ifeq ($(strip $(SANS_LATIN_FONT)),)
  SANS_LATIN_FONT := Liberation Sans
endif

FONTS          := -V CJKmainfont="Noto Serif CJK SC" \
                  -V CJKsansfont="Noto Sans CJK SC" \
                  -V mainfont="$(MAIN_LATIN_FONT)" \
                  -V sansfont="$(SANS_LATIN_FONT)" \
                  -V monofont="JetBrains Mono"
TYPOGRAPHY     := -V fontsize=12pt \
                  -V linestretch=1.5
GEOMETRY       := -V geometry:a4paper,margin=26mm,top=25mm,bottom=25mm
PANDOC_FLAGS   := --pdf-engine=$(PDF_ENGINE) \
                  -H $(HEADER_TEX) \
                  --lua-filter=$(FILTER_LANG) \
                  --lua-filter=$(FILTER_CALLOUT) \
                  --lua-filter=$(FILTER_TABLES) \
                  $(FONTS) \
                  $(TYPOGRAPHY) \
                  $(GEOMETRY) \
                  -V colorlinks=true \
                  -V linkcolor=blue \
                  --toc --toc-depth=3 \
                  --highlight-style=tango

# Extract Version from Quickstart Markdown files (defaults to v1.0)
QS_VER_ZH := $(shell sed -n -E 's/^version:[[:space:]]*["'\'']?([^"'\'']+)["'\'']?/\1/p' QUICKSTART_ZH.md | head -n1)
ifeq ($(strip $(QS_VER_ZH)),)
  QS_VER_ZH := v1.0
endif

QS_VER_EN := $(shell sed -n -E 's/^version:[[:space:]]*["'\'']?([^"'\'']+)["'\'']?/\1/p' QUICKSTART.md | head -n1)
ifeq ($(strip $(QS_VER_EN)),)
  QS_VER_EN := v1.0
endif

# Extract Version from User Manual Markdown files (defaults to v1.0)
UM_VER_ZH := $(shell sed -n -E 's/^version:[[:space:]]*["'\'']?([^"'\'']+)["'\'']?/\1/p' USER_MANUAL_ZH.md | head -n1)
ifeq ($(strip $(UM_VER_ZH)),)
  UM_VER_ZH := v1.0
endif

UM_VER_EN := $(shell sed -n -E 's/^version:[[:space:]]*["'\'']?([^"'\'']+)["'\'']?/\1/p' USER_MANUAL.md | head -n1)
ifeq ($(strip $(UM_VER_EN)),)
  UM_VER_EN := v1.0
endif

# Targets with version suffix
PDF_QS_ZH     := $(DIST_DIR)/LiteArm_Quickstart_ZH_$(QS_VER_ZH).pdf
PDF_QS_EN     := $(DIST_DIR)/LiteArm_Quickstart_EN_$(QS_VER_EN).pdf
PDF_MANUAL_ZH := $(DIST_DIR)/LiteArm_User_Manual_ZH_$(UM_VER_ZH).pdf
PDF_MANUAL_EN := $(DIST_DIR)/LiteArm_User_Manual_EN_$(UM_VER_EN).pdf

PDFS_ZH := $(PDF_QS_ZH) $(PDF_MANUAL_ZH)
PDFS_EN := $(PDF_QS_EN) $(PDF_MANUAL_EN)
ALL_PDFS := $(PDFS_ZH) $(PDFS_EN)

COMMON_DEPS := Makefile $(HEADER_TEX) $(FILTER_LANG) $(FILTER_CALLOUT) $(FILTER_TABLES) $(CONFIG_DIR)/logo.png $(CONFIG_DIR)/wechat-qrcode.png

# Terminal Colors
CYAN   := \033[36m
GREEN  := \033[32m
YELLOW := \033[33m
RED    := \033[31m
RESET  := \033[0m

.PHONY: all pdf docs doc pdf-zh pdf-en pdf-quickstart pdf-manual clean check-deps help

all: pdf

docs: pdf
doc: pdf

pdf: check-deps $(ALL_PDFS)
	@echo -e "\n$(GREEN)✓ 所有 PDF 文档构建完成！产物位于 $(DIST_DIR)/$(RESET)"

pdf-zh: check-deps $(PDFS_ZH)
	@echo -e "\n$(GREEN)✓ 中文 PDF 文档构建完成！$(RESET)"

pdf-en: check-deps $(PDFS_EN)
	@echo -e "\n$(GREEN)✓ 英文 PDF 文档构建完成！$(RESET)"

pdf-quickstart: check-deps $(PDF_QS_ZH) $(PDF_QS_EN)
	@echo -e "\n$(GREEN)✓ Quickstart (中英文) 构建完成！$(RESET)"

pdf-manual: check-deps $(PDF_MANUAL_ZH) $(PDF_MANUAL_EN)
	@echo -e "\n$(GREEN)✓ User Manual (中英文) 构建完成！$(RESET)"

$(DIST_DIR):
	@mkdir -p $(DIST_DIR)

# Document Metadata Defaults
DOC_AUTHOR_ZH  := NEXFORM 新元体
DOC_AUTHOR_EN  := NEXFORM ROBOTICS
DOC_DATE_ZH    := 2026 年 9 月 8 日
DOC_DATE_EN    := September 8, 2026

# Chinese Quickstart
$(PDF_QS_ZH): QUICKSTART_ZH.md $(COMMON_DEPS) | $(DIST_DIR)
	@echo -e "$(CYAN)[BUILD]$(RESET) 正在编译 Quickstart (中文) -> $@ ..."
	@$(PANDOC) QUICKSTART_ZH.md -o $@ $(PANDOC_FLAGS) \
		-M title="LiteArm" \
		-M subtitle="快速上手指南" \
		-M title-meta="LiteArm 快速上手指南" \
		-M author="$(DOC_AUTHOR_ZH)" \
		-M date="$(DOC_DATE_ZH)" \
		-V docversion="$(QS_VER_ZH)" \
		-V header-includes="\gdef\storedhead{LiteArm 快速上手指南}\gdef\revisionitemonetext{LiteArm 快速上手指南初版发布}" \
		-M toc-title="目录"
	@cp -f $@ $(DIST_DIR)/LiteArm_Quickstart_ZH.pdf
	@echo -e "$(GREEN)[  OK ]$(RESET) $@"

# English localization macros for LaTeX
HEADER_EN_EXTRA := \gdef\versionlabeltext{Version: }\gdef\datelabeltext{Date: }\gdef\revisiontitletext{Revision History}\gdef\revisionvertext{Version}\gdef\revisiondatetext{Date}\gdef\revisiondesctext{Description}\gdef\companynametext{NEXFORM}\gdef\emaillabeltext{Email: }\gdef\phonelabeltext{Tel: }\gdef\wechatlabeltext{WeChat Official Account}

# English Quickstart
$(PDF_QS_EN): QUICKSTART.md $(COMMON_DEPS) | $(DIST_DIR)
	@echo -e "$(CYAN)[BUILD]$(RESET) 正在编译 Quickstart (英文) -> $@ ..."
	@$(PANDOC) QUICKSTART.md -o $@ $(PANDOC_FLAGS) \
		-M title="LiteArm" \
		-M subtitle="Quickstart Guide" \
		-M title-meta="LiteArm Quickstart Guide" \
		-M author="$(DOC_AUTHOR_EN)" \
		-M date="$(DOC_DATE_EN)" \
		-V docversion="$(QS_VER_EN)" \
		-V header-includes="\gdef\storedhead{LiteArm Quickstart Guide}$(HEADER_EN_EXTRA)\gdef\revisionitemonetext{LiteArm Quickstart Guide Initial Release}" \
		-M toc-title="Table of Contents"
	@cp -f $@ $(DIST_DIR)/LiteArm_Quickstart_EN.pdf
	@echo -e "$(GREEN)[  OK ]$(RESET) $@"

# Chinese User Manual
$(PDF_MANUAL_ZH): USER_MANUAL_ZH.md $(COMMON_DEPS) | $(DIST_DIR)
	@echo -e "$(CYAN)[BUILD]$(RESET) 正在编译 User Manual (中文) -> $@ ..."
	@$(PANDOC) USER_MANUAL_ZH.md -o $@ $(PANDOC_FLAGS) \
		-M title="LiteArm Studio" \
		-M subtitle="操作手册" \
		-M title-meta="LiteArm Studio 操作手册" \
		-M author="$(DOC_AUTHOR_ZH)" \
		-M date="$(DOC_DATE_ZH)" \
		-V docversion="$(UM_VER_ZH)" \
		-V header-includes="\gdef\storedhead{LiteArm Studio 操作手册}\gdef\revisionitemonetext{LiteArm Studio 操作手册初版发布}" \
		-M toc-title="目录"
	@cp -f $@ $(DIST_DIR)/LiteArm_User_Manual_ZH.pdf
	@echo -e "$(GREEN)[  OK ]$(RESET) $@"

# English User Manual
$(PDF_MANUAL_EN): USER_MANUAL.md $(COMMON_DEPS) | $(DIST_DIR)
	@echo -e "$(CYAN)[BUILD]$(RESET) 正在编译 User Manual (英文) -> $@ ..."
	@$(PANDOC) USER_MANUAL.md -o $@ $(PANDOC_FLAGS) \
		-M title="LiteArm Studio" \
		-M subtitle="User Manual" \
		-M title-meta="LiteArm Studio User Manual" \
		-M author="$(DOC_AUTHOR_EN)" \
		-M date="$(DOC_DATE_EN)" \
		-V docversion="$(UM_VER_EN)" \
		-V header-includes="\gdef\storedhead{LiteArm Studio User Manual}$(HEADER_EN_EXTRA)\gdef\revisionitemonetext{LiteArm Studio User Manual Initial Release}" \
		-M toc-title="Table of Contents"
	@cp -f $@ $(DIST_DIR)/LiteArm_User_Manual_EN.pdf
	@echo -e "$(GREEN)[  OK ]$(RESET) $@"

check-deps:
	@which $(PANDOC) >/dev/null 2>&1 || { echo -e "$(RED)错误: 未找到 pandoc，请运行: sudo apt-get install pandoc$(RESET)"; exit 1; }
	@which $(PDF_ENGINE) >/dev/null 2>&1 || { echo -e "$(RED)错误: 未找到 $(PDF_ENGINE)，请运行: sudo apt-get install texlive-xetex texlive-lang-cjk fonts-noto-cjk fonts-lato fonts-jetbrains-mono$(RESET)"; exit 1; }

clean:
	@rm -rf $(DIST_DIR)
	@echo -e "$(YELLOW)已清理 $(DIST_DIR) 目录$(RESET)"

help:
	@echo -e "LiteArm 文档导出工具使用说明:"
	@echo -e "  $(CYAN)make pdf$(RESET)             - 编译所有 PDF (中英文 Quickstart + User Manual)"
	@echo -e "  $(CYAN)make pdf-zh$(RESET)          - 仅编译中文 PDF"
	@echo -e "  $(CYAN)make pdf-en$(RESET)          - 仅编译英文 PDF"
	@echo -e "  $(CYAN)make pdf-quickstart$(RESET)  - 仅编译 Quickstart (中英文)"
	@echo -e "  $(CYAN)make pdf-manual$(RESET)      - 仅编译 User Manual (中英文)"
	@echo -e "  $(CYAN)make clean$(RESET)           - 删除 dist/ 输出目录"
