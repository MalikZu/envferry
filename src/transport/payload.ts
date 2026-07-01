// The wire payload every transport moves: a list of named files with their
// contents. Kept deliberately small and transport-agnostic so the same shape
// flows over the loopback spike, the direct TLS transport, and the relay.

export interface TransferFile {
  name: string;
  contents: string;
}

export interface TransferPayload {
  files: TransferFile[];
}

/**
 * Validate a payload decoded from an untrusted peer before acting on it. Throws
 * on anything that is not `{ files: [{ name: string, contents: string }, ...] }`.
 */
export function validatePayload(payload: unknown): asserts payload is TransferPayload {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !Array.isArray((payload as { files?: unknown }).files)
  ) {
    throw new Error("Invalid transfer payload.");
  }

  for (const file of (payload as TransferPayload).files) {
    if (typeof file?.name !== "string" || typeof file?.contents !== "string") {
      throw new Error("Invalid transfer file payload.");
    }
  }
}
