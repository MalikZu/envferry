# envferry — dev & release tasks
.PHONY: check typecheck build test smoke pack-check release-check clean

check: ## run the full local verification set (typecheck, build, test, smoke, pack)
	npm run check

typecheck: ## type-check src and tests without emitting
	npm run typecheck

build: ## compile TypeScript to dist/
	npm run build

test: ## run the unit tests
	npm test

smoke: ## confirm the built CLI starts
	npm run build && npm run smoke

pack-check: ## verify npm package contents without publishing
	npm run pack:check

release-check: check ## local preflight before tagging a release
	npm audit --omit=dev

clean:
	rm -rf dist envferry-*.tgz
