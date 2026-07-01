// Shared TLS-PSK configuration for the encrypted transports. Node's built-in TLS
// (OpenSSL) does the cryptography; the key carried in the transfer code is the
// pre-shared key, and this identity + cipher suite is what both peers negotiate.

export const IDENTITY = "envferry";

// Forward-secret AEAD only. ECDHE-PSK gives ephemeral key exchange, so recorded
// ciphertext stays safe even if the code's key later leaks. We deliberately do
// not list a non-ECDHE fallback (e.g. PSK-AES256-GCM), which would derive the
// session key from the PSK alone and defeat forward secrecy. Both peers are Node
// with a bundled OpenSSL that supports this suite, so no fallback is needed.
export const CIPHERS = "ECDHE-PSK-CHACHA20-POLY1305";
