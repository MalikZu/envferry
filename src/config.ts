import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// A small user config file so a default relay (and future settings) can be set
// once instead of passed on every command. It lives at
// $XDG_CONFIG_HOME/envferry/config.json (or ~/.config/envferry/config.json) and
// is never shipped in the package — the published tool has no baked-in relay.

export interface EnvferryConfig {
  /** Default relay address (host:port) used by `send --relay` with no value. */
  relay?: string;
}

/** Absolute path to the config file, honoring XDG_CONFIG_HOME. */
export function configPath(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "envferry", "config.json");
}

/** Read the config, returning an empty object if it is missing or unreadable. */
export function readConfig(): EnvferryConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    return {};
  }
  return parsed !== null && typeof parsed === "object" ? (parsed as EnvferryConfig) : {};
}

/** Write the config, creating the directory and keeping it user-only (0600). */
export function writeConfig(config: EnvferryConfig): void {
  const target = configPath();
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}
