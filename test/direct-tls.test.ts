import assert from "node:assert/strict";
import { createServer } from "node:net";
import { describe, it } from "node:test";
import { acceptDirectTls, isDirectCode, offerDirectTls } from "../src/index.js";
import type { TransferPayload } from "../src/index.js";

describe("direct TLS-PSK transport", () => {
  it("round-trips a payload over an encrypted channel", async (t) => {
    if (!(await canOpenLocalListener())) {
      t.skip("local listeners are blocked in this sandbox");
      return;
    }

    const payload: TransferPayload = { files: [{ name: ".env", contents: "API_KEY=super-secret\n" }] };
    const { done, code } = await startOffer(payload);

    assert.ok(isDirectCode(code), "code should use the ef1_ direct prefix");
    assert.doesNotMatch(code, /super-secret/, "code must not carry the secret payload");

    const received = await acceptDirectTls(code);
    assert.deepEqual(received, payload);
    await done;
  });

  it("rejects a wrong code without burning the pending transfer", async (t) => {
    if (!(await canOpenLocalListener())) {
      t.skip("local listeners are blocked in this sandbox");
      return;
    }

    const payload: TransferPayload = { files: [{ name: ".env", contents: "API_KEY=super-secret\n" }] };
    const { done, code } = await startOffer(payload);

    await assert.rejects(() => acceptDirectTls(mutateKey(code)));

    // A cryptographically-rejected attempt leaks nothing and must not cancel the
    // transfer — the real receiver still completes it.
    const received = await acceptDirectTls(code);
    assert.deepEqual(received, payload);
    await done;
  });

  it("is single-use once a receiver completes the transfer", async (t) => {
    if (!(await canOpenLocalListener())) {
      t.skip("local listeners are blocked in this sandbox");
      return;
    }

    const payload: TransferPayload = { files: [{ name: ".env", contents: "API_KEY=super-secret\n" }] };
    const { done, code } = await startOffer(payload);

    await acceptDirectTls(code);
    await done;

    await assert.rejects(() => acceptDirectTls(code));
  });

  it("requires a reachable host to offer a direct transfer", async () => {
    await assert.rejects(
      () => offerDirectTls({ files: [] }, { advertiseHost: "" }),
      /reachable host/
    );
  });

  it("rejects malformed direct codes on receive", async () => {
    await assert.rejects(() => acceptDirectTls("ef1_not-valid-base64url"), /Malformed direct transfer code/);
    await assert.rejects(() => acceptDirectTls("local-1234-deadbeef"), /Unsupported transfer code/);
  });
});

async function startOffer(payload: TransferPayload): Promise<{ done: Promise<void>; code: string }> {
  let resolveCode!: (code: string) => void;
  const codePromise = new Promise<string>((resolve) => {
    resolveCode = resolve;
  });

  const done = offerDirectTls(payload, {
    advertiseHost: "127.0.0.1",
    bindHost: "127.0.0.1",
    onCode: resolveCode,
  });

  return { done, code: await codePromise };
}

function mutateKey(code: string): string {
  const json = JSON.parse(Buffer.from(code.slice(4), "base64url").toString("utf8")) as { k: string };
  json.k = json.k === "0".repeat(32) ? "1".repeat(32) : "0".repeat(32);
  return "ef1_" + Buffer.from(JSON.stringify(json), "utf8").toString("base64url");
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
