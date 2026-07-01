// Public API surface for envferry.
//
// Library consumers import from here; the CLI in src/bin wires these pieces into
// the send/get commands. Exports are added as each module lands.
export { parseEnv, serializeEnv } from "./env/parse.js";
export type { BindingEntry, EnvBinding, EnvEntry, ParsedEnv, RawLineEntry } from "./env/parse.js";
export { maskSecret } from "./env/mask.js";
export { mergeEnv } from "./env/merge.js";
export type { EnvChange, MergeResult } from "./env/merge.js";
export {
  isEnvFileName,
  normalizeReceivedFileName,
  resolveReceiveTarget,
} from "./files/receive-target.js";
export type { ReceiveTargetOptions } from "./files/receive-target.js";
export { receivePayload, sendPayload } from "./transport/session.js";
export type { Transport } from "./transport/session.js";
export { validatePayload } from "./transport/payload.js";
export type { TransferFile, TransferPayload } from "./transport/payload.js";
