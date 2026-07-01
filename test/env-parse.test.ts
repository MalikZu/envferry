import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEnv, serializeEnv } from "../src/index.js";

describe("env parsing", () => {
  it("parses comments, export bindings, quoted values, and inline comments", () => {
    const parsed = parseEnv(`# local settings
export API_URL="https://example.com"
TOKEN='abc#123'
DEBUG=true # safe comment
`);

    assert.equal(parsed.bindings.get("API_URL")?.value, "https://example.com");
    assert.equal(parsed.bindings.get("TOKEN")?.value, "abc#123");
    assert.equal(parsed.bindings.get("DEBUG")?.value, "true");
  });

  it("quotes values only when serialization needs it", () => {
    const parsed = parseEnv("PLAIN=ok\nSPACED=old\n");
    const spaced = parsed.entries[1];
    assert.equal(spaced?.type, "binding");
    if (spaced?.type === "binding") {
      spaced.value = "needs spaces # and comment safety";
      spaced.dirty = true;
    }

    assert.equal(
      serializeEnv(parsed.entries),
      'PLAIN=ok\nSPACED="needs spaces # and comment safety"\n'
    );
  });
});
