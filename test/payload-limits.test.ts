import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validatePayload } from "../src/index.js";
import {
  MAX_FILES,
  MAX_FILE_NAME_BYTES,
  MAX_PAYLOAD_BYTES,
} from "../src/transport/payload.js";

describe("payload limits", () => {
  it("accepts a typical .env payload", () => {
    validatePayload({ files: [{ name: ".env", contents: "API_KEY=x\n" }] });
  });

  it("rejects too many files", () => {
    const files = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({
      name: `.env.${i}`,
      contents: "A=1\n",
    }));
    assert.throws(() => validatePayload({ files }), /Too many files/);
  });

  it("rejects an oversized file name", () => {
    const files = [{ name: ".env." + "x".repeat(MAX_FILE_NAME_BYTES), contents: "A=1\n" }];
    assert.throws(() => validatePayload({ files }), /File name too long/);
  });

  it("rejects oversized total contents", () => {
    const files = [{ name: ".env", contents: "x".repeat(MAX_PAYLOAD_BYTES + 1) }];
    assert.throws(() => validatePayload({ files }), /payload too large/);
  });

  it("rejects non-payload shapes", () => {
    assert.throws(() => validatePayload(null), /Invalid transfer payload/);
    assert.throws(() => validatePayload({}), /Invalid transfer payload/);
    assert.throws(
      () => validatePayload({ files: [{ name: 42, contents: "x" }] }),
      /Invalid transfer file payload/
    );
  });
});
