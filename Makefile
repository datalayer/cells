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

bench-reference: ## the dev-server figures, for spotting regressions: the browser benches in a headed Chrome with its GPU (close other work first)
	CELLS_BENCH_HEADED=1 node scripts/bench.mjs --browser

bench-reference-production: ## the reference figures of the budgets, charts among them: the browser benches on a production build, in a headed Chrome with its GPU (close other work first)
	CELLS_BENCH_HEADED=1 CELLS_BENCH_BUILD=production node scripts/bench.mjs --browser

.PHONY: start examples jupyter-server
start: examples ## start the examples (the same as make examples)

examples: ## start the examples on http://127.0.0.1:3077 (installs nothing; Ctrl+C stops)
	npm run examples

jupyter-server: ## a local Jupyter server for the Code cells example's "Jupyter (local)" kernel (needs `pip install -e ".[live]"` here)
	jupyter server --config=dev/jupyter_server_config.py

.PHONY: build-examples deploy-examples
build-examples: ## build the examples site into examples/dist
	rm -rf examples/dist
	npx vite build --config examples/vite.config.ts --outDir dist --emptyOutDir

deploy-examples: build-examples ## publish the examples on https://cells.datalayer.tech
	(source $$(conda info --base)/etc/profile.d/conda.sh; conda activate datalayer; \
	  aws s3 rm \
		s3://datalayer-cells/ \
		--recursive && \
	  aws s3 cp \
		./examples/dist \
		s3://datalayer-cells/ \
		--recursive && \
	  aws cloudfront create-invalidation \
		--distribution-id EJMQSIG0ZTQVR \
		--paths "/*" )
	echo open ✨  https://cells.datalayer.tech

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
