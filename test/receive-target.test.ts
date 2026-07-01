import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isEnvFileName,
  normalizeReceivedFileName,
  resolveReceiveTarget,
} from "../src/index.js";

describe("receive target planning", () => {
  it("accepts .env and .env.* filenames", () => {
    assert.equal(isEnvFileName(".env"), true);
    assert.equal(isEnvFileName(".env.production"), true);
    assert.equal(isEnvFileName("env.production"), false);
  });

  it("drops sender-side directories before resolving the receive target", () => {
    assert.equal(normalizeReceivedFileName("../secrets/.env.production"), ".env.production");
    assert.equal(normalizeReceivedFileName("C:\\work\\.env.local"), ".env.local");
    assert.equal(
      resolveReceiveTarget({
        directory: "/tmp/project",
        receivedName: "../../work/.env.local",
      }),
      "/tmp/project/.env.local"
    );
  });

  it("rejects non-env filenames by default", () => {
    assert.throws(
      () => normalizeReceivedFileName("id_rsa"),
      /Refusing to receive non-env file/
    );
  });
});
