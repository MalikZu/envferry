<h1 align="center">envferry</h1>

<p align="center">
  <b>Move .env files between machines without pasting secrets into chat.</b>
</p>

<p align="center">
  A tiny CLI that ferries <code>.env</code> files device-to-device (or to a teammate)
  over an end-to-end encrypted channel — no plaintext on any server, no accounts,
  no secrets in Slack.
  It understands env files instead of treating them as opaque blobs.
</p>

<p align="center">
  <a href="https://github.com/MalikZu/envferry/actions/workflows/ci.yml"><img src="https://github.com/MalikZu/envferry/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/envferry"><img src="https://img.shields.io/npm/v/envferry?logo=npm" alt="npm version"></a>
  <img src="https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js" alt="Node.js 20+">
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/runtime%20deps-0-brightgreen" alt="zero runtime dependencies">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</p>

---

## What it does

You need a `.env` on another machine — your other laptop, a server, a teammate.
The lazy options all leak: paste it into chat, email it, drop it in a shared doc.
`envferry` moves it directly over an encrypted channel instead, and because it
understands env files it lands them safely on the other side.

```sh
# on the machine that has the file
envferry send .env --relay your-relay.example:8787
#   → code: efr1_… (share this out-of-band)

# on the machine that needs it
envferry get efr1_…
#   → wrote: .env
```

The transfer is **end-to-end encrypted** (TLS-PSK, forward secret): the one-time
key lives inside the code, and no server ever sees your secrets in the clear.

## Install

```sh
# one-off, no install
npx envferry send .env --relay your-relay.example:8787

# global CLI
npm install -g envferry

# Homebrew
brew install MalikZu/tap/envferry
```

Requires **Node.js 20+**. Zero runtime dependencies — the whole tool is Node's
standard library, which keeps the supply-chain surface (the real risk for a
secret-handling package) as small as possible.

## Moving a file between two machines

Pick the transport by reachability — `get` auto-detects which one from the code.

| Situation | Command | Code |
|---|---|---|
| The usual case: any two machines, NAT or not | `envferry send .env --relay <relay-addr>` | `efr1_…` |
| The **sending** machine is directly reachable (static IP, LAN, VPN) | `envferry send .env --host <its-own-addr>` | `ef1_…` |
| Same machine (two shells) | `envferry send .env` | `local-…` |

> **`--host` is not where the relay lives.** `--host` means "other machines can
> reach *this* machine at this address" — the receiver dials the *sender*
> directly, no relay involved, and the port is picked automatically. If you have
> a relay address (`host:port`), the flag you want is `--relay`. The CLI now
> rejects `--host host:port` with exactly this hint.

See [docs/operating-a-relay.md](docs/operating-a-relay.md) to run your own relay
(a few seconds of setup, no TLS certificates needed — transfers are already
end-to-end encrypted).

Set a relay once and drop the address from then on (accepts a DNS name or an IP):

```sh
envferry config set relay relay.example.com:8787
envferry send .env --relay        # uses the configured relay
```

```sh
# receive it (any code type)
envferry get <code>
```

### Send to the whole team

One send can serve several receivers — the code stays redeemable until everyone
has it (or the timeout hits):

```sh
envferry send .env --relay --receivers 5
#   → code: efr1_… — share it with the team; up to 5 gets succeed
```

Works with `--relay` (needs a relay running envferry ≥ 0.2.0) and `--host`.
Capped at 64. Note the tradeoff: a multi-receiver code is redeemable more than
once by design, so the usual "use it promptly, share it over a channel you
trust" advice matters even more.

## .env-aware, not a generic file mover

- **Auto-name on receive** — `.env.production` lands as `.env.production`, never
  `received_file`.
- **Path-traversal safe** — a sender can't steer the write outside your directory;
  only `.env`/`.env.*` names are accepted, and existing files are never clobbered.
- **Masked previews** — `merge-preview` shows which keys change without printing a
  single value:

  ```sh
  envferry merge-preview .env .env.incoming
  #   target: /path/.env.incoming
  #   update: API_URL
  #   add: NEW_SECRET
  ```

## Security

- **End-to-end encrypted** with `ECDHE-PSK-CHACHA20-POLY1305` (AEAD + forward
  secrecy). The transfer code carries a one-time pre-shared key; a wrong code
  fails the handshake and learns nothing.
- **No plaintext at rest, ever.** Direct transfers are peer-to-peer. The relay is
  a *blind byte pump* — it pipes ciphertext and holds no key, so even the relay
  operator can't read your secrets.
- **No invented crypto** — it wraps Node's built-in TLS (OpenSSL).

The code is the capability: anyone who intercepts it can receive the file, so
share it over a channel you trust and use it promptly. Read the full
[threat model](docs/threat-model.md) before relying on it.

## Use as a library

```ts
import { mergeEnv, parseEnv } from "envferry";

const { text, changes } = mergeEnv(existing, incoming);
```

The transport primitives (`offerDirectTls`, `acceptViaRelay`, `startRelay`, …) are
exported too, behind a small `Transport` boundary.

## Project layout

```text
src/env/          .env parsing, merging, masking
src/files/        safe receive-target planning
src/transport/    the transport boundary + local, direct, and relay adapters
src/cli.ts        command dispatch
src/bin/          the executable entry point
test/             Node's built-in test runner (run against the built artifact)
docs/             threat model, relay guide, architecture decisions
```

## Docs

- [Threat model](docs/threat-model.md)
- [Operating a relay](docs/operating-a-relay.md)
- [Architecture decisions](docs/decisions/)
- [Release guide](docs/release.md)
- [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md) · [Agent guide](AGENTS.md)

## License

[MIT](LICENSE) © 2026 Malik AlZubaidi
