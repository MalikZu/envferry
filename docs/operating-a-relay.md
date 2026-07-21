# Operating a relay

The relay lets two peers that cannot reach each other directly (both behind NAT)
complete a transfer. Both peers dial *out* to the relay, which pairs them by a
rendezvous id and pipes bytes. The TLS-PSK session runs end-to-end *through* the
relay, so it forwards **ciphertext only** — it holds no key and cannot read any
secret, not even for the operator.

You do not need a relay for the common case: if either peer is reachable (a static
IP, a LAN, a VPN), use the direct transport (`--host`) with no shared
infrastructure. Run a relay only for the both-behind-NAT case.

## Run it

```sh
envferry relay --port 8787
#   → relay listening on 0.0.0.0:8787
```

No TLS termination or certificate is needed at the relay — the transfer is already
end-to-end encrypted, so you just expose a plain TCP port.

### Flags

| Flag | Default | Purpose |
| --- | --- | --- |
| `--host <address>` | `0.0.0.0` | Interface to bind. |
| `--port <port>` | random | TCP port to listen on. |
| `--max-connections <n>` | `512` | Global cap on concurrent connections. |
| `--max-per-ip <n>` | `32` | Cap on concurrent connections from one IP. |
| `--pair-timeout <seconds>` | `300` | How long a waiting peer is held before it is dropped. |
| `--header-timeout <seconds>` | `30` | Deadline for a peer to announce its rendezvous id (slowloris defense). |
| `--max-session-bytes <n>` | `16777216` | Total bytes a paired session may forward before it is cut. |
| `--max-session-seconds <seconds>` | `900` | Wall-clock lifetime of a paired session. |

Public operators may want tighter session caps, e.g.
`envferry relay --port 8787 --max-per-ip 8 --max-session-bytes 4194304 --max-session-seconds 120`.

## Point clients at it

```sh
# sender
envferry send .env --relay your-relay.example:8787

# or set a persistent default (a DNS name or an IP), then omit the value:
envferry config set relay your-relay.example:8787
envferry send .env --relay
# ENVFERRY_RELAY works too and takes precedence over the config file.
```

The relay address is embedded in the `efr1_` code, so `get` needs no relay flag.
For IPv6, bracket the address: `--relay [2001:db8::1]:8787`.

A common mix-up: the relay address goes in `--relay`, never in `--host`. `--host`
selects the *direct* transport and names the sender's own reachable address — the
CLI rejects a `host:port` value there and points back here.

## Multi-receiver sends

`envferry send --relay --receivers <n>` serves one code to up to `n` receivers by
re-pairing the same rendezvous id (the peer announces `<id> m` instead of `<id>`).
Relays older than envferry 0.2.0 drop that header, so multi-receiver sends need
the relay updated; single-receiver traffic is wire-compatible in both directions.

If the sender runs *on* the relay host, dial it locally but advertise the public
address so the receiver can reach it:

```sh
envferry send .env --relay 127.0.0.1:8787 --relay-advertise your-relay.example:8787
```

## Running one publicly — read this first

A public relay is an **unauthenticated network service**. By design the relay is
blind, so it cannot authenticate the transfer code or inspect content — which also
means it cannot tell an envferry transfer from someone tunneling arbitrary bytes
through it. If you expose one to the internet:

- **Firewall / rate-limit it upstream.** The built-in caps (global, per-IP,
  timeouts) raise the bar but are not a substitute for network-level limits.
- **Expect abuse and be able to respond.** You cannot filter by content; your
  levers are the caps, IP blocks, and restarting the process (which drops all
  in-flight sessions). Publish an abuse contact.
- **Set expectations.** Best-effort, no SLA; tell heavy users to self-host.
- **You see metadata, never content** — peer IPs, timing, and byte counts cross
  the relay in the clear; the payload does not.

### systemd example

```ini
[Unit]
Description=envferry relay
After=network.target

[Service]
ExecStart=/usr/bin/env envferry relay --port 8787 --max-per-ip 8
Restart=on-failure
DynamicUser=yes
# Optionally restrict which IPs can reach it:
# IPAddressAllow=203.0.113.0/24
# IPAddressDeny=any

[Install]
WantedBy=multi-user.target
```

For a stronger boundary, bind the relay to `127.0.0.1` and expose it only through
a reverse proxy or a WireGuard/Tailscale network you control.
