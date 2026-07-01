---
name: semantic-commit
description: Write descriptive, bullet-pointed Conventional Commits for the envferry repo. Use whenever staging and committing changes (the user asks to "commit", "save progress", or after finishing a unit of work). Enforces Conventional Commit format, an imperative subject, a bulleted body, logical-unit splitting (stage hunks, not whole files, when a file mixes concerns), and NO AI co-author trailer.
allowed-tools: [Bash, Read, Grep]
---

# Semantic Commit (envferry)

Author git commits for **envferry** — a zero-dependency TypeScript CLI that moves
`.env` files between machines over an end-to-end encrypted channel — following
[Conventional Commits](https://www.conventionalcommits.org): descriptive,
scannable, and machine-parseable for changelog generation.

## Hard rules (non-negotiable for this repo)

1. **NEVER add an AI co-author trailer.** Do not append `Co-Authored-By: Claude …`
   or any `🤖 Generated with …` line. Commits are authored as the user.
2. **Subject line** = `<type>(<scope>): <summary>`
   - `type` from the table below.
   - `scope` optional but encouraged — see the scope list for this repo.
   - `summary` in the **imperative mood** ("add", not "added"/"adds"), ≤ 72 chars, no trailing period.
3. **Body is mandatory for anything non-trivial** and uses **bullet points** (`- `),
   each describing one concrete change and *why* it matters — not a restatement of the diff.
4. **Wrap the body at ~100 columns.** Blank line between subject and body.
5. **One logical unit per commit.** If a change spans multiple concerns, split it —
   **stage individual hunks** (`git add -p`, or `git apply --cached` with a crafted
   patch when non-interactive) rather than committing a whole file that mixes concerns.
6. **Breaking changes** get a `!` after the type/scope (`feat(cli)!:`) **and** a
   `BREAKING CHANGE:` footer explaining the migration.
7. **Each commit should leave the tree green** where practical (`npm run check`),
   so history stays bisectable.

## Types

| Type | Use for |
|------|---------|
| `feat` | A new capability or user-facing feature |
| `fix` | A bug fix |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `perf` | A performance improvement |
| `test` | Adding or correcting tests |
| `docs` | Documentation only |
| `build` | Build tooling, packaging (npm, Homebrew), release scripts |
| `ci` | CI configuration |
| `chore` | Tooling, scaffolding, skills, housekeeping (no src/test behavior change) |
| `style` | Formatting only (whitespace, comments) — no logic change |

## Scopes for this repo

`env` (.env parsing/merge/mask), `files` (receive-target safety), `transport`
(the boundary + local/direct/relay adapters), `cli`, `tests`, `docs`, `ci`,
`build`, `chore`.

## Template

```
<type>(<scope>): <imperative summary>

- <what changed and why — one bullet per logical change>
- <second change …>

BREAKING CHANGE: <only if applicable>
```

## Good example

```
feat(transport): add a direct encrypted transport for reachable hosts

- Bind a TLS-PSK listener so the one-time key in the code both encrypts the
  channel and proves the peer holds the code; no certificates, no invented crypto.
- Codes are ef1_<base64url> carrying host + port + key; get auto-detects them.
```

## Anti-patterns to reject

- ❌ `update files` / `fixes` / `wip` — vague, non-imperative, no scope.
- ❌ A body that just lists filenames or pastes the diff.
- ❌ Any `Co-Authored-By: Claude` / `Generated with Claude Code` trailer.
- ❌ Squashing unrelated changes into one commit — split by logical unit, hunk by hunk.

## Workflow the skill follows

1. `git status` + `git diff` (staged and unstaged) to understand the change set.
2. Group changes into logical units. When a single file holds more than one unit,
   stage only the relevant hunks (`git add -p`; or `git diff … | git apply --cached`
   on a hand-trimmed patch when interactive mode is unavailable).
3. Draft the message per the template; verify the checklist below.
4. Commit with a real multi-line message (heredoc or repeated `-m`),
   **never** passing an AI co-author trailer.

## Pre-commit checklist

- [ ] Subject is `type(scope): imperative summary`, ≤ 72 chars, no period.
- [ ] Body present (for non-trivial work) and uses `- ` bullets explaining *why*.
- [ ] Each commit is one logical unit; mixed files were split by hunk.
- [ ] Breaking changes flagged with `!` and a `BREAKING CHANGE:` footer.
- [ ] No AI co-author / generated-by trailer.
