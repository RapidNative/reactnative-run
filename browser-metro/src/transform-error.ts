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
  const acornErr = tryAcornParse(originalSrc);
  if (acornErr) {
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
