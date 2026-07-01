import { createConnection, createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { validatePayload } from "./payload.js";
import type { TransferPayload } from "./payload.js";

// A same-machine transport spike. It binds a loopback listener, prints a code
// carrying the port + a one-time token, and hands the payload to the first
// receiver that presents the token. It proves the send/get lifecycle end to end
// but is NOT encrypted and NOT cross-device — the direct and relay transports
// exist for that. Codes look like `local-<port>-<token>`.

const HOST = "127.0.0.1";
const CODE_PATTERN = /^local-(?<port>\d+)-(?<token>[a-f0-9]{32})$/;

export interface OfferLocalOptions {
  onCode?: (code: string) => void;
}

/** True for codes this transport produces. */
export function isLocalCode(code: string): boolean {
  return CODE_PATTERN.test(code);
}

export function offerLocalTcp(payload: TransferPayload, options: OfferLocalOptions = {}): Promise<void> {
  const token = randomBytes(16).toString("hex");

  return new Promise((resolvePromise, reject) => {
    let settled = false;

    const server = createServer((socket) => {
      let request = "";

      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        request += chunk;
        if (!request.includes("\n")) {
          return;
        }

        const attemptedToken = request.slice(0, request.indexOf("\n"));
        if (attemptedToken !== token) {
          socket.end(JSON.stringify({ error: "Invalid or already-used code." }) + "\n");
          closeWithError(new Error("Receiver used an invalid code."));
          return;
        }

        socket.end(JSON.stringify({ payload }) + "\n");
        closeSuccessfully();
      });
      socket.on("error", closeWithError);
    });

    server.on("error", closeWithError);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        closeWithError(new Error("Could not bind local transfer server."));
        return;
      }

      options.onCode?.(`local-${address.port}-${token}`);
    });

    function closeSuccessfully(): void {
      if (settled) {
        return;
      }
      settled = true;
      server.close(() => resolvePromise());
    }

    function closeWithError(error: Error): void {
      if (settled) {
        return;
      }
      settled = true;
      server.close(() => reject(error));
    }
  });
}

export function acceptLocalTcp(code: string): Promise<TransferPayload> {
  const { port, token } = parseLocalCode(code);

  return new Promise((resolvePromise, reject) => {
    let response = "";
    const socket = createConnection({ host: HOST, port }, () => {
      socket.write(`${token}\n`);
    });

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        const message = JSON.parse(response) as { error?: string; payload?: unknown };
        if (message.error) {
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

function parseLocalCode(code: string): { port: number; token: string } {
  const groups = CODE_PATTERN.exec(code)?.groups;
  const port = groups?.["port"];
  const token = groups?.["token"];
  if (port === undefined || token === undefined) {
    throw new Error("Unsupported transfer code.");
  }

  return { port: Number(port), token };
}
