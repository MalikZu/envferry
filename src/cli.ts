import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { mergeEnv } from "./env/merge.js";
import { normalizeReceivedFileName, resolveReceiveTarget } from "./files/receive-target.js";
import { acceptLocalTcp, offerLocalTcp } from "./transport/local-tcp.js";
import type { TransferPayload } from "./transport/payload.js";

const HELP = `envferry

Move .env files between devices without pasting secrets into chat.

Usage:
  envferry send <file>
  envferry get <code>
  envferry merge-preview <existing> <incoming>

Status:
  send/get currently use a same-machine loopback spike (code: local-...).
  Encrypted cross-device transports are the next milestone.
`;

/** Run the CLI. Returns a process exit code; never throws for expected errors. */
export async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  switch (command) {
    case "merge-preview":
      return runMergePreview(rest);
    case "send":
      return runSend(rest);
    case "get":
      return runGet(rest);
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

async function runMergePreview(args: string[]): Promise<number> {
  const [existingPath, incomingPath] = args;
  if (!existingPath || !incomingPath) {
    process.stderr.write("Usage: envferry merge-preview <existing> <incoming>\n");
    return 2;
  }

  const [existingText, incomingText] = await Promise.all([
    readFile(existingPath, "utf8"),
    readFile(incomingPath, "utf8"),
  ]);
  const result = mergeEnv(existingText, incomingText);
  const receiveTarget = resolveReceiveTarget({
    directory: process.cwd(),
    receivedName: basename(incomingPath),
  });

  process.stdout.write(`target: ${receiveTarget}\n`);
  for (const change of result.changes) {
    process.stdout.write(`${change.action}: ${change.key}\n`);
  }
  return 0;
}

async function runSend(args: string[]): Promise<number> {
  const [filePath] = args;
  if (!filePath) {
    process.stderr.write("Usage: envferry send <file>\n");
    return 2;
  }

  const name = normalizeReceivedFileName(basename(filePath));
  const contents = await readFile(filePath, "utf8");
  const payload: TransferPayload = { files: [{ name, contents }] };

  await offerLocalTcp(payload, {
    onCode(code) {
      process.stdout.write(`code: ${code}\n`);
      process.stdout.write("waiting for receiver...\n");
    },
  });
  process.stdout.write("sent: 1 file\n");
  return 0;
}

async function runGet(args: string[]): Promise<number> {
  const [code] = args;
  if (!code) {
    process.stderr.write("Usage: envferry get <code>\n");
    return 2;
  }

  const payload = await acceptLocalTcp(code);
  await writeReceivedFiles(payload);
  return 0;
}

/** Write each received file into the cwd, refusing to overwrite (flag: "wx"). */
async function writeReceivedFiles(payload: TransferPayload): Promise<void> {
  for (const file of payload.files) {
    const target = resolveReceiveTarget({ directory: process.cwd(), receivedName: file.name });
    await writeFile(target, file.contents, { encoding: "utf8", flag: "wx" });
    process.stdout.write(`wrote: ${basename(target)}\n`);
  }
}
