import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { mergeEnv } from "./env/merge.js";
import { normalizeReceivedFileName, resolveReceiveTarget } from "./files/receive-target.js";
import { acceptLocalTcp, offerLocalTcp } from "./transport/local-tcp.js";
import { acceptDirectTls, isDirectCode, offerDirectTls } from "./transport/direct-tls.js";
import { isRelayAddress, startRelay } from "./transport/relay.js";
import { acceptViaRelay, isRelayCode, offerViaRelay } from "./transport/relay-tls.js";
import { configPath, readConfig, writeConfig } from "./config.js";
import type { TransferPayload } from "./transport/payload.js";

const HELP = `envferry

Move .env files between devices without pasting secrets into chat.

Usage:
  envferry send <file> [--host <reachable-host>] [--bind <address>] [--timeout <seconds>]
  envferry send <file> --relay [<host:port>] [--relay-advertise <host:port>]
  envferry get <code>
  envferry relay [--host <address>] [--port <port>]
                 [--max-connections <n>] [--max-per-ip <n>]
                 [--pair-timeout <seconds>] [--header-timeout <seconds>]
  envferry config <get|set|unset|path> [relay] [<host:port>]
  envferry merge-preview <existing> <incoming>

Transports (get auto-detects which one from the code):
  Default   same-machine loopback spike (code: local-...).
  --host    direct TLS-PSK transport for hosts that can reach each other, e.g.
            a server's static IP (code: ef1_...). Encrypted end-to-end, one-shot.
  --relay   TLS-PSK through a blind relay for peers that can't reach each other
            (both behind NAT). Both dial out to the relay; it forwards ciphertext
            only and holds no key (code: efr1_...). With no value, --relay uses
            ENVFERRY_RELAY or the address from 'envferry config set relay ...'.
            The address is host:port; bracket IPv6, e.g. [2001:db8::1]:8787.

Set a default relay once: 'envferry config set relay relay.example.com:8787'.
Run your own with 'envferry relay --port <port>'. See docs/operating-a-relay.md.
`;

interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positionals: string[];
}

/** A minimal flag parser: `--key value` or boolean `--key`, plus positionals. */
function parseFlags(args: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { flags, positionals };
}

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
    case "relay":
      return runRelay(rest);
    case "config":
      return runConfig(rest);
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
  const { flags, positionals } = parseFlags(args);
  const [filePath] = positionals;
  if (!filePath) {
    process.stderr.write("Usage: envferry send <file> [--host <reachable-host>]\n");
    return 2;
  }

  const name = normalizeReceivedFileName(basename(filePath));
  const contents = await readFile(filePath, "utf8");
  const payload: TransferPayload = { files: [{ name, contents }] };
  const onCode = (code: string): void => {
    process.stdout.write(`code: ${code}\n`);
    process.stdout.write("waiting for receiver...\n");
  };

  if (flags.relay) {
    // --relay with no value falls back to a configured default, so the address
    // can be set once instead of passed every time.
    const relay = flags.relay === true ? defaultRelay() : String(flags.relay);
    if (!relay) {
      process.stderr.write(
        "--relay needs an address. Set one with `envferry config set relay <host:port>`,\n" +
          "export ENVFERRY_RELAY, or pass --relay <host:port>.\n"
      );
      return 2;
    }
    await offerViaRelay(payload, {
      relay,
      advertiseRelay:
        typeof flags["relay-advertise"] === "string" ? flags["relay-advertise"] : undefined,
      onCode,
    });
  } else if (flags.host) {
    await offerDirectTls(payload, {
      advertiseHost: String(flags.host),
      bindHost: typeof flags.bind === "string" ? flags.bind : "0.0.0.0",
      timeoutMs: flags.timeout ? Number(flags.timeout) * 1000 : undefined,
      onCode,
    });
  } else {
    await offerLocalTcp(payload, { onCode });
  }

  process.stdout.write("sent: 1 file\n");
  return 0;
}

async function runGet(args: string[]): Promise<number> {
  const [code] = args;
  if (!code) {
    process.stderr.write("Usage: envferry get <code>\n");
    return 2;
  }

  let payload: TransferPayload;
  if (isRelayCode(code)) {
    payload = await acceptViaRelay(code);
  } else if (isDirectCode(code)) {
    payload = await acceptDirectTls(code);
  } else {
    payload = await acceptLocalTcp(code);
  }
  await writeReceivedFiles(payload);
  return 0;
}

async function runRelay(args: string[]): Promise<number> {
  const { flags } = parseFlags(args);
  const seconds = (value: string | boolean | undefined): number | undefined =>
    typeof value === "string" ? Number(value) * 1000 : undefined;
  const count = (value: string | boolean | undefined): number | undefined =>
    typeof value === "string" ? Number(value) : undefined;

  const handle = await startRelay({
    host: typeof flags.host === "string" ? flags.host : "0.0.0.0",
    port: typeof flags.port === "string" ? Number(flags.port) : 0,
    maxConnections: count(flags["max-connections"]),
    maxPerIp: count(flags["max-per-ip"]),
    pairTimeoutMs: seconds(flags["pair-timeout"]),
    headerTimeoutMs: seconds(flags["header-timeout"]),
  });

  process.stdout.write(`relay listening on ${handle.host}:${handle.port}\n`);
  process.stdout.write("forwarding encrypted transfers (ciphertext only) — Ctrl+C to stop\n");
  await new Promise<never>(() => {
    // Run until the process is signalled.
  });
  return 0;
}

async function runConfig(args: string[]): Promise<number> {
  const [action, key, value] = args;

  switch (action) {
    case "path":
      process.stdout.write(configPath() + "\n");
      return 0;

    case "get": {
      const config = readConfig();
      if (key === undefined) {
        process.stdout.write(JSON.stringify(config, null, 2) + "\n");
        return 0;
      }
      if (key !== "relay") {
        process.stderr.write(`Unknown config key: ${key}\n`);
        return 2;
      }
      process.stdout.write((config.relay ?? "") + "\n");
      return 0;
    }

    case "set": {
      if (key !== "relay" || value === undefined) {
        process.stderr.write("Usage: envferry config set relay <host:port>\n");
        return 2;
      }
      // Accepts a DNS name or an IP, with a port; IPv6 must be bracketed.
      if (!isRelayAddress(value)) {
        process.stderr.write(`Invalid relay address: ${value} (expected host:port; bracket IPv6)\n`);
        return 2;
      }
      const config = readConfig();
      config.relay = value;
      writeConfig(config);
      process.stdout.write(`saved relay = ${value}\n`);
      return 0;
    }

    case "unset": {
      if (key !== "relay") {
        process.stderr.write("Usage: envferry config unset relay\n");
        return 2;
      }
      const config = readConfig();
      delete config.relay;
      writeConfig(config);
      process.stdout.write("removed relay\n");
      return 0;
    }

    default:
      process.stderr.write("Usage: envferry config <get|set|unset|path> [relay] [<host:port>]\n");
      return 2;
  }
}

/** Resolve the default relay address: ENVFERRY_RELAY first, then the config file. */
function defaultRelay(): string | undefined {
  const env = process.env["ENVFERRY_RELAY"];
  if (env !== undefined && env.length > 0) {
    return env;
  }
  return readConfig().relay;
}

/** Write each received file into the cwd, refusing to overwrite (flag: "wx"). */
async function writeReceivedFiles(payload: TransferPayload): Promise<void> {
  for (const file of payload.files) {
    const target = resolveReceiveTarget({ directory: process.cwd(), receivedName: file.name });
    await writeFile(target, file.contents, { encoding: "utf8", flag: "wx" });
    process.stdout.write(`wrote: ${basename(target)}\n`);
  }
}
