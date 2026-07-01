# Contributing

Thanks for helping make `envferry` trustworthy.

## Setup

Node.js 20+. Then:

```sh
npm install
npm run check
```

`npm run check` runs the type checker, the build, the unit tests, a CLI smoke
check, and an `npm pack` dry run — the same gate CI enforces.

## Project shape

- Secret-handling logic lives in `src/env`.
- Filesystem safety checks live in `src/files`.
- Transport work goes behind the `offer`/`accept` boundary in `src/transport`.
- Add tests for behavior before expanding the CLI surface. CLI tests spawn the
  built artifact, so they cover what actually ships.

## Security rules

- Do not add custom cryptographic protocols — wrap Node's built-in TLS.
- Do not add runtime dependencies; every one increases the trust burden.
- Do not print secret values in output, logs, errors, or tests.
- Prefer small, reviewable changes with clear threat-model notes.

Transport PRs should name the underlying protocol/library, its maintenance
status, and what interoperability or security evidence exists.

## Commits

Conventional Commits with a scope and a bulleted "why" body; no AI co-author
trailer. See [AGENTS.md](AGENTS.md) and
[.claude/skills/semantic-commit](.claude/skills/semantic-commit/SKILL.md).
