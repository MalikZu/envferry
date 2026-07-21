import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { parseRelayAddress } from "./relay.js";
import type { RelayAddress } from "./relay.js";
import { receivePayloadOverSocket, sendPayloadOverSocket } from "./psk.js";
import { MAX_RECEIVERS } from "./payload.js";
import type { TransferPayload } from "./payload.js";

// Transport that carries an end-to-end TLS-PSK session through a blind relay.
// Both peers dial *out* to the relay, so neither needs to be reachable. The relay
// only pipes ciphertext (see relay.ts); confidentiality and peer authentication
// come from the PSK carried in the code, exactly as in the direct transport.

const CODE_PREFIX = "efr1_";
// Default deadline for serving a multi-receiver code. Deliberately longer than a
// single transfer's window: the whole point is leaving the send open while
// several people redeem the code.
const DEFAULT_MULTI_TIMEOUT_MS = 900_000; // 15 minutes

type RelayInput = string | { host: string; port: number };

export interface OfferRelayOptions {
  /** Relay address the sender dials. */
  relay: RelayInput;
  /** Address to embed in the code for the receiver, if it differs (e.g. the
   *  sender is co-located with the relay and dials 127.0.0.1). Defaults to relay. */
  advertiseRelay?: RelayInput;
  /** How many receivers may redeem this code (default 1). More than one relaxes
   *  the relay's single-use id rule for this session and needs a relay running
   *  envferry >= 0.2.0. */
  receivers?: number;
  /** Client-side deadline. Single-receiver sends default to no client deadline
   *  (the relay drops an unpaired peer at its own pair timeout); multi-receiver
   *  sends default to 15 minutes for the whole session. */
  timeoutMs?: number;
  onCode?: (code: string) => void;
  /** Called after each receiver has been served (multi-receiver progress). */
  onDelivery?: (delivered: number, total: number) => void;
}

export function isRelayCode(code: string): boolean {
  return typeof code === "string" && code.startsWith(CODE_PREFIX);
}

export async function offerViaRelay(payload: TransferPayload, options: OfferRelayOptions): Promise<void> {
  const relay = parseRelayAddress(options.relay);
  if (!relay) {
    throw new Error("Relay transport requires a relay address (pass --relay host:port).");
  }
  const advertised = options.advertiseRelay ? parseRelayAddress(options.advertiseRelay) : relay;
  if (!advertised) {
    throw new Error("Relay transport requires a valid advertise address.");
  }
  const total = options.receivers ?? 1;
  if (!Number.isInteger(total) || total < 1 || total > MAX_RECEIVERS) {
    throw new Error(`receivers must be an integer between 1 and ${MAX_RECEIVERS}.`);
  }

  const psk = randomBytes(16);
  const id = randomBytes(16).toString("hex");
  const code = encodeCode({ relayHost: advertised.host, relayPort: advertised.port, id, psk });

  let announced = false;
  const announce = (): void => {
    if (!announced) {
      announced = true;
      options.onCode?.(code);
    }
  };

  if (total === 1) {
    return offerOnce(relay, id, false, announce, psk, payload, options);
  }

  // Multi-receiver: serve the same payload repeatedly over fresh relay sessions.
  // The relay may drop us while we wait (its pair timeout) — that is routine, so
  // reconnect and keep waiting until the overall deadline. A receiver holding a
  // wrong key fails the end-to-end handshake without burning the session.
  const timeoutMs = options.timeoutMs ?? DEFAULT_MULTI_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let delivered = 0;
  let rapidFailures = 0;

  while (delivered < total) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        delivered > 0
          ? `Timed out after serving ${delivered} of ${total} receivers.`
          : "Timed out waiting for a receiver."
      );
    }
    const attemptStart = Date.now();
    try {
      await offerOnce(relay, id, true, announce, psk, payload, options, remaining);
      delivered += 1;
      rapidFailures = 0;
      options.onDelivery?.(delivered, total);
    } catch (error) {
      if (error instanceof OfferTimeout) {
        continue; // loop re-checks the deadline and reports the count
      }
      // An instantly-refused session, repeatedly, means the relay is rejecting
      // the `<id> m` header — almost certainly a relay that predates multi-use
      // ids. Fail with a pointer instead of spinning until the deadline.
      if (Date.now() - attemptStart < 1_000) {
        rapidFailures += 1;
        if (rapidFailures >= 3) {
          throw new Error(
            "The relay closed the session repeatedly. Multi-receiver codes (--receivers > 1) " +
              "need a relay running envferry >= 0.2.0; ask the operator to update, or send once per receiver."
          );
        }
        await sleep(250 * rapidFailures);
      } else {
        rapidFailures = 0;
      }
    }
  }
}

/** Marker for a client-side deadline hit while waiting, to distinguish it from peer errors. */
class OfferTimeout extends Error {}

function offerOnce(
  relay: RelayAddress,
  id: string,
  multi: boolean,
  announce: () => void,
  psk: Buffer,
  payload: TransferPayload,
  options: OfferRelayOptions,
  timeoutMs?: number
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect(relay.port, relay.host, () => {
      socket.write(id + (multi ? " m" : "") + "\n");
      announce();
      sendPayloadOverSocket(socket, psk, payload).then(
        () => {
          cleanup();
          resolvePromise();
        },
        (error: Error) => {
          cleanup();
          reject(error);
        }
      );
    });
    socket.on("error", (error) => {
      cleanup();
      reject(error);
    });

    // Optional client-side deadline (single-receiver sends keep the historical
    // behavior of relying on the relay's own pair timeout unless one is given).
    const effectiveTimeout = timeoutMs ?? options.timeoutMs;
    let timer: NodeJS.Timeout | undefined;
    if (effectiveTimeout !== undefined) {
      timer = setTimeout(() => {
        socket.destroy();
        reject(new OfferTimeout("Timed out waiting for a receiver."));
      }, effectiveTimeout);
      timer.unref?.();
    }
    function cleanup(): void {
      if (timer) {
        clearTimeout(timer);
      }
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export async function acceptViaRelay(code: string): Promise<TransferPayload> {
  const { relayHost, relayPort, id, psk } = decodeCode(code);

  return new Promise((resolvePromise, reject) => {
    const socket = connect(relayPort, relayHost, () => {
      socket.write(id + "\n");
      receivePayloadOverSocket(socket, psk).then(resolvePromise, reject);
    });
    socket.on("error", reject);
  });
}

interface RelayCode extends RelayAddressCode {
  id: string;
  psk: Buffer;
}

interface RelayAddressCode {
  relayHost: string;
  relayPort: number;
}

function encodeCode({ relayHost, relayPort, id, psk }: RelayCode): string {
  const json = JSON.stringify({
    v: 1,
    rh: relayHost,
    rp: relayPort,
    id,
    k: psk.toString("hex"),
  });
  return CODE_PREFIX + Buffer.from(json, "utf8").toString("base64url");
}

function decodeCode(code: string): RelayCode {
  if (!isRelayCode(code)) {
    throw new Error("Unsupported transfer code.");
  }

  let parsed: unknown;
  try {
    const json = Buffer.from(code.slice(CODE_PREFIX.length), "base64url").toString("utf8");
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Malformed relay transfer code.");
  }

  const record = parsed as {
    v?: unknown;
    rh?: unknown;
    rp?: unknown;
    id?: unknown;
    k?: unknown;
  };
  if (
    record.v !== 1 ||
    typeof record.rh !== "string" ||
    typeof record.rp !== "number" ||
    !Number.isInteger(record.rp) ||
    typeof record.id !== "string" ||
    !/^[a-f0-9]{8,64}$/.test(record.id) ||
    typeof record.k !== "string" ||
    !/^[a-f0-9]{32}$/.test(record.k)
  ) {
    throw new Error("Malformed relay transfer code.");
  }

  return {
    relayHost: record.rh,
    relayPort: record.rp,
    id: record.id,
    psk: Buffer.from(record.k, "hex"),
  };
}
