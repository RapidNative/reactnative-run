import * as acorn from "acorn";
import jsx from "acorn-jsx";

const AcornJSX = acorn.Parser.extend(jsx() as any);

function tryAcornParse(src: string): { line: number; column: number; message: string } | null {
  try {
    AcornJSX.parse(src, { sourceType: "module", ecmaVersion: "latest", locations: true } as any);
    return null;
  } catch (e: any) {
    if (e.loc) return { line: e.loc.line, column: e.loc.column, message: e.message };
    return null;
  }
}

/**
 * Lightweight regex-based removal of TypeScript-only syntax so Acorn (JS-only)
 * can parse the rest of the file for accurate error locations.
 *
 * Replaces type-only lines with blank lines to preserve line numbers.
 * Handles: `type X = ...`, `interface X { ... }`, inline `: Type` annotations,
 * `as Type` casts, and generic parameters like `<T>` / `<T,>` / `<T extends X>`.
 */
function stripTSForAcorn(src: string): string {
  // 1. Remove top-level `type X = ...` and `export type X = ...` declarations
  let result = src.replace(/^(export\s+)?type\s+[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*=\s*[^;]*;?\s*$/gm, "");

  // 2. Remove `interface X { ... }` blocks (possibly multi-line)
  result = result.replace(/^(export\s+)?interface\s+[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*(?:extends\s+[^{]*)?\{[^}]*\}/gm,
    (match) => "\n".repeat((match.match(/\n/g) || []).length));

  // 3. Remove type annotations in function params/variables: `: SomeType`
  //    Be careful not to remove ternary colons — only strip after identifiers/closing brackets
  result = result.replace(/(?<=[\w$)\]?])\s*:\s*(?:readonly\s+)?[A-Za-z_$][\w$<>\[\]|&,\s]*(?=\s*[=,;)}\]])/g, "");

  // 4. Remove `as Type` casts
  result = result.replace(/\s+as\s+[A-Za-z_$][\w$<>\[\]|&]*/g, "");

  // 5. Remove generic type params on arrow functions: `<T,>`, `<T extends X>`
  result = result.replace(/=\s*<([A-Za-z_$][\w$]*)\s*,?\s*(?:extends\s+[^>]*)?>(?=\s*\()/g, "= ");

  return result;
}

function buildCodeFrame(src: string, errorLine: number, errorCol: number): string {
  const lines = src.split("\n");
  const start = Math.max(0, errorLine - 3);
  const end = Math.min(lines.length, errorLine + 2);

  let frame = "";
  for (let i = start; i < end; i++) {
    const lineNum = i + 1;
    const marker = lineNum === errorLine ? "> " : "  ";
    const pad = String(lineNum).padStart(String(end).length);
    frame += `${marker}${pad} | ${lines[i]}\n`;
    if (lineNum === errorLine) {
      const caretPad = " ".repeat(marker.length + pad.length + 3 + errorCol);
      frame += `${caretPad}^\n`;
    }
  }
  return frame;
}

export function formatTransformError(
  err: unknown,
  filename: string,
  originalSrc: string,
  _transformedSrc: string,
  _parseOriginal: (src: string) => void,
): Error {
  if (!(err instanceof Error)) return new Error(String(err));

  // Sucrase often reports wrong positions for JSX errors.
  // Use acorn+jsx to get accurate error location from the original source.
  // For TypeScript files, do a lightweight regex strip of TS syntax first
  // since Acorn doesn't understand TypeScript.
  const ext = filename.slice(filename.lastIndexOf("."));
  const isTS = ext === ".ts" || ext === ".tsx";
  const acornSrc = isTS ? stripTSForAcorn(originalSrc) : originalSrc;
  const acornErr = tryAcornParse(acornSrc);
  if (acornErr) {
    // Use the original source for the code frame — line numbers are preserved
    // since regex stripping replaces with blank lines.
    const frame = buildCodeFrame(originalSrc, acornErr.line, acornErr.column);
    const msg = `${filename}: ${acornErr.message}\n\n${frame}`;
    const formatted = new SyntaxError(msg);
    formatted.stack = msg;
    return formatted;
  }

  // Acorn parsed original fine — error is from plugin-injected code.
  // Fall back to sucrase's error with the transformed source.
  const loc = (err as any).loc as { line: number; column: number } | undefined;
  if (!loc) return err;

  const frame = buildCodeFrame(_transformedSrc, loc.line, loc.column);

  let coreMessage = err.message;
  const sucrasePrefix = `Error transforming ${filename}: `;
  if (coreMessage.startsWith(sucrasePrefix)) {
    coreMessage = coreMessage.slice(sucrasePrefix.length);
  }

  const msg = `${filename}: ${coreMessage}\n\n${frame}`;
  const formatted = new SyntaxError(msg);
  formatted.stack = msg;
  return formatted;
}
