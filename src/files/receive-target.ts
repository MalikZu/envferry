import { resolve } from "node:path";

// Receive-side safety. An incoming payload names the file it wants written, but
// that name comes from another machine and must never be trusted to steer where
// bytes land. These helpers strip any directory component (defeating path
// traversal) and refuse anything that is not a .env file.

/** True for `.env` and `.env.*` (e.g. `.env.production`). */
export function isEnvFileName(name: string): boolean {
  return name === ".env" || name.startsWith(".env.");
}

/**
 * Reduce a received name to a bare, safe filename: drop any POSIX or Windows
 * directory prefix, then require it to be an env file. Throws otherwise.
 */
export function normalizeReceivedFileName(receivedName: string): string {
  const normalized = receivedName.replaceAll("\\", "/").split("/").at(-1);

  if (normalized === undefined || !isEnvFileName(normalized)) {
    throw new Error(`Refusing to receive non-env file: ${receivedName}`);
  }

  return normalized;
}

export interface ReceiveTargetOptions {
  /** Absolute directory the file should land in (typically the receiver's cwd). */
  directory: string;
  /** The name the sender advertised for the file. */
  receivedName: string;
}

/** Resolve the absolute path a received file may be written to, inside `directory`. */
export function resolveReceiveTarget({ directory, receivedName }: ReceiveTargetOptions): string {
  return resolve(directory, normalizeReceivedFileName(receivedName));
}
