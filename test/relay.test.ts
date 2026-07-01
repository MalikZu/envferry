import assert from "node:assert/strict";
import { connect, createServer } from "node:net";
import type { Socket } from "node:net";
import { once } from "node:events";
import { describe, it } from "node:test";
import {
  acceptViaRelay,
  isRelayAddress,
  isRelayCode,
  offerViaRelay,
  parseRelayAddress,
  startRelay,
} from "../src/index.js";
import type { TransferPayload } from "../src/index.js";

describe("blind relay transport", () => {
  it("round-trips a payload through the relay", async (t) => {
    if (!(await canOpenLocalListener())) {
      t.skip("local listeners are blocked in this sandbox");
      return;
    }

    const relay = await startRelay({ host: "127.0.0.1", port: 0 });
    try {
      const payload: TransferPayload = {
        files: [{ name: ".env", contents: "API_KEY=super-secret\n" }],
      };
      const { done, code } = await startOffer(payload, relay.port);

      assert.ok(isRelayCode(code), "code should use the efr1_ relay prefix");
      assert.doesNotMatch(code, /super-secret/, "code must not carry the secret payload");

      const received = await acceptViaRelay(code);
      assert.deepEqual(received, payload);
      await done;
    } finally {
      await relay.close();
    }
  });

  it("forwards bytes opaquely without interpreting them", async (t) => {
    if (!(await canOpenLocalListener())) {
      t.skip("local listeners are blocked in this sandbox");
      return;
    }

    const relay = await startRelay({ host: "127.0.0.1", port: 0 });
    try {
      const id = "a1b2c3d4e5f60718".repeat(2); // 32 hex chars
      const opaque = Buffer.from([0, 1, 2, 3, 250, 251, 10, 13, 42, 255]);

      const a = connect(relay.port, "127.0.0.1");
      const b = connect(relay.port, "127.0.0.1");
      await Promise.all([once(a, "connect"), once(b, "connect")]);

      // Whichever side arrives first waits; the relay buffers post-id bytes and
      // flushes them on pairing, so sending everything at once is race-free.
      a.write(Buffer.concat([Buffer.from(id + "\n"), opaque]));
      b.write(Buffer.from(id + "\n"));

      const seen = await readExactly(b, opaque.length);
      assert.deepEqual(seen, opaque, "relay must forward raw bytes unchanged");
      a.destroy();
      b.destroy();
    } finally {
      await relay.close();
    }
  });

  it("rejects a wrong code and fails the offer", async (t) => {
    if (!(await canOpenLocalListener())) {
      t.skip("local listeners are blocked in this sandbox");
      return;
    }

    const relay = await startRelay({ host: "127.0.0.1", port: 0 });
    try {
      const payload: TransferPayload = {
        files: [{ name: ".env", contents: "API_KEY=super-secret\n" }],
      };
      const { done, code } = await startOffer(payload, relay.port);

      // A wrong key still pairs at the relay, but the end-to-end TLS handshake
      // fails, so neither side learns anything. Attach both rejection handlers
      // synchronously — the two failures fire nearly simultaneously.
      await Promise.all([
        assert.rejects(() => acceptViaRelay(mutateKey(code))),
        assert.rejects(() => done),
      ]);
    } finally {
      await relay.close();
    }
  });

  it("does not pair a rendezvous id twice (single-use)", async (t) => {
    if (!(await canOpenLocalListener())) {
      t.skip("local listeners are blocked in this sandbox");
      return;
    }

    const relay = await startRelay({ host: "127.0.0.1", port: 0 });
    try {
      const id = "deadbeefdeadbeef";
      const a = connect(relay.port, "127.0.0.1");
      const b = connect(relay.port, "127.0.0.1");
      await Promise.all([once(a, "connect"), once(b, "connect")]);

      // Pair a+b and confirm the pipe is live (b receives a's post-id byte).
      a.write(Buffer.concat([Buffer.from(id + "\n"), Buffer.from("X")]));
      b.write(Buffer.from(id + "\n"));
      assert.deepEqual(await readExactly(b, 1), Buffer.from("X"));

      // The id is now consumed: a third peer announcing it must be dropped.
      const c = connect(relay.port, "127.0.0.1");
      await once(c, "connect");
      c.write(Buffer.from(id + "\n"));
      await Promise.race([
        once(c, "close"),
        rejectAfter(3000, "relay did not drop a reused rendezvous id"),
      ]);

      a.destroy();
      b.destroy();
    } finally {
      await relay.close();
    }
  });

  it("tears down a paired session that exceeds the byte cap", async (t) => {
    if (!(await canOpenLocalListener())) {
      t.skip("local listeners are blocked in this sandbox");
      return;
    }

    const relay = await startRelay({ host: "127.0.0.1", port: 0, maxSessionBytes: 64 });
    try {
      const id = "cafebabecafebabe";
      const a = connect(relay.port, "127.0.0.1");
      const b = connect(relay.port, "127.0.0.1");
      await Promise.all([once(a, "connect"), once(b, "connect")]);

      a.write(Buffer.from(id + "\n"));
      b.write(Buffer.from(id + "\n"));

      // Pump well past the 64-byte session cap; the relay must cut the pipe
      // instead of forwarding indefinitely.
      const closed = Promise.race([
        Promise.all([once(a, "close"), once(b, "close")]),
        rejectAfter(5000, "relay did not enforce the session byte cap"),
      ]);
      const noise = Buffer.alloc(1024, 7);
      const pump = setInterval(() => {
        if (!a.destroyed) {
          a.write(noise);
        }
      }, 20);
      try {
        await closed;
      } finally {
        clearInterval(pump);
      }
      a.destroy();
      b.destroy();
    } finally {
      await relay.close();
    }
  });

  it("parses relay addresses, including bracketed IPv6, and rejects ambiguous ones", () => {
    assert.deepEqual(parseRelayAddress("relay.example:8787"), { host: "relay.example", port: 8787 });
    assert.deepEqual(parseRelayAddress("203.0.113.10:9000"), { host: "203.0.113.10", port: 9000 });
    assert.deepEqual(parseRelayAddress("[2001:db8::1]:443"), { host: "2001:db8::1", port: 443 });
    assert.deepEqual(parseRelayAddress({ host: "h", port: 1 }), { host: "h", port: 1 });

    // Bare IPv6 is ambiguous (host vs port) — reject rather than silently mangle.
    assert.equal(parseRelayAddress("2001:db8::1"), null);
    assert.equal(parseRelayAddress("2001:db8::1:9000"), null);
    assert.equal(parseRelayAddress("hostonly"), null);
    assert.equal(parseRelayAddress("host:0"), null);
    assert.equal(parseRelayAddress("host:70000"), null);

    assert.equal(isRelayAddress("[::1]:1"), true);
    assert.equal(isRelayAddress("2001:db8::1"), false);
  });

  it("requires a relay address to offer", async () => {
    await assert.rejects(() => offerViaRelay({ files: [] }, { relay: "" }), /relay address/);
    await assert.rejects(
      () => offerViaRelay({ files: [] }, { relay: "2001:db8::1" }),
      /relay address/
    );
  });

  it("rejects malformed relay codes on receive", async () => {
    await assert.rejects(
      () => acceptViaRelay("efr1_not-valid-base64url"),
      /Malformed relay transfer code/
    );
    await assert.rejects(() => acceptViaRelay("ef1_something"), /Unsupported transfer code/);
  });
});

async function startOffer(
  payload: TransferPayload,
  relayPort: number
): Promise<{ done: Promise<void>; code: string }> {
  let resolveCode!: (code: string) => void;
  const codePromise = new Promise<string>((resolve) => {
    resolveCode = resolve;
  });

  const done = offerViaRelay(payload, {
    relay: `127.0.0.1:${relayPort}`,
    onCode: resolveCode,
  });

  return { done, code: await codePromise };
}

function mutateKey(code: string): string {
  const json = JSON.parse(Buffer.from(code.slice(5), "base64url").toString("utf8")) as { k: string };
  json.k = json.k === "0".repeat(32) ? "1".repeat(32) : "0".repeat(32);
  return "efr1_" + Buffer.from(JSON.stringify(json), "utf8").toString("base64url");
}

function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
}

function readExactly(socket: Socket, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= length) {
        socket.off("data", onData);
        resolve(buf.subarray(0, length));
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

function canOpenLocalListener(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(0, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}
