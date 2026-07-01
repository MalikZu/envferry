# 0001. TypeScript CLI, zero runtime dependencies

- Date: 2026-07-01
- Status: Accepted

## Context

`envferry` handles developer secrets. Two properties matter most: it must feel
native to `npx`/`npm`, and it must minimize supply-chain risk — a secret-handling
package with a large dependency tree is exactly what attackers target through
typosquatting and dependency confusion.

## Decision

- Build as a Node.js CLI in strict TypeScript, published to npm with provenance.
- **Zero runtime dependencies** — everything is Node's standard library. Dev-only
  tooling (`typescript`, `tsx`) is fine; nothing reaches the published dependency
  graph.
- Use Node's built-in test runner, executed against the compiled artifact so the
  tests exercise what actually ships.
- Define a narrow transport boundary (`offer`/`accept`) so the app core is
  decoupled from any specific wire protocol and can be tested with an in-memory
  fake.

## Consequences

- Adoption is easier (npx-native) and the audit surface stays tiny.
- New transports slot in behind the boundary without touching the CLI or the
  `.env` logic.
- We accept a compile step; the build emits ESM plus type declarations to `dist/`.
