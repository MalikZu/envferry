import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeEnv } from "../src/index.js";

describe("env merge", () => {
  it("updates existing keys, appends new keys, and preserves comments", () => {
    const result = mergeEnv(
      `# keep this
API_URL=https://old.example
LOCAL_ONLY=true
`,
      `API_URL=https://new.example
NEW_SECRET=super-secret
`
    );

    assert.equal(
      result.text,
      `# keep this
API_URL=https://new.example
LOCAL_ONLY=true
NEW_SECRET=super-secret
`
    );
    assert.deepEqual(
      result.changes.map(({ action, key }) => ({ action, key })),
      [
        { action: "update", key: "API_URL" },
        { action: "add", key: "NEW_SECRET" },
      ]
    );
  });

  it("masks values in merge changes", () => {
    const result = mergeEnv("API_KEY=old-secret\n", "API_KEY=new-secret\n");
    const preview = JSON.stringify(result.changes);

    assert.match(preview, /"\*\*\*\*\*\*\*\*"/);
    assert.doesNotMatch(preview, /old-secret|new-secret/);
  });
});
