# 0003. A blind relay for peers behind NAT

- Date: 2026-07-01
- Status: Accepted

## Context

The direct transport (0002) needs one peer to be reachable. When both are behind
NAT they cannot connect to each other. The obvious fix — a relay — usually means
trusting a server with the data.

## Decision

- Run the relay as a **blind byte pump**: it reads only a rendezvous id line,
  matches two connections, and pipes raw bytes. The TLS-PSK session runs
  end-to-end *through* the pipe, so the relay forwards ciphertext only and holds
  no key. It cannot read the payload, even as the operator.
- Because the relay cannot authenticate the code (that is what keeps it blind), a
  public relay is an unauthenticated service. Defend **availability** instead:
  global and per-IP connection caps, a short header deadline (slowloris), a
  bounded waiting set, single-use rendezvous ids, and TCP keepalive that reaps
  dead peers without killing a slow-but-live transfer. Operators still
  firewall/rate-limit a public instance.
- **Self-host first.** The tool ships no default relay; the address is explicit
  (`--relay`) or configured via `ENVFERRY_RELAY`, so nobody is silently funneled
  through one operator's box.

## Consequences

- Both-behind-NAT transfers work with the same end-to-end encryption and no
  server that can read the data.
- Running a public relay is an operational and abuse-handling commitment; see
  [operating-a-relay.md](../operating-a-relay.md).
- No NAT hole-punching; the relay carries the full (encrypted) stream for the
  duration of a transfer.
