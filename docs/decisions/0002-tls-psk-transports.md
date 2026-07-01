# 0002. Encrypted transports use TLS-PSK, not invented crypto

- Date: 2026-07-01
- Status: Accepted

## Context

Moving a secret between two machines needs confidentiality, integrity, and proof
that the peer is the intended recipient — without shipping a certificate
authority or a key-management story. Rolling a bespoke handshake is the classic
way to get this subtly wrong.

## Decision

- Wrap Node's built-in TLS (OpenSSL) in **PSK mode**. The one-time key generated
  per transfer travels inside the transfer code and is the pre-shared key, so the
  handshake both encrypts the channel and proves the peer holds the code. No
  certificates, no bespoke protocol.
- Negotiate **`ECDHE-PSK-CHACHA20-POLY1305` only** — an AEAD suite with forward
  secrecy. We deliberately omit a non-ECDHE fallback (e.g. `PSK-AES256-GCM`),
  which would derive the session key from the PSK alone and let recorded
  ciphertext be decrypted retroactively if the code later leaked. Both peers are
  Node with a bundled OpenSSL that supports the suite, so no fallback is needed.
- Offer a `--host` direct transport for reachable peers; the blind relay (0003)
  covers the both-behind-NAT case, reusing the same session over a piped socket.

## Consequences

- Strong, well-understood cryptography with no custom code to audit.
- The transfer code is a capability: whoever holds it can receive the file. This
  is the accepted trust model for a one-shot transfer code.
- Short, human-memorable codes are **not** yet safe against offline guessing —
  that needs a PAKE (SPAKE2) plus a rendezvous broker, which is future work. Codes
  are therefore long and high-entropy for now.
