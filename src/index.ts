// Public API surface for envferry.
//
// Library consumers import from here; the CLI in src/bin wires these pieces into
// the send/get commands. Exports are added as each module lands.
export { parseEnv, serializeEnv } from "./env/parse.js";
export type { BindingEntry, EnvBinding, EnvEntry, ParsedEnv, RawLineEntry } from "./env/parse.js";
