import { connect, createServer } from "node:tls";
import type { TlsOptions } from "node:tls";
import { randomBytes } from "node:crypto";
import { CIPHERS, IDENTITY } from "./psk.js";
import { MAX_MESSAGE_BYTES, validatePayload } from "./payload.js";
import type { TransferPayload } from "./payload.js";

// Direct, encrypted transport for hosts that can reach each other directly (e.g.
// a server with a static IP + a laptop). It wraps Node's TLS in PSK mode — the
// short-lived key carried in the transfer code is the pre-shared key, so the
// handshake both encrypts the channel and proves the peer holds the code. No
// certificates, no invented crypto.
//
// This is NOT the rendezvous + short-code vision; it is the honest subset that
// works when a host is directly reachable, so the code must carry the host and
// is longer than the loopback spike's code.

// @types/node omits pskCallback from the server option types; describe just that
// field and intersect it in.
type PskTlsOptions = TlsOptions & {
  pskCallback: (socket: unknown, identity: string) => Buffer | null;
};

const CODE_PREFIX = "ef1_";
const DEFAULT_TIMEOUT_MS = 300_000;

export interface OfferDirectOptions {
  /** Address the receiver will dial (the sender's reachable host). */
  advertiseHost: string;
  /** Local interface to listen on. Defaults to 0.0.0.0. */
  bindHost?: string;
  /** How long to wait for a receiver before giving up. Defaults to 5 minutes. */
  timeoutMs?: number;
  onCode?: (code: string) => void;
}

export function isDirectCode(code: string): boolean {
  return typeof code === "string" && code.startsWith(CODE_PREFIX);
}

export async function offerDirectTls(
  payload: TransferPayload,
  options: OfferDirectOptions
): Promise<void> {
  const advertiseHost = options.advertiseHost;
  if (!advertiseHost) {
    // async, so this surfaces as a rejected promise rather than a sync throw.
    throw new Error("Direct transport requires a reachable host (pass --host).");
  }

  const psk = randomBytes(16);
  const bindHost = options.bindHost ?? "0.0.0.0";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const serverOptions: PskTlsOptions = {
      ciphers: CIPHERS,
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.2",
      pskCallback: (_socket, identity) => (identity === IDENTITY ? psk : null),
    };

    const server = createServer(serverOptions, (socket) => {
      // The connection callback fires only after a successful PSK handshake, so
      // the peer is already proven to hold the code. Hand over the payload.
      socket.on("error", () => {});
      socket.end(JSON.stringify({ payload }) + "\n", closeSuccessfully);
    });

    // A failed handshake (wrong code, or a port scanner speaking non-TLS) is
    // rejected cryptographically and leaks nothing, so we keep listening for the
    // real receiver rather than letting internet noise cancel the transfer.
    server.on("tlsClientError", () => {});
    server.on("error", closeWithError);

    server.listen(0, bindHost, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        closeWithError(new Error("Could not bind direct transfer server."));
        return;
      }

      timer = setTimeout(() => {
        closeWithError(new Error("Timed out waiting for a receiver."));
      }, timeoutMs);
      timer.unref?.();

      options.onCode?.(encodeCode({ host: advertiseHost, port: address.port, psk }));
    });

    function closeSuccessfully(): void {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      server.close(() => resolvePromise());
    }

    function closeWithError(error: Error): void {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      server.close(() => reject(error));
    }
  });
}

export async function acceptDirectTls(code: string): Promise<TransferPayload> {
  // async, so a malformed code (decodeCode throws) surfaces as a rejection.
  const { host, port, psk } = decodeCode(code);

  return new Promise((resolvePromise, reject) => {
    let response = "";
    const socket = connect({
      host,
      port,
      ciphers: CIPHERS,
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.2",
      // PSK mode carries no certificate; the shared key is the authentication.
      checkServerIdentity: () => undefined,
      pskCallback: () => ({ psk, identity: IDENTITY }),
    });

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      response += chunk;
      // Abort rather than buffer an oversized (hostile) stream.
      if (response.length > MAX_MESSAGE_BYTES) {
        socket.destroy();
        reject(new Error("Transfer message exceeds the size limit."));
      }
    });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        const message = JSON.parse(response) as { error?: string; payload?: unknown };
        if (message.error !== undefined) {
          reject(new Error(message.error));
          return;
        }

        validatePayload(message.payload);
        resolvePromise(message.payload);
      } catch (error) {
        reject(error);
      }
    });
  });
}

interface DirectCode {
  host: string;
  port: number;
  psk: Buffer;
}

function encodeCode({ host, port, psk }: DirectCode): string {
  const json = JSON.stringify({ v: 1, h: host, p: port, k: psk.toString("hex") });
  return CODE_PREFIX + Buffer.from(json, "utf8").toString("base64url");
}

function decodeCode(code: string): DirectCode {
  if (!isDirectCode(code)) {
    throw new Error("Unsupported transfer code.");
  }

  let parsed: unknown;
  try {
    const json = Buffer.from(code.slice(CODE_PREFIX.length), "base64url").toString("utf8");
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Malformed direct transfer code.");
  }

  const record = parsed as { v?: unknown; h?: unknown; p?: unknown; k?: unknown };
  if (
    record.v !== 1 ||
    typeof record.h !== "string" ||
    typeof record.p !== "number" ||
    !Number.isInteger(record.p) ||
    typeof record.k !== "string" ||
    !/^[a-f0-9]{32}$/.test(record.k)
  ) {
    throw new Error("Malformed direct transfer code.");
  }

  return { host: record.h, port: record.p, psk: Buffer.from(record.k, "hex") };
}
