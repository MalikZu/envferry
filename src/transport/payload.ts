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

// Hard limits on what a peer may send. envferry moves .env files — tiny text —
// so these are generous for the use case while keeping a malicious or buggy
// peer from driving memory exhaustion on the receiver.
export const MAX_FILES = 32;
export const MAX_FILE_NAME_BYTES = 255;
export const MAX_PAYLOAD_BYTES = 1_048_576; // 1 MiB of file contents total

// Ceiling for a single framed wire message (the JSON envelope around the
// payload). JSON string escaping can inflate contents, so this is comfortably
// above MAX_PAYLOAD_BYTES; anything larger is hostile and the read is aborted.
export const MAX_MESSAGE_BYTES = 8 * 1_048_576;

/**
 * Validate a payload decoded from an untrusted peer before acting on it. Throws
 * on anything that is not `{ files: [{ name: string, contents: string }, ...] }`
 * or that exceeds the size limits above.
 */
export function validatePayload(payload: unknown): asserts payload is TransferPayload {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !Array.isArray((payload as { files?: unknown }).files)
  ) {
    throw new Error("Invalid transfer payload.");
  }

  const files = (payload as TransferPayload).files;
  if (files.length > MAX_FILES) {
    throw new Error(`Too many files in transfer payload (max ${MAX_FILES}).`);
  }

  let totalBytes = 0;
  for (const file of files) {
    if (typeof file?.name !== "string" || typeof file?.contents !== "string") {
      throw new Error("Invalid transfer file payload.");
    }
    if (Buffer.byteLength(file.name, "utf8") > MAX_FILE_NAME_BYTES) {
      throw new Error(`File name too long (max ${MAX_FILE_NAME_BYTES} bytes).`);
    }
    totalBytes += Buffer.byteLength(file.contents, "utf8");
    if (totalBytes > MAX_PAYLOAD_BYTES) {
      throw new Error(`Transfer payload too large (max ${MAX_PAYLOAD_BYTES} bytes).`);
    }
  }
}
