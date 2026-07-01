import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Tests drive the CLI as a real subprocess against the built artifact, so they
// exercise exactly what ships and run from any working directory. The `pretest`
// script builds dist/ before the suite runs.
const CLI = new URL("../dist/bin/envferry.js", import.meta.url).pathname;
const RUNNER = [CLI];

interface Output {
  stdout: string;
  stderr: string;
}

describe("envferry CLI", () => {
  it("sends .env and receives it with the local spike transport", async () => {
    if (!(await canOpenLocalListener())) {
      return; // local listeners blocked in this sandbox
    }

    const root = await mkdtemp(join(tmpdir(), "envferry-send-"));
    const senderDir = join(root, "sender");
    const receiverDir = join(root, "receiver");
    await mkdir(senderDir);
    await mkdir(receiverDir);
    await writeFile(join(senderDir, ".env"), "API_KEY=super-secret\n");

    const sender = spawn(process.execPath, [...RUNNER, "send", ".env"], {
      cwd: senderDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const senderExit = waitForExit(sender);
    const senderOutput = collectOutput(sender);
    const code = await waitForStdout(sender, senderOutput, /code: (local-\d+-[a-f0-9]{32})/);

    const receiver = spawnSync(process.execPath, [...RUNNER, "get", code], {
      cwd: receiverDir,
      encoding: "utf8",
    });
    assert.equal(receiver.status, 0, receiver.stderr);

    const exit = await senderExit;
    assert.equal(exit.status, 0, senderOutput.stderr);
    assert.equal(await readFile(join(receiverDir, ".env"), "utf8"), "API_KEY=super-secret\n");
    assert.match(senderOutput.stdout, /sent: 1 file/);
    assert.match(receiver.stdout, /wrote: \.env/);
    assert.doesNotMatch(senderOutput.stdout + receiver.stdout, /super-secret/);
  });

  it("sends and receives over the direct TLS transport with --host", async () => {
    if (!(await canOpenLocalListener())) {
      return;
    }

    const root = await mkdtemp(join(tmpdir(), "envferry-direct-"));
    const senderDir = join(root, "sender");
    const receiverDir = join(root, "receiver");
    await mkdir(senderDir);
    await mkdir(receiverDir);
    await writeFile(join(senderDir, ".env"), "API_KEY=super-secret\n");

    const sender = spawn(
      process.execPath,
      [...RUNNER, "send", ".env", "--host", "127.0.0.1", "--bind", "127.0.0.1"],
      { cwd: senderDir, stdio: ["ignore", "pipe", "pipe"] }
    );
    const senderExit = waitForExit(sender);
    const senderOutput = collectOutput(sender);
    const code = await waitForStdout(sender, senderOutput, /code: (ef1_[A-Za-z0-9_-]+)/);

    const receiver = spawnSync(process.execPath, [...RUNNER, "get", code], {
      cwd: receiverDir,
      encoding: "utf8",
    });
    assert.equal(receiver.status, 0, receiver.stderr);

    const exit = await senderExit;
    assert.equal(exit.status, 0, senderOutput.stderr);
    assert.equal(await readFile(join(receiverDir, ".env"), "utf8"), "API_KEY=super-secret\n");
    assert.match(receiver.stdout, /wrote: \.env/);
    assert.doesNotMatch(senderOutput.stdout + receiver.stdout, /super-secret/);
  });

  it("previews env merges without printing secret values", async () => {
    const root = await mkdtemp(join(tmpdir(), "envferry-cli-"));
    const existingDir = join(root, "existing");
    const incomingDir = join(root, "incoming");
    await mkdir(existingDir);
    await mkdir(incomingDir);

    const existing = join(existingDir, ".env.local");
    const incoming = join(incomingDir, ".env.local");
    await writeFile(existing, "# local settings\nAPI_URL=https://old.example\nLOCAL_ONLY=true\n");
    await writeFile(incoming, "API_URL=https://new.example\nNEW_SECRET=super-secret\n");

    const result = spawnSync(process.execPath, [...RUNNER, "merge-preview", existing, incoming], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /target: .*\.env\.local/);
    assert.match(result.stdout, /update: API_URL/);
    assert.match(result.stdout, /add: NEW_SECRET/);
    assert.doesNotMatch(result.stdout, /super-secret|old\.example|new\.example/);
  });

  it("rejects merge previews for non-env incoming filenames", async () => {
    const root = await mkdtemp(join(tmpdir(), "envferry-cli-"));
    const existing = join(root, ".env");
    const incoming = join(root, "incoming.env");
    await writeFile(existing, "API_URL=https://old.example\n");
    await writeFile(incoming, "API_URL=https://new.example\n");

    const result = spawnSync(process.execPath, [...RUNNER, "merge-preview", existing, incoming], {
      encoding: "utf8",
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing to receive non-env file/);
  });
});

function collectOutput(child: ChildProcessByStdio<null, Readable, Readable>): Output {
  const output: Output = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output.stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    output.stderr += chunk;
  });
  return output;
}

function waitForStdout(
  child: ChildProcessByStdio<null, Readable, Readable>,
  output: Output,
  pattern: RegExp
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out waiting for ${pattern}. stderr: ${output.stderr}`));
    }, 5000);

    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onData = (): void => {
      const match = pattern.exec(output.stdout);
      if (!match) {
        return;
      }
      cleanup();
      resolve(match[1] ?? "");
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (status: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`Sender exited before printing a code. status=${status} signal=${signal}`));
    };

    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForExit(
  child: ChildProcessByStdio<null, Readable, Readable>
): Promise<{ status: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.once("exit", (status, signal) => {
      resolve({ status, signal });
    });
  });
}

function canOpenLocalListener(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(0, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}
