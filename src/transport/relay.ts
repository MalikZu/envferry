import { createServer } from "node:net";
import type { Socket } from "node:net";

// A blind rendezvous relay for peers that cannot reach each other directly (both
// behind NAT). It is a dumb byte pump: each peer connects out, announces a
// rendezvous id on the first line, and the relay pipes the two matching sockets
// together. The TLS-PSK session runs end-to-end *through* this pipe, so the relay
// only ever forwards ciphertext — it holds no key and can decrypt nothing.
//
// A public relay is an unauthenticated network service, so it defends its own
// availability: a global connection cap, a per-IP cap, a short header deadline
// (slowloris), a bounded waiting set, and single-use rendezvous ids. It cannot
// authenticate the code (that is the point — it stays blind), so operators of a
// public relay should still firewall/rate-limit it upstream.

const ID_PATTERN = /^[a-f0-9]{8,64}$/;
const MAX_HEADER_BYTES = 256;
const DEFAULT_MAX_WAITING = 1024;
const DEFAULT_MAX_CONNECTIONS = 512;
const DEFAULT_MAX_PER_IP = 32;
const DEFAULT_HEADER_TIMEOUT_MS = 30_000;
const DEFAULT_PAIR_TIMEOUT_MS = 300_000;
const DEFAULT_CONSUMED_TTL_MS = 600_000;
const MAX_CONSUMED = 4096;
const KEEPALIVE_MS = 30_000;
// A transfer is a few MiB of TLS records at most (the payload itself is capped
// at 1 MiB), so these bound what a paired session may pump through the relay —
// otherwise a public relay is an unlimited free byte pipe.
const DEFAULT_MAX_SESSION_BYTES = 16 * 1_048_576;
const DEFAULT_MAX_SESSION_MS = 900_000; // 15 minutes

export interface StartRelayOptions {
  host?: string;
  port?: number;
  /** How long a peer may wait for its partner before being dropped. */
  pairTimeoutMs?: number;
  /** How long a peer has to send its rendezvous id line (slowloris defense). */
  headerTimeoutMs?: number;
  /** How long a used rendezvous id stays remembered as consumed. */
  consumedTtlMs?: number;
  maxWaiting?: number;
  maxPerIp?: number;
  maxConnections?: number;
  /** Total bytes a paired session may forward (both directions combined). */
  maxSessionBytes?: number;
  /** Wall-clock lifetime of a paired session. */
  maxSessionMs?: number;
}

export interface RelayHandle {
  host: string;
  port: number;
  close(): Promise<void>;
}

interface WaitingPeer {
  socket: Socket;
  /** Bytes received after the id line, to flush to the partner once paired. */
  rest: Buffer;
  pairTimer: NodeJS.Timeout;
}

export function startRelay(options: StartRelayOptions = {}): Promise<RelayHandle> {
  const host = options.host ?? "0.0.0.0";
  const requestedPort = options.port ?? 0;
  const pairTimeoutMs = options.pairTimeoutMs ?? DEFAULT_PAIR_TIMEOUT_MS;
  const headerTimeoutMs = options.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS;
  const consumedTtlMs = options.consumedTtlMs ?? DEFAULT_CONSUMED_TTL_MS;
  const maxWaiting = options.maxWaiting ?? DEFAULT_MAX_WAITING;
  const maxPerIp = options.maxPerIp ?? DEFAULT_MAX_PER_IP;
  const maxSessionBytes = options.maxSessionBytes ?? DEFAULT_MAX_SESSION_BYTES;
  const maxSessionMs = options.maxSessionMs ?? DEFAULT_MAX_SESSION_MS;

  const waiting = new Map<string, WaitingPeer>();
  const sockets = new Set<Socket>();
  const perIp = new Map<string, number>();
  const consumed = new Map<string, number>();

  const markConsumed = (id: string): void => {
    const now = Date.now();
    consumed.set(id, now + consumedTtlMs);
    if (consumed.size > MAX_CONSUMED) {
      for (const [key, expiry] of consumed) {
        if (expiry <= now) {
          consumed.delete(key);
        }
      }
      while (consumed.size > MAX_CONSUMED) {
        const oldest = consumed.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        consumed.delete(oldest);
      }
    }
  };

  const isConsumed = (id: string): boolean => {
    const expiry = consumed.get(id);
    if (expiry === undefined) {
      return false;
    }
    if (expiry <= Date.now()) {
      consumed.delete(id);
      return false;
    }
    return true;
  };

  const server = createServer((socket) => {
    socket.on("error", () => {});

    const ip = socket.remoteAddress ?? "unknown";
    const ipCount = perIp.get(ip) ?? 0;
    if (ipCount >= maxPerIp) {
      socket.destroy();
      return;
    }
    perIp.set(ip, ipCount + 1);
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      const remaining = (perIp.get(ip) ?? 1) - 1;
      if (remaining <= 0) {
        perIp.delete(ip);
      } else {
        perIp.set(ip, remaining);
      }
    });

    socket.pause();

    let header = Buffer.alloc(0);
    let routed = false;

    // Short deadline for a peer to announce its id, so a client that connects and
    // never sends a newline cannot hold a socket for minutes.
    const giveUp = setTimeout(() => {
      if (!routed) {
        socket.destroy();
      }
    }, headerTimeoutMs);
    giveUp.unref?.();

    const onData = (chunk: Buffer): void => {
      header = Buffer.concat([header, chunk]);
      const newline = header.indexOf(0x0a);

      if (newline === -1) {
        if (header.length > MAX_HEADER_BYTES) {
          socket.destroy();
        }
        return;
      }

      socket.off("data", onData);
      routed = true;
      clearTimeout(giveUp);

      const id = header.subarray(0, newline).toString("utf8").trim();
      const rest = header.subarray(newline + 1);

      if (!ID_PATTERN.test(id) || isConsumed(id)) {
        socket.destroy();
        return;
      }

      const partner = waiting.get(id);
      if (partner) {
        waiting.delete(id);
        clearTimeout(partner.pairTimer);
        // A rendezvous id is single-use: once paired it cannot be paired again,
        // even if the end-to-end handshake later fails.
        markConsumed(id);
        pair(partner.socket, partner.rest, socket, rest, {
          maxSessionBytes,
          maxSessionMs,
        });
        return;
      }

      if (waiting.size >= maxWaiting) {
        socket.destroy();
        return;
      }

      const pairTimer = setTimeout(() => {
        if (waiting.get(id)?.socket === socket) {
          waiting.delete(id);
        }
        socket.destroy();
      }, pairTimeoutMs);
      pairTimer.unref?.();
      socket.once("close", () => {
        if (waiting.get(id)?.socket === socket) {
          waiting.delete(id);
        }
      });
      waiting.set(id, { socket, rest, pairTimer });
    };

    socket.on("data", onData);
    socket.resume();
  });

  server.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      server.off("error", reject);
      const address = server.address();
      const port = address !== null && typeof address === "object" ? address.port : requestedPort;
      resolve({
        host,
        port,
        close() {
          return new Promise<void>((done) => {
            waiting.clear();
            consumed.clear();
            perIp.clear();
            for (const socket of sockets) {
              socket.destroy();
            }
            sockets.clear();
            server.close(() => done());
          });
        },
      });
    });
  });
}

interface SessionLimits {
  maxSessionBytes: number;
  maxSessionMs: number;
}

function pair(
  first: Socket,
  firstRest: Buffer,
  second: Socket,
  secondRest: Buffer,
  limits: SessionLimits
): void {
  // Once paired, the relay never inspects payload again — it only forwards. TCP
  // keepalive detects a peer that dies without a clean FIN; a slow-but-alive
  // transfer is never killed by an inactivity timer, since keepalive resets on
  // real traffic and only probes when the link is genuinely idle.
  for (const socket of [first, second]) {
    socket.setKeepAlive(true, KEEPALIVE_MS);
  }

  // Bound the session so a paired pipe cannot be used as an unlimited byte
  // tunnel: cap total forwarded bytes (both directions) and wall-clock time.
  // The relay counts lengths only — it still never interprets the bytes.
  let forwarded = firstRest.length + secondRest.length;
  const teardown = (): void => {
    first.destroy();
    second.destroy();
  };
  const countBytes = (chunk: Buffer): void => {
    forwarded += chunk.length;
    if (forwarded > limits.maxSessionBytes) {
      teardown();
    }
  };
  first.on("data", countBytes);
  second.on("data", countBytes);

  const sessionTimer = setTimeout(teardown, limits.maxSessionMs);
  sessionTimer.unref?.();

  for (const [from, to] of [
    [first, second],
    [second, first],
  ] as const) {
    from.on("error", () => to.destroy());
    from.once("close", () => {
      clearTimeout(sessionTimer);
      to.end();
    });
  }

  if (firstRest.length) {
    second.write(firstRest);
  }
  if (secondRest.length) {
    first.write(secondRest);
  }

  first.pipe(second);
  second.pipe(first);
  first.resume();
  second.resume();
}

export interface RelayAddress {
  host: string;
  port: number;
}

export function isRelayAddress(value: unknown): boolean {
  return parseRelayAddress(value) !== null;
}

export function parseRelayAddress(value: unknown): RelayAddress | null {
  if (value !== null && typeof value === "object") {
    const record = value as { host?: unknown; port?: unknown };
    return validated(String(record.host), Number(record.port));
  }

  const text = String(value).trim();

  // Bracketed IPv6, e.g. [2001:db8::1]:8787
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end === -1 || text[end + 1] !== ":") {
      return null;
    }
    return validated(text.slice(1, end), Number(text.slice(end + 2)));
  }

  // A bare IPv6 literal (more than one colon, no brackets) is ambiguous — the
  // port can't be told apart from the address. Fail closed and require brackets.
  if ((text.match(/:/g) ?? []).length > 1) {
    return null;
  }

  const lastColon = text.lastIndexOf(":");
  if (lastColon === -1) {
    return null;
  }

  return validated(text.slice(0, lastColon), Number(text.slice(lastColon + 1)));
}

function validated(host: string, port: number): RelayAddress | null {
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65_535) {
    return null;
  }
  return { host, port };
}
