import type { TransferPayload } from "./payload.js";

// The narrow boundary the app core talks to. Every transport — the loopback
// spike, the direct TLS-PSK transport, and the relay — implements `offer` and
// `accept`, so the CLI and tests can swap in a fake in-memory transport without
// touching any real sockets. `offer`'s return type is transport-specific (some
// hand back a code object, some emit the code via a callback), so it is a
// generic parameter.

export interface Transport<Offer = unknown> {
  offer(payload: TransferPayload, options?: Record<string, unknown>): Promise<Offer>;
  accept(code: string, options?: Record<string, unknown>): Promise<TransferPayload>;
}

export async function sendPayload<Offer>(
  transport: Transport<Offer>,
  payload: TransferPayload,
  options: Record<string, unknown> = {}
): Promise<Offer> {
  if (typeof transport?.offer !== "function") {
    throw new TypeError("Transport must provide offer(payload, options).");
  }

  return transport.offer(payload, options);
}

export async function receivePayload(
  transport: Transport,
  code: string,
  options: Record<string, unknown> = {}
): Promise<TransferPayload> {
  if (typeof transport?.accept !== "function") {
    throw new TypeError("Transport must provide accept(code, options).");
  }

  return transport.accept(code, options);
}
