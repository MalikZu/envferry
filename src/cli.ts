import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { mergeEnv } from "./env/merge.js";
import { normalizeReceivedFileName, resolveReceiveTarget } from "./files/receive-target.js";
import { acceptLocalTcp, offerLocalTcp } from "./transport/local-tcp.js";
import { acceptDirectTls, isDirectCode, offerDirectTls } from "./transport/direct-tls.js";
import { isRelayAddress, startRelay } from "./transport/relay.js";
import { acceptViaRelay, isRelayCode, offerViaRelay } from "./transport/relay-tls.js";
import { configPath, readConfig, writeConfig } from "./config.js";
import { validatePayload } from "./transport/payload.js";
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
                 [--max-session-bytes <n>] [--max-session-seconds <seconds>]
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

/** A bad flag value — reported as a usage error (exit 2), not a crash. */
class UsageError extends Error {}

/** Value of a flag that requires an argument; `--flag` with no value is an error. */
function stringFlag(flags: ParsedArgs["flags"], name: string): string | undefined {
  const value = flags[name];
  if (value === undefined) {
    return undefined;
  }
  if (value === true || value === "") {
    throw new UsageError(`--${name} requires a value.`);
  }
  return String(value);
}

/** A strictly positive number of seconds, converted to milliseconds. */
function secondsFlag(flags: ParsedArgs["flags"], name: string): number | undefined {
  const raw = stringFlag(flags, name);
  if (raw === undefined) {
    return undefined;
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new UsageError(`--${name} must be a positive number of seconds, got "${raw}".`);
  }
  return seconds * 1000;
}

/** A strictly positive integer (counts/caps). */
function countFlag(flags: ParsedArgs["flags"], name: string): number | undefined {
  const raw = stringFlag(flags, name);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError(`--${name} must be a positive integer, got "${raw}".`);
  }
  return value;
}

/** A TCP port; 0 is allowed and means "pick a free port". */
function portFlag(flags: ParsedArgs["flags"], name: string): number | undefined {
  const raw = stringFlag(flags, name);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new UsageError(`--${name} must be a port (0-65535), got "${raw}".`);
  }
  return value;
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

  try {
    switch (command) {
      case "merge-preview":
        return await runMergePreview(rest);
      case "send":
        return await runSend(rest);
      case "get":
        return await runGet(rest);
      case "relay":
        return await runRelay(rest);
      case "config":
        return await runConfig(rest);
      default:
        process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
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
  // Enforce the wire limits before offering, so an oversized file fails here
  // with a clear message instead of at the receiver.
  validatePayload(payload);
  const onCode = (code: string): void => {
    process.stdout.write(`code: ${code}\n`);
    process.stdout.write("waiting for receiver...\n");
  };

  const host = stringFlag(flags, "host");

  if (flags.relay) {
    // --relay with no value falls back to a configured default, so the address
    // can be set once instead of passed every time.
    const relay = flags.relay === true ? defaultRelay() : stringFlag(flags, "relay");
    if (!relay) {
      process.stderr.write(
        "--relay needs an address. Set one with `envferry config set relay <host:port>`,\n" +
          "export ENVFERRY_RELAY, or pass --relay <host:port>.\n"
      );
      return 2;
    }
    await offerViaRelay(payload, {
      relay,
      advertiseRelay: stringFlag(flags, "relay-advertise"),
      onCode,
    });
  } else if (host !== undefined) {
    await offerDirectTls(payload, {
      advertiseHost: host,
      bindHost: stringFlag(flags, "bind") ?? "0.0.0.0",
      timeoutMs: secondsFlag(flags, "timeout"),
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

  const handle = await startRelay({
    host: stringFlag(flags, "host") ?? "0.0.0.0",
    port: portFlag(flags, "port") ?? 0,
    maxConnections: countFlag(flags, "max-connections"),
    maxPerIp: countFlag(flags, "max-per-ip"),
    pairTimeoutMs: secondsFlag(flags, "pair-timeout"),
    headerTimeoutMs: secondsFlag(flags, "header-timeout"),
    maxSessionBytes: countFlag(flags, "max-session-bytes"),
    maxSessionMs: secondsFlag(flags, "max-session-seconds"),
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
