// A small, dependency-free `.env` parser that is *lossless* by design: it keeps
// every original line (comments, blanks, odd formatting) as its `raw` text and
// only re-serializes lines that were explicitly changed. That is what lets the
// merge step update a value in place without reflowing or clobbering the rest of
// the file.

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LINE_PATTERN =
  /^(?<indent>\s*)(?<export>export\s+)?(?<key>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?<value>.*)$/;

/** A line that carries a `KEY=value` binding. */
export interface BindingEntry {
  type: "binding";
  /** Original source line. Absent for bindings synthesized during a merge. */
  raw?: string;
  key: string;
  value: string;
  /** Whether the source used `export KEY=...`. */
  exportPrefix: boolean;
  /** Set when the value changed and must be re-serialized instead of using `raw`. */
  dirty?: boolean;
}

/** A non-binding line preserved verbatim (blank, comment, or unparseable). */
export interface RawLineEntry {
  type: "blank" | "comment" | "raw";
  raw: string;
}

export type EnvEntry = BindingEntry | RawLineEntry;

/** A resolved binding plus where it lives in the entry list. */
export interface EnvBinding {
  value: string;
  entryIndex: number;
}

export interface ParsedEnv {
  entries: EnvEntry[];
  bindings: Map<string, EnvBinding>;
}

/** Parse `.env` text into an ordered entry list and a key → binding index. */
export function parseEnv(text: string): ParsedEnv {
  const entries: EnvEntry[] = [];
  const bindings = new Map<string, EnvBinding>();
  const lines = text.replaceAll("\r\n", "\n").split("\n");

  // A trailing newline produces a final empty element; drop it so we don't
  // synthesize a spurious blank line on round-trip.
  if (lines.at(-1) === "") {
    lines.pop();
  }

  for (const line of lines) {
    const parsed = parseLine(line);
    entries.push(parsed);

    if (parsed.type === "binding") {
      bindings.set(parsed.key, { value: parsed.value, entryIndex: entries.length - 1 });
    }
  }

  return { entries, bindings };
}

/** Render an entry list back to `.env` text, always ending with a newline. */
export function serializeEnv(entries: EnvEntry[]): string {
  return `${entries.map(serializeEntry).join("\n")}\n`;
}

function parseLine(line: string): EnvEntry {
  if (line.trim() === "") {
    return { type: "blank", raw: line };
  }

  if (line.trimStart().startsWith("#")) {
    return { type: "comment", raw: line };
  }

  const groups = LINE_PATTERN.exec(line)?.groups;
  const key = groups?.["key"];
  const value = groups?.["value"];
  if (key === undefined || value === undefined || !KEY_PATTERN.test(key)) {
    return { type: "raw", raw: line };
  }

  return {
    type: "binding",
    raw: line,
    key,
    value: parseValue(value),
    exportPrefix: Boolean(groups?.["export"]),
  };
}

function parseValue(source: string): string {
  const value = source.trimStart();

  if (value.startsWith('"')) {
    return parseDoubleQuotedValue(value);
  }

  if (value.startsWith("'")) {
    // Single quotes are literal — no escape processing.
    const end = value.indexOf("'", 1);
    return end === -1 ? value.slice(1) : value.slice(1, end);
  }

  return stripInlineComment(value).trimEnd();
}

function parseDoubleQuotedValue(value: string): string {
  let output = "";

  for (let index = 1; index < value.length; index += 1) {
    const char = value[index];

    // Closing quote (or end of string without one) terminates the value.
    if (char === undefined || char === '"') {
      return output;
    }

    if (char !== "\\") {
      output += char;
      continue;
    }

    const next = value[index + 1];
    index += 1;
    if (next === "n") output += "\n";
    else if (next === "r") output += "\r";
    else if (next === "t") output += "\t";
    else if (next === undefined) output += "\\";
    else output += next;
  }

  return output;
}

/** Trim an unquoted trailing `# comment`, but only when `#` follows whitespace. */
function stripInlineComment(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const prev = index === 0 ? undefined : value[index - 1];
    if (value[index] === "#" && (index === 0 || (prev !== undefined && /\s/.test(prev)))) {
      return value.slice(0, index);
    }
  }

  return value;
}

function serializeEntry(entry: EnvEntry): string {
  if (entry.type === "binding" && entry.dirty) {
    const prefix = entry.exportPrefix ? "export " : "";
    return `${prefix}${entry.key}=${formatValue(entry.value)}`;
  }

  if (entry.type === "binding") {
    // A non-dirty binding was parsed from text, so its raw line is present.
    return entry.raw ?? "";
  }

  return entry.raw;
}

/** Quote a value only when leaving it bare would change its meaning. */
function formatValue(value: string): string {
  if (value === "") {
    return "";
  }

  if (!/[\s#"'\\]/.test(value)) {
    return value;
  }

  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")
    .replaceAll('"', '\\"')}"`;
}
