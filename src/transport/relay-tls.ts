import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { parseRelayAddress } from "./relay.js";
import type { RelayAddress } from "./relay.js";
import { receivePayloadOverSocket, sendPayloadOverSocket } from "./psk.js";
import type { TransferPayload } from "./payload.js";

// Transport that carries an end-to-end TLS-PSK session through a blind relay.
// Both peers dial *out* to the relay, so neither needs to be reachable. The relay
// only pipes ciphertext (see relay.ts); confidentiality and peer authentication
// come from the PSK carried in the code, exactly as in the direct transport.

const CODE_PREFIX = "efr1_";

type RelayInput = string | { host: string; port: number };

export interface OfferRelayOptions {
  /** Relay address the sender dials. */
  relay: RelayInput;
  /** Address to embed in the code for the receiver, if it differs (e.g. the
   *  sender is co-located with the relay and dials 127.0.0.1). Defaults to relay. */
  advertiseRelay?: RelayInput;
  onCode?: (code: string) => void;
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

  const psk = randomBytes(16);
  const id = randomBytes(16).toString("hex");

  return new Promise((resolvePromise, reject) => {
    const socket = connect(relay.port, relay.host, () => {
      socket.write(id + "\n");
      options.onCode?.(
        encodeCode({ relayHost: advertised.host, relayPort: advertised.port, id, psk })
      );
      sendPayloadOverSocket(socket, psk, payload).then(resolvePromise, reject);
    });
    socket.on("error", reject);
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
