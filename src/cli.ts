import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { mergeEnv } from "./env/merge.js";
import { parseEnv } from "./env/parse.js";
import { normalizeReceivedFileName, resolveReceiveTarget } from "./files/receive-target.js";
import { acceptLocalTcp, offerLocalTcp } from "./transport/local-tcp.js";
import { acceptDirectTls, isDirectCode, offerDirectTls } from "./transport/direct-tls.js";
import { isRelayAddress, parseRelayAddress, startRelay } from "./transport/relay.js";
import { acceptViaRelay, isRelayCode, offerViaRelay } from "./transport/relay-tls.js";
import { configPath, readConfig, writeConfig } from "./config.js";
import { MAX_RECEIVERS, validatePayload } from "./transport/payload.js";
import type { TransferPayload } from "./transport/payload.js";
import { bold, cyan, dim, formatBytes, green, isInteractive, spinner } from "./cli-ui.js";
import type { Spinner } from "./cli-ui.js";

const HELP = `envferry

Move .env files between devices without pasting secrets into chat.

Usage:
  envferry send <file> --relay [<host:port>] [--relay-advertise <host:port>]
  envferry send <file> [--host <this-machine's-address>] [--bind <address>]
  envferry send <file> [--receivers <n>] [--timeout <seconds>]
  envferry get <code>
  envferry relay [--host <address>] [--port <port>]
                 [--max-connections <n>] [--max-per-ip <n>]
                 [--pair-timeout <seconds>] [--header-timeout <seconds>]
                 [--max-session-bytes <n>] [--max-session-seconds <seconds>]
  envferry config <get|set|unset|path> [relay] [<host:port>]
  envferry merge-preview <existing> <incoming>

Transports (get auto-detects which one from the code):
  --relay   the usual cross-machine choice: TLS-PSK through a blind relay, so
            neither peer needs to be reachable (both behind NAT is fine). Both
            dial out to the relay; it forwards ciphertext only and holds no key
            (code: efr1_...). With no value, --relay uses ENVFERRY_RELAY or the
            address from 'envferry config set relay ...'. The address is
            host:port; bracket IPv6, e.g. [2001:db8::1]:8787.
  --host    direct TLS-PSK, no relay involved. The value is the address other
            machines can reach THIS machine at (a static IP, LAN, VPN) — NOT a
            relay's address. The port is picked automatically (code: ef1_...).
  Default   same-machine loopback spike (code: local-...).

Options:
  --receivers <n>   let up to n receivers redeem the same code (default 1).
                    Via a relay this needs a relay running envferry >= 0.2.0.
  --timeout <s>     how long to wait for receivers before giving up.

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
    process.stderr.write("Usage: envferry send <file> [--relay [<host:port>] | --host <this-machine's-address>]\n");
    return 2;
  }

  const name = normalizeReceivedFileName(basename(filePath));
  const contents = await readFile(filePath, "utf8");
  const payload: TransferPayload = { files: [{ name, contents }] };
  // Enforce the wire limits before offering, so an oversized file fails here
  // with a clear message instead of at the receiver.
  validatePayload(payload);

  const receivers = countFlag(flags, "receivers") ?? 1;
  if (receivers > MAX_RECEIVERS) {
    throw new UsageError(`--receivers is capped at ${MAX_RECEIVERS}.`);
  }

  const host = stringFlag(flags, "host");
  // The single most common mistake: passing a relay's host:port to --host.
  // --host is the address other machines reach THIS machine at; the port is
  // picked automatically, so a value with a port can never be right.
  if (host !== undefined && parseRelayAddress(host) !== null) {
    throw new UsageError(
      `--host got "${host}", which looks like host:port — but --host takes only a host.\n` +
        `It is the address other machines can reach THIS machine at (the port is picked\n` +
        `automatically and embedded in the code).\n\n` +
        `If ${host} is a relay, you want:  envferry send ${filePath} --relay ${host}`
    );
  }

  // What gets shown about the file: name, key count, size — never a value.
  const keyCount = parseEnv(contents).bindings.size;
  const sizeLabel = formatBytes(Buffer.byteLength(contents, "utf8"));
  const fileLabel = `${bold(name)} ${dim(`(${keyCount} ${keyCount === 1 ? "key" : "keys"}, ${sizeLabel})`)}`;

  let delivered = 0;
  let wait: Spinner | undefined;
  const waitText = (): string =>
    receivers > 1 ? `waiting for receivers (${delivered}/${receivers} served)...` : "waiting for receiver...";
  const announce = (transportLabel: string) => (code: string): void => {
    if (isInteractive()) {
      process.stdout.write(`sending ${fileLabel} via ${transportLabel}\n\n`);
      process.stdout.write(`  code:  ${bold(cyan(code))}\n\n`);
      process.stdout.write(`  ${dim("on the other machine:")}  ${green(`envferry get ${code}`)}\n\n`);
    } else {
      process.stdout.write(`code: ${code}\n`);
    }
    wait = spinner(waitText());
  };
  const onDelivery = (count: number): void => {
    delivered = count;
    if (isInteractive()) {
      wait?.update(waitText());
    } else if (receivers > 1) {
      process.stdout.write(`delivered: ${count}/${receivers}\n`);
    }
  };

  try {
    if (flags.relay) {
      // --relay with no value falls back to a configured default, so the address
      // can be set once instead of passed every time.
      const explicit = flags.relay === true ? undefined : stringFlag(flags, "relay");
      const relay = explicit ?? defaultRelay();
      if (!relay) {
        process.stderr.write(
          "--relay needs an address. Set one with `envferry config set relay <host:port>`,\n" +
            "export ENVFERRY_RELAY, or pass --relay <host:port>.\n"
        );
        return 2;
      }
      // Passing the address by hand every time gets old — point at the config
      // command once, when no default is set up yet.
      if (explicit !== undefined && defaultRelay() === undefined) {
        process.stderr.write(
          dim(`tip: make this the default relay:  envferry config set relay ${explicit}\n`)
        );
      }
      await offerViaRelay(payload, {
        relay,
        advertiseRelay: stringFlag(flags, "relay-advertise"),
        receivers,
        timeoutMs: secondsFlag(flags, "timeout"),
        onCode: announce(`blind relay ${relayLabel(relay)}`),
        onDelivery,
      });
    } else if (host !== undefined) {
      await offerDirectTls(payload, {
        advertiseHost: host,
        bindHost: stringFlag(flags, "bind") ?? "0.0.0.0",
        timeoutMs: secondsFlag(flags, "timeout"),
        receivers,
        onCode: announce(`direct TLS ${dim(`(receivers dial ${host})`)}`),
        onDelivery,
      });
    } else {
      if (receivers > 1) {
        throw new UsageError(
          "--receivers needs a cross-machine transport — add --relay (or --host)."
        );
      }
      await offerLocalTcp(payload, { onCode: announce(`local loopback ${dim("(this machine only)")}`) });
      // Loopback is the default, and it is easy to expect it to work across
      // machines when it never can — say so once the transfer is done.
      process.stderr.write(
        dim("note: local-... codes work only on this machine. Use --relay to reach another machine.\n")
      );
    }
  } catch (error) {
    // Erase the spinner so the error message lands on a clean line.
    wait?.stop();
    throw error;
  }

  const summary =
    receivers > 1
      ? `sent: 1 file to ${delivered} receiver${delivered === 1 ? "" : "s"}`
      : "sent: 1 file";
  if (wait) {
    wait.succeed(summary);
  } else {
    process.stdout.write(summary + "\n");
  }
  return 0;
}

/** Human label for a relay address input (string or {host, port}). */
function relayLabel(relay: string | { host: string; port: number }): string {
  return typeof relay === "string" ? relay : `${relay.host}:${relay.port}`;
}

async function runGet(args: string[]): Promise<number> {
  const [code] = args;
  if (!code) {
    process.stderr.write("Usage: envferry get <code>\n");
    return 2;
  }

  // Interactive-only activity indicator; piped output stays just `wrote:` lines.
  const wait = isInteractive() ? spinner("connecting to sender...") : undefined;
  let payload: TransferPayload;
  try {
    if (isRelayCode(code)) {
      payload = await acceptViaRelay(code);
    } else if (isDirectCode(code)) {
      payload = await acceptDirectTls(code);
    } else {
      payload = await acceptLocalTcp(code);
    }
  } catch (error) {
    wait?.stop();
    throw error;
  }
  wait?.stop();
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
