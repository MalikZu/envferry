# Threat model

`envferry` moves developer secrets between machines. This document states what it
protects, how, and where the boundaries are, so you can decide whether it fits
your risk tolerance.

## Assets

- Raw `.env` values.
- Filenames, which can reveal environments or services (`.env.production`).
- Transfer codes — each carries a one-time key and is therefore a capability.
- Local files that could be overwritten on receive.

## Trust model

The security guarantee is architectural, not a promise:

- Every encrypted transfer runs a **TLS-PSK** session (`ECDHE-PSK-CHACHA20-POLY1305`,
  an AEAD suite with forward secrecy) end-to-end between the two peers. The
  pre-shared key is generated per transfer and carried inside the code.
- **No server sees plaintext.** Direct transfers are peer-to-peer. The relay only
  ever forwards ciphertext (see below).
- **No invented crypto.** The transports wrap Node's built-in TLS (OpenSSL).

The transfer **code is the capability.** Anyone who obtains a code can receive the
file (or, for a relay upload, connect as the peer). Share codes over a channel you
trust, and use them promptly — they are one-shot and time-limited.

## Transports

| Transport | Code | Reach | Encryption | Notes |
|---|---|---|---|---|
| Loopback | `local-…` | Same machine only | **None** | Proves the send/get lifecycle; binds `127.0.0.1`. Not for cross-device use. |
| Direct | `ef1_…` | One peer reachable | TLS-PSK, forward secret | Sender binds a listener; one-shot by default; 5-minute timeout. |
| Relay | `efr1_…` | Neither peer reachable | TLS-PSK, forward secret | Both peers dial a blind relay that pipes ciphertext. |

### Direct transport

The sender binds a TLS-PSK listener and advertises its host in the code. A wrong
code fails the handshake and is ignored — a 128-bit key makes online guessing
infeasible — so a bad attempt does not cancel the pending transfer. The listener
is single-use by default and opens a port for the transfer window, so prefer a
host you can firewall to the peer, or tunnel over SSH.

### Blind relay

For peers that cannot reach each other, `envferry relay` pairs two outbound
connections by a rendezvous id and pipes their bytes. The TLS-PSK session runs
end-to-end *through* the pipe, so:

- The relay **holds no key and forwards ciphertext only** — it cannot read the
  payload, even as the operator. (A test asserts it forwards raw bytes unchanged.)
- A wrong key still pairs but fails the end-to-end handshake, so a mispaired or
  malicious peer learns nothing.
- Rendezvous ids are **single-use by default**; a used id is not paired again.
- Availability defenses: a global connection cap, a per-IP cap, a short header
  deadline (slowloris), a bounded waiting set, and TCP keepalive that reaps dead
  peers without killing a slow-but-live transfer.

Because the relay cannot authenticate the code (that is what keeps it blind), a
public relay is an unauthenticated service — firewall or rate-limit it upstream.
See [operating-a-relay.md](operating-a-relay.md).

### Multi-receiver sends (`--receivers <n>`)

`--receivers` deliberately relaxes the one-shot property: the code stays
redeemable until `n` receivers are served or the send times out. What changes
and what does not:

- **Confidentiality is unchanged** — every receiver still authenticates by the
  PSK; a wrong code still fails the handshake and learns nothing.
- **Replay hardening is relaxed by opt-in only.** Single-receiver sends keep
  single-use codes/ids on the wire, byte-for-byte as before. With `--receivers`,
  anyone who obtains the code inside the window can redeem one of the `n` slots —
  the code was always the capability; multi-receiver widens *how many times* it
  can be exercised, not *who* can exercise it (still: anyone holding it).
- The count is capped (64) and the session has a deadline, so a leaked
  multi-use code cannot be redeemed unbounded times.

Share multi-receiver codes over a channel scoped to the intended group, and
prefer the smallest `n` that does the job.

## What an attacker can and cannot do

An on-path network attacker who does **not** have the code:

- ✅ sees peer IPs, timing, and byte counts (metadata).
- ❌ cannot read the payload — it is AEAD-encrypted end-to-end.
- ❌ cannot tamper undetected — AEAD provides integrity.
- ❌ cannot complete a transfer — the PSK handshake fails without the key.

Someone who **obtains the code** can receive the file. The code is the secret.

## Residual risks and non-goals

- **Loopback transport is unencrypted** and is for a single machine only.
- The relay operator sees metadata (IPs, timing, sizes) but never content.
- A public relay can be used as a generic byte pump by anyone who can reach it;
  the built-in caps limit abuse but do not authenticate callers.
- **Short, human-memorable codes are not yet safe.** Making a low-entropy code
  resistant to offline guessing needs a PAKE (e.g. SPAKE2) with a rendezvous
  broker. Until then, codes are long and high-entropy.
- Link/escrow mode (async, offline recipient) is not implemented.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md). Please do not include real secrets in reports.
