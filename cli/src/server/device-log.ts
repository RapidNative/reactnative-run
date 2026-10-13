/**
 * Turning what a phone sends into one readable log line.
 *
 * RN's HMRClient pretty-formats every non-string console argument on the device with
 * `highlight: true`, so bodies arrive full of ANSI color codes, and an Error arrives as
 * `[Error: message]` with no stack. The stack of a crash only reaches the server when LogBox
 * opens and POSTs its frames to /symbolicate, so that route logs them as a `[device:stack]`
 * line right after the error. Anything reading the log (the platform's crash collector) pairs
 * the two.
 */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** One console argument as text: strings as they are, errors with name, message and stack. */
export function formatLogArg(d: unknown): string {
  if (typeof d === "string") return stripAnsi(d);
  if (d && typeof d === "object") {
    const e = d as { name?: unknown; message?: unknown; stack?: unknown };
    if (typeof e.message === "string" && (typeof e.stack === "string" || typeof e.name === "string")) {
      const head = `${typeof e.name === "string" ? e.name : "Error"}: ${e.message}`;
      return typeof e.stack === "string" ? `${head}\n${stripAnsi(e.stack)}` : head;
    }
  }
  try {
    return JSON.stringify(d) ?? String(d);
  } catch {
    return String(d);
  }
}

export function formatDeviceLog(level: string | undefined, data: unknown[] | undefined): string {
  const body = (data || []).map(formatLogArg).join(" ");
  return `[device:${level || "log"}] ${body}`;
}

export interface StackFrame {
  file?: string;
  lineNumber?: number;
  column?: number;
  methodName?: string;
}

/** A symbolicated stack as one line, top frames first. Null when nothing maps to a file. */
export function formatStackLine(frames: StackFrame[], max = 12): string | null {
  const shown = frames
    .filter((f) => f.file)
    .slice(0, max)
    .map((f) => `at ${f.methodName || "<anonymous>"} (${f.file}${f.lineNumber ? `:${f.lineNumber}` : ""}${f.column != null ? `:${f.column}` : ""})`);
  return shown.length ? `[device:stack] ${shown.join(" | ")}` : null;
}
