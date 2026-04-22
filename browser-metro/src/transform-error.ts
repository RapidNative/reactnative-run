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
 * Skip a brace-balanced block starting at `pos` (which points to `{`).
 * Returns the index after the matching `}` and the number of newlines inside.
 */
function skipBraceBlock(src: string, pos: number): { end: number; newlines: number } {
  let depth = 0;
  let newlines = 0;
  let i = pos;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { i++; break; } }
    else if (ch === "\n") newlines++;
    i++;
  }
  // Skip optional trailing semicolon
  if (i < src.length && src[i] === ";") i++;
  return { end: i, newlines };
}

/**
 * Lightweight removal of TypeScript-only syntax so Acorn (JS-only)
 * can parse the rest of the file for accurate error locations.
 *
 * Uses brace-balanced scanning for multi-line type/interface blocks,
 * then regex passes for inline annotations. Replaces removed regions
 * with newlines to preserve line numbers.
 */
function stripTSForAcorn(src: string): string {
  // Pass 1: character-by-character scan to remove type/interface declarations
  let result = "";
  let i = 0;

  while (i < src.length) {
    const lineStart = i === 0 || src[i - 1] === "\n";
    if (lineStart) {
      const declMatch = /^(export\s+)?(type|interface)\s+[A-Za-z_$]/.exec(src.slice(i));
      if (declMatch) {
        const kind = declMatch[2];
        let j = i;
        let newlines = 0;

        // Scan forward to find `{` or end of line
        while (j < src.length && src[j] !== "{" && src[j] !== "\n") j++;

        if (j < src.length && src[j] === "{") {
          // Multi-line block: type X = { ... } or interface X { ... }
          for (let k = i; k < j; k++) if (src[k] === "\n") newlines++;
          const block = skipBraceBlock(src, j);
          newlines += block.newlines;
          result += "\n".repeat(newlines);
          i = block.end;
          if (i < src.length && src[i] === "\n") { result += "\n"; i++; }
          continue;
        } else if (kind === "type") {
          // Single-line type alias: type X = number | string;
          let end = i;
          while (end < src.length && src[end] !== "\n") end++;
          result += "\n";
          i = end;
          continue;
        }
        // interface without { on same line — scan forward for it
        if (kind === "interface") {
          let newlines2 = 0;
          while (j < src.length && src[j] !== "{") {
            if (src[j] === "\n") newlines2++;
            j++;
          }
          if (j < src.length && src[j] === "{") {
            for (let k = i; k < j; k++) if (src[k] === "\n") newlines2++;
            const block = skipBraceBlock(src, j);
            newlines2 += block.newlines;
            result += "\n".repeat(newlines2);
            i = block.end;
            if (i < src.length && src[i] === "\n") { result += "\n"; i++; }
            continue;
          }
        }
      }
    }
    result += src[i];
    i++;
  }

  // Pass 2: strip brace-balanced type annotations on destructured params (}: { ... })
  let pass2 = "";
  for (let j = 0; j < result.length; j++) {
    pass2 += result[j];
    if ((result[j] === "}" || result[j] === "]") && j + 1 < result.length) {
      let k = j + 1;
      while (k < result.length && (result[k] === " " || result[k] === "\n" || result[k] === "\t")) k++;
      if (k < result.length && result[k] === ":") {
        k++;
        while (k < result.length && (result[k] === " " || result[k] === "\n" || result[k] === "\t")) k++;
        if (k < result.length && result[k] === "{") {
          const block = skipBraceBlock(result, k);
          let nl = 0;
          for (let m = j + 1; m < block.end; m++) if (result[m] === "\n") nl++;
          pass2 += "\n".repeat(nl);
          j = block.end - 1;
          continue;
        }
      }
    }
  }
  result = pass2;

  // Pass 3: regex for remaining inline TS syntax

  // Remove type annotations: `: SomeType` before `=`, `,`, `;`, `)`, `}`, `]`
  result = result.replace(/(?<=[\w$)\]?])\s*:\s*(?:readonly\s+)?[A-Za-z_$][\w$<>\[\]|&,\s]*(?=\s*[=,;)}\]])/g, "");

  // Remove `as Type` casts
  result = result.replace(/\s+as\s+[A-Za-z_$][\w$<>\[\]|&]*/g, "");

  // Remove generic type params on arrow functions: `<T,>`, `<T extends X>`
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
