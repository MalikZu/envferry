# 4. Multi-receiver codes via opt-in multi-use rendezvous ids

Date: 2026-07-21

## Status

Accepted

## Context

A common real workflow is onboarding several teammates at once: one `.env`, many
receivers. With one-shot codes the sender must run `send` once per person and
distribute a different code to each — friction that pushes people back toward
pasting the file into chat, the exact failure envferry exists to prevent.

Both encrypted transports were strictly one-shot on purpose: the direct listener
closes after the first successful handshake, and the relay marks a rendezvous id
consumed at first pairing (defense-in-depth against replaying an intercepted
code).

## Decision

Add `--receivers <n>` (capped at 64, default 1) to `send`:

- **Direct transport**: the TLS-PSK listener stays open and counts successful
  deliveries, closing after the n-th. No wire change.
- **Relay transport**: the rendezvous header gains an opt-in flag — `<id> m\n`
  instead of `<id>\n`. The relay marks an id consumed only when *neither* peer of
  a pairing flagged multi-use. The sender re-registers the same id after each
  served receiver. Single-receiver traffic is unchanged on the wire, so old and
  new clients/relays interoperate for the default case; only `--receivers > 1`
  requires a relay ≥ 0.2.0 (an old relay drops the flagged header, and the
  client reports that explicitly after repeated instant rejections).
- Multi-receiver sends get a client-side session deadline (default 15 minutes)
  because the relay's per-wait pair timeout no longer bounds the whole exchange.

## Consequences

- One command, one code, n teammates; progress is reported per delivery.
- The single-use replay hardening is relaxed **only by explicit opt-in**, and the
  threat model documents the tradeoff: the code is still the capability, and a
  multi-use code widens how many times it can be exercised within its window.
  Confidentiality (PSK handshake, forward-secret AEAD) is untouched.
- The relay stays blind: the `m` flag is routing metadata, not content; the relay
  still never interprets payload bytes.
- A deliberate DoS surface was considered: an attacker who saw a multi-use code
  could pre-register the id and pair with real receivers; their handshake fails
  (no PSK) and the sender simply re-offers, so the impact stays availability-only
  — the same class as the pre-existing pre-first-use window.
