# Release guide

`envferry` publishes from GitHub Actions using an npm token stored as the
`NPM_ACCESS_TOKEN` repo secret. Provenance is attached automatically once the repo
is public — the workflow enables `--provenance` only for a public repo, so a
private-repo release still succeeds without it.

## One-time setup

1. Push the repo (`MalikZu/envferry`).
2. Reserve the `envferry` name on npm, create an automation token with publish
   rights, and store it as the `NPM_ACCESS_TOKEN` repo secret:
   `gh secret set NPM_ACCESS_TOKEN`.
3. For Homebrew, create a single generic tap repo `MalikZu/homebrew-tap` with a
   `Formula/` directory (it can hold formulae for several projects), and add a
   `HOMEBREW_TAP_TOKEN` secret to this repo (a fine-grained PAT with
   contents:write on the tap repo). The release workflow renders
   `packaging/homebrew/envferry.rb` into `Formula/envferry.rb` there, so users can
   `brew install MalikZu/tap/envferry`.
4. Make the repo **public** before the release you want signed with provenance.

The release workflow uses Node 24.

> Prefer no stored token? npm trusted publishing (OIDC) also works: configure a
> trusted publisher for `.github/workflows/release.yml` on npmjs and swap the
> publish step to rely on OIDC instead of `NODE_AUTH_TOKEN`.

## Each release

1. Bump the version and commit it:
   ```sh
   npm version <patch|minor|major> --no-git-tag-version
   git commit -am "chore: release v$(node -p "require('./package.json').version")"
   ```
2. Run the local preflight:
   ```sh
   make release-check   # npm run check + npm audit --omit=dev
   ```
3. Tag and push:
   ```sh
   VERSION="v$(node -p "require('./package.json').version")"
   git tag "$VERSION" && git push origin main "$VERSION"
   ```
4. The tag push triggers **Release**, which verifies the tag matches
   `package.json`, runs `npm run check`, publishes to npm with provenance, creates
   the GitHub release (hyphenated tags like `v0.1.0-rc.1` become pre-releases), and
   bumps the Homebrew formula for stable tags.
5. Confirm the npm page shows provenance and `npx envferry@latest --help` works.

## Before `1.0.0`

- Ship a PAKE-backed short-code transport (SPAKE2 + rendezvous) so human-memorable
  codes are safe against offline guessing (see ADR 0002).
- Consider an optional link/escrow mode for offline recipients.
