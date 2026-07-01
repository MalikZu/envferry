import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { configPath, readConfig, writeConfig } from "../src/index.js";

const CLI = new URL("../dist/bin/envferry.js", import.meta.url).pathname;

describe("config file", () => {
  it("round-trips config under XDG_CONFIG_HOME", async () => {
    const dir = await mkdtemp(join(tmpdir(), "envferry-cfg-"));
    const previous = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = dir;
    try {
      assert.equal(readConfig().relay, undefined);
      assert.ok(configPath().startsWith(dir), "configPath should honor XDG_CONFIG_HOME");

      writeConfig({ relay: "relay.example.com:8787" });
      assert.equal(readConfig().relay, "relay.example.com:8787");

      const raw = await readFile(configPath(), "utf8");
      assert.match(raw, /relay\.example\.com:8787/);
    } finally {
      if (previous === undefined) {
        delete process.env["XDG_CONFIG_HOME"];
      } else {
        process.env["XDG_CONFIG_HOME"] = previous;
      }
    }
  });
});

describe("config command", () => {
  it("sets, gets, unsets, and validates a relay address (IP, DNS, IPv6)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "envferry-cfgcli-"));
    const env = { ...process.env, XDG_CONFIG_HOME: dir };
    const run = (...args: string[]): { status: number | null; stdout: string; stderr: string } =>
      spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env });

    // empty to start
    assert.equal(run("config", "get", "relay").stdout.trim(), "");

    // DNS name
    let result = run("config", "set", "relay", "relay.example.com:8787");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /saved relay = relay\.example\.com:8787/);
    assert.equal(run("config", "get", "relay").stdout.trim(), "relay.example.com:8787");

    // IPv4
    assert.equal(run("config", "set", "relay", "203.0.113.10:9000").status, 0);
    assert.equal(run("config", "get", "relay").stdout.trim(), "203.0.113.10:9000");

    // IPv6 (bracketed)
    assert.equal(run("config", "set", "relay", "[2001:db8::1]:8787").status, 0);
    assert.equal(run("config", "get", "relay").stdout.trim(), "[2001:db8::1]:8787");

    // invalid → rejected, config unchanged
    result = run("config", "set", "relay", "not-an-address");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Invalid relay address/);
    assert.equal(run("config", "get", "relay").stdout.trim(), "[2001:db8::1]:8787");

    // path is under the XDG dir
    assert.ok(run("config", "path").stdout.startsWith(dir));

    // unset
    assert.equal(run("config", "unset", "relay").status, 0);
    assert.equal(run("config", "get", "relay").stdout.trim(), "");
  });
});
