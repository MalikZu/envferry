import { TLSSocket, connect } from "node:tls";
import type { TLSSocketOptions } from "node:tls";
import type { Socket } from "node:net";
import { validatePayload } from "./payload.js";
import type { TransferPayload } from "./payload.js";

// Shared TLS-PSK configuration and helpers for the encrypted transports. Node's
// built-in TLS (OpenSSL) does the cryptography; the key carried in the transfer
// code is the pre-shared key. The socket helpers run a TLS session over an
// *already-open* socket, so the same code works for a direct connection or one
// piped through the blind relay.

export const IDENTITY = "envferry";

// Forward-secret AEAD only. ECDHE-PSK gives ephemeral key exchange, so recorded
// ciphertext stays safe even if the code's key later leaks. We deliberately do
// not list a non-ECDHE fallback (e.g. PSK-AES256-GCM), which would derive the
// session key from the PSK alone and defeat forward secrecy. Both peers are Node
// with a bundled OpenSSL that supports this suite, so no fallback is needed.
export const CIPHERS = "ECDHE-PSK-CHACHA20-POLY1305";

// @types/node omits pskCallback from TLSSocketOptions even though Node supports
// it for server sockets, so we describe just that field and intersect it in.
type ServerPskCallback = (socket: TLSSocket, identity: string) => Buffer | null;
type PskServerOptions = TLSSocketOptions & { pskCallback: ServerPskCallback };

/** Sender role: wrap an open socket as a TLS server and push the payload. */
export function sendPayloadOverSocket(
  rawSocket: Socket,
  psk: Buffer,
  payload: TransferPayload
): Promise<void> {
  return new Promise((resolve, reject) => {
    const options: PskServerOptions = {
      isServer: true,
      ciphers: CIPHERS,
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.2",
      pskCallback: (_socket, identity) => (identity === IDENTITY ? psk : null),
    };
    const secured = new TLSSocket(rawSocket, options);

    secured.on("error", reject);
    secured.on("secure", () => {
      secured.end(JSON.stringify({ payload }) + "\n", () => resolve());
    });
  });
}

/** Receiver role: wrap an open socket as a TLS client and read the payload. */
export function receivePayloadOverSocket(rawSocket: Socket, psk: Buffer): Promise<TransferPayload> {
  return new Promise((resolve, reject) => {
    const secured = connect({
      socket: rawSocket,
      ciphers: CIPHERS,
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.2",
      // PSK mode carries no certificate; the shared key is the authentication.
      checkServerIdentity: () => undefined,
      pskCallback: () => ({ psk, identity: IDENTITY }),
    });

    let response = "";
    secured.setEncoding("utf8");
    secured.on("data", (chunk: string) => {
      response += chunk;
    });
    secured.on("error", reject);
    secured.on("end", () => {
      // Close our side too, so the peer (and any relay in between) sees a clean
      // shutdown instead of a lingering half-open socket.
      secured.end();
      try {
        const message = JSON.parse(response) as { error?: string; payload?: unknown };
        if (message.error !== undefined) {
          reject(new Error(message.error));
          return;
        }

        validatePayload(message.payload);
        resolve(message.payload);
      } catch (error) {
        reject(error);
      }
    });
  });
}
