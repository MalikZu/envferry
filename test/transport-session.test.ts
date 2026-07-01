import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { receivePayload, sendPayload } from "../src/index.js";
import type { Transport, TransferPayload } from "../src/index.js";

describe("transport session boundary", () => {
  it("round-trips a payload through a transport adapter", async () => {
    const transport = createMemoryTransport();
    const payload: TransferPayload = {
      files: [{ name: ".env", contents: "API_KEY=secret\n" }],
    };

    const { code } = await sendPayload(transport, payload);
    const received = await receivePayload(transport, code);

    assert.deepEqual(received, payload);
  });

  it("requires transfer codes to be single-use at the boundary", async () => {
    const transport = createMemoryTransport();
    const { code } = await sendPayload(transport, { files: [] });

    await receivePayload(transport, code);
    await assert.rejects(
      () => receivePayload(transport, code),
      /Unknown or already-used code/
    );
  });
});

function createMemoryTransport(): Transport<{ code: string }> {
  const payloads = new Map<string, TransferPayload>();
  let nextCode = 1;

  return {
    async offer(payload) {
      const code = `test-${nextCode}`;
      nextCode += 1;
      payloads.set(code, structuredClone(payload));
      return { code };
    },

    async accept(code) {
      const payload = payloads.get(code);
      if (!payload) {
        throw new Error("Unknown or already-used code.");
      }

      payloads.delete(code);
      return payload;
    },
  };
}
