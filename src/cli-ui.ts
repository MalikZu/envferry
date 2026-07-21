// Terminal presentation helpers for the CLI. Everything here is cosmetic and
// zero-dependency: hand-rolled ANSI, gated so that plain, line-oriented output
// is emitted when stdout is not a TTY (pipes, CI, tests) or NO_COLOR is set.
// Machine-readable lines like `code: <code>` must stay stable either way —
// scripts and the test suite parse them.

const interactive = process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;

const ESC = "\u001B";

/** Whether stdout is an interactive terminal (spinner + color allowed). */
export function isInteractive(): boolean {
  return interactive;
}

function style(open: number, close: number): (text: string) => string {
  return (text) => (interactive ? `${ESC}[${open}m${text}${ESC}[${close}m` : text);
}

export const bold = style(1, 22);
export const dim = style(2, 22);
export const green = style(32, 39);
export const cyan = style(36, 39);
export const yellow = style(33, 39);

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface Spinner {
  /** Replace the text next to the spinner (interactive only; no-op otherwise). */
  update(text: string): void;
  /** Stop and print a green check line. */
  succeed(text: string): void;
  /** Stop and print a yellow cross line. */
  fail(text: string): void;
  /** Stop and erase the spinner line without printing anything. */
  stop(): void;
}

/**
 * An animated activity indicator. Non-interactive fallback prints `initial`
 * once and the final succeed/fail line, so piped output stays line-oriented.
 */
export function spinner(initial: string): Spinner {
  if (!interactive) {
    process.stdout.write(initial + "\n");
    return {
      update() {},
      succeed(text) {
        process.stdout.write(text + "\n");
      },
      fail(text) {
        process.stdout.write(text + "\n");
      },
      stop() {},
    };
  }

  let text = initial;
  let frame = 0;
  const render = (): void => {
    process.stdout.write(`\r${ESC}[2K${cyan(FRAMES[frame % FRAMES.length] ?? "-")} ${text}`);
    frame += 1;
  };
  render();
  const timer = setInterval(render, 80);
  timer.unref?.();
  const clear = (): void => {
    clearInterval(timer);
    process.stdout.write(`\r${ESC}[2K`);
  };

  return {
    update(next) {
      text = next;
    },
    succeed(finalText) {
      clear();
      process.stdout.write(`${green("✓")} ${finalText}\n`);
    },
    fail(finalText) {
      clear();
      process.stdout.write(`${yellow("✗")} ${finalText}\n`);
    },
    stop() {
      clear();
    },
  };
}

/** "214 B", "1.3 KiB", "2.0 MiB" — for showing how much is being sent. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1_048_576) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

/** "0:07", "4:59" — elapsed/remaining time next to the spinner. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
