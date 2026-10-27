# Copyright (c) 2022-2026 Datalayer, Inc.
#
# MIT License

SHELL=/bin/bash
.DEFAULT_GOAL := help

help: ## display this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-18s\033[0m %s\n", $$1, $$2}'

clean: ## remove build outputs
	npm run clean

build: ## build the TypeScript package into lib/
	npm run build

typecheck: ## type-check everything, tests included, against the reactor source
	npm run typecheck

lint: ## Prettier and the header check
	npm run lint

test: ## run the unit tests
	npm test

bench: ## run the Node benches and write bench/results/
	npm run bench

bench-browser: ## run the Node and the browser benches (system Chrome, headless)
	env -u WAYLAND_DISPLAY -u DISPLAY node scripts/bench.mjs --browser

bench-reference: ## the reference figures: the browser benches in a headed Chrome with its GPU (close other work first)
	CELLS_BENCH_HEADED=1 node scripts/bench.mjs --browser

.PHONY: examples
examples: ## start the examples on http://127.0.0.1:3077/ (installs nothing; Ctrl+C stops)
	npm run examples

size: ## bundle sizes against their budgets (needs lib/)
	npm run size

.PHONY: bump bump-patch bump-minor bump-major

bump: ## bump the version in every package.json, asking which part
	python dev/bump_version.py

bump-patch: ## bump the patch version (1.0.3 -> 1.0.4)
	python dev/bump_version.py patch

bump-minor: ## bump the minor version (1.0.3 -> 1.1.0)
	python dev/bump_version.py minor

bump-major: ## bump the major version (1.0.3 -> 2.0.0)
	python dev/bump_version.py major
