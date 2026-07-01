# Release guide

`envferry` publishes from GitHub Actions using **npm trusted publishing (OIDC)**,
so no long-lived npm token is stored and provenance is generated automatically for
the public package.

## One-time setup

1. Create the public GitHub repo `MalikZu/envferry` and push.
2. On npmjs.com, add a **trusted publisher** for the package pointing at this
   repo's `.github/workflows/release.yml`. Optionally protect the `npm`
   environment with required reviewers.
3. For Homebrew, create the tap repo `MalikZu/homebrew-envferry` with a `Formula/`
   directory, and add a `HOMEBREW_TAP_TOKEN` secret (a fine-grained PAT with
   contents:write on the tap repo). The release workflow bumps the formula there
   from `packaging/homebrew/envferry.rb`.

Trusted publishing needs npm ≥ 11.5.1; the release workflow uses Node 24, which
ships it.

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
