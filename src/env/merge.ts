import { maskSecret } from "./mask.js";
import { parseEnv, serializeEnv } from "./parse.js";
import type { EnvEntry } from "./parse.js";

/** One change produced by a merge. `before`/`after` are already masked. */
export interface EnvChange {
  action: "add" | "update";
  key: string;
  before?: string;
  after?: string;
}

export interface MergeResult {
  text: string;
  changes: EnvChange[];
}

/**
 * Merge `incomingText` into `existingText`: update the values of keys that exist,
 * append keys that don't, and leave everything else (comments, ordering, unknown
 * keys) untouched. Returns the merged text plus a masked change list suitable
 * for showing the user.
 */
export function mergeEnv(existingText: string, incomingText: string): MergeResult {
  const existing = parseEnv(existingText);
  const incoming = parseEnv(incomingText);
  const entries: EnvEntry[] = existing.entries.map((entry) => ({ ...entry }));
  const changes: EnvChange[] = [];

  for (const [key, incomingBinding] of incoming.bindings) {
    const existingBinding = existing.bindings.get(key);

    if (!existingBinding) {
      entries.push({
        type: "binding",
        key,
        value: incomingBinding.value,
        dirty: true,
        exportPrefix: false,
      });
      changes.push(maskedChange("add", key, undefined, incomingBinding.value));
      continue;
    }

    if (existingBinding.value === incomingBinding.value) {
      continue;
    }

    const target = entries[existingBinding.entryIndex];
    if (target && target.type === "binding") {
      entries[existingBinding.entryIndex] = {
        ...target,
        value: incomingBinding.value,
        dirty: true,
      };
    }
    changes.push(maskedChange("update", key, existingBinding.value, incomingBinding.value));
  }

  return { text: serializeEnv(entries), changes };
}

function maskedChange(
  action: EnvChange["action"],
  key: string,
  before: string | undefined,
  after: string | undefined
): EnvChange {
  return {
    action,
    key,
    before: before === undefined ? undefined : maskSecret(before),
    after: after === undefined ? undefined : maskSecret(after),
  };
}
