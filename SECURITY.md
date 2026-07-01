# Security policy

`envferry` handles developer secrets, so security reports are welcome. Please do
not file exploit details as public issues.

## Supported versions

Until `1.0.0`, security fixes target the latest released version and `main`.

## Reporting a vulnerability

Use GitHub private vulnerability reporting. Do **not** include real secrets in a
report — reproduce with dummy values.

Helpful reports include:

- The affected command or API.
- A minimal reproduction using dummy values.
- Whether plaintext secrets can be exposed, overwritten, or sent to the wrong
  destination.

## Scope

In scope:

- Plaintext secret disclosure over any transport.
- A relay that can read, tamper with, or misroute a payload it is meant to
  forward blindly.
- Path traversal or unsafe receive-target behavior.
- Dependency or release-process compromise.
- Downgrade or forward-secrecy weaknesses in the TLS-PSK handshake.

Out of scope:

- The loopback transport (`local-…`), documented as unencrypted and same-machine
  only.
- Denial of service against a self-hosted relay from an unauthenticated client:
  the built-in caps raise the bar, but operators are expected to firewall or
  rate-limit a public relay (see [docs/operating-a-relay.md](docs/operating-a-relay.md)).

See [docs/threat-model.md](docs/threat-model.md) for the full model.
