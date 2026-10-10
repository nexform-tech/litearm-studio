# LiteArm Studio - Makefile
#
# Prerequisites: Node.js 20+ and pnpm.
#
# Common targets:
#   make setup      Install dependencies (pnpm install)
#   make dev        Start Vite development server (http://localhost:5173)
#   make test       Run unit tests (Vitest)
#   make lint       Run linter (oxlint)
#   make typecheck  Run TypeScript type checking
#   make build      Build production web bundle (tsc + Vite, output to dist/)
#   make preview    Preview production web build locally
#   make sdk        Install the pinned SDK submodules into the venv
#   make deb        Build the installable Debian package (Docker, Ubuntu 22.04 base)

SHELL := /bin/bash
ROOT := $(CURDIR)

#: Interpreter the Python targets install into; override for a venv elsewhere
#: (`make sdk PY=/usr/bin/python3`).
PY ?= .venv/bin/python

.DEFAULT_GOAL := help

.PHONY: help setup dev test lint typecheck build preview sdk deb deb-image pdf pdf-zh pdf-en docs doc

help: ## Show available commands
	@echo 'LiteArm Studio'
	@echo
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  make %-18s %s\n", $$1, $$2}'

setup: ## Install project dependencies (pnpm install)
	pnpm install

dev: ## Start web development server (Vite, http://localhost:5173)
	pnpm dev

test: ## Run unit tests (Vitest)
	pnpm test

lint: ## Run code linter (oxlint)
	pnpm lint

typecheck: ## Run TypeScript type check
	pnpm exec tsc -b

build: ## Build production web app (tsc + Vite, output to dist/)
	pnpm build

preview: ## Preview production build locally
	pnpm preview

deb: ## Build the installable Debian package (Docker, Ubuntu 22.04 base)
	./scripts/build-deb.sh

deb-image: ## (Re)build the container image the .deb build runs in
	docker build -f packaging/deb.Dockerfile -t litearm-studio-deb-builder:22.04 .

sdk: ## Install the pinned SDK submodules (litearm-python + litegrip-python) into the venv
	# 两个 SDK 都不在 PyPI 上: 唯一来源是本仓的 git submodule (sdk/), 版本 = 钉住的 tag。
	# 开发 venv / CI / .deb 打包容器 / Windows 构建都走这一条, 不再各自 clone。
	git submodule update --init --recursive
	$(PY) -m pip install ./sdk/litearm-python ./sdk/litegrip-python

pdf: ## Build documentation PDFs (Quickstart + User Manual)
	$(MAKE) -C docs pdf

pdf-zh: ## Build Chinese documentation PDFs
	$(MAKE) -C docs pdf-zh

pdf-en: ## Build English documentation PDFs
	$(MAKE) -C docs pdf-en

docs: pdf ## Alias for make pdf
doc: pdf ## Alias for make pdf
