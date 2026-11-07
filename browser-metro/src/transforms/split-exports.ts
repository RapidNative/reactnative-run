import { Parser } from "acorn";
import { tsPlugin } from "@sveltejs/acorn-typescript";

// sucrase (3.35.1, the latest) compiles an export with several declarators wrong:
//
//   export const A = 1, B = 2;   →   const A = 1; exports.A = A, B = 2;
//
// Only the first name is exported; B is assigned as a stray global (or throws in strict
// mode), so `import { B }` is undefined. Destructuring (`export const { a } = o, [c] = x`)
// loses the later declarators the same way. Metro/Babel compile it correctly, so code that
// works in a local `expo start` broke only on rnrun (ValueX's charts kit, Nov 2026:
// "Cannot read property 'displayName' of undefined"). This pre-pass rewrites each such
// statement into one `export` per declarator before sucrase sees it:
//
//   export const A = 1; export const B = 2;
//
// Only the separating commas change, so line numbers (and nearly all columns) are kept.

const TSParser = Parser.extend(tsPlugin({ jsx: true }) as any);

/**
 * Cheap gate: does some `export const|let|var` statement have a comma outside brackets
 * before it ends? False positives only cost a parse; a miss leaves the file as it was.
 */
function mayHaveMultiExport(src: string): boolean {
  const re = /\bexport\s+(?:const|let|var)\s/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 0;
    for (let i = m.index + m[0].length; i < src.length; i++) {
      const c = src[i];
      if (c === '"' || c === "'" || c === "`") {
        for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
      } else if (c === "/" && src[i + 1] === "/") {
        while (i < src.length && src[i] !== "\n") i++;
      } else if (c === "/" && src[i + 1] === "*") {
        const end = src.indexOf("*/", i + 2);
        i = end < 0 ? src.length : end + 1;
      } else if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (--depth < 0) break;
      } else if (depth === 0 && c === ",") return true;
      else if (depth === 0 && c === ";") break;
      else if (depth === 0 && c === "\n") {
        // a statement ends at a newline unless the next line continues it
        const rest = src.slice(i + 1).match(/^\s*(\S)/);
        if (!rest || !/[,.?:+\-*/%&|=<>]/.test(rest[1])) break;
      }
    }
  }
  return false;
}

/** Index of the first comma in src[from, to) outside comments. */
function commaBetween(src: string, from: number, to: number): number {
  for (let i = from; i < to; i++) {
    if (src[i] === "/" && src[i + 1] === "/") {
      while (i < to && src[i] !== "\n") i++;
    } else if (src[i] === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? to : end + 1;
    } else if (src[i] === ",") return i;
  }
  return -1;
}

export function splitMultiDeclaratorExports(src: string): string {
  if (!mayHaveMultiExport(src)) return src;
  let ast: any;
  try {
    ast = TSParser.parse(src, { sourceType: "module", ecmaVersion: "latest", locations: true } as any);
  } catch {
    return src; // sucrase reports the syntax error itself
  }
  const edits: { at: number; text: string }[] = [];
  for (const node of ast.body) {
    const decl = node.type === "ExportNamedDeclaration" ? node.declaration : null;
    if (!decl || decl.type !== "VariableDeclaration" || decl.declarations.length < 2 || decl.declare) continue;
    for (let k = 1; k < decl.declarations.length; k++) {
      const at = commaBetween(src, decl.declarations[k - 1].end, decl.declarations[k].start);
      if (at < 0) return src;
      edits.push({ at, text: `; export ${decl.kind}` });
    }
  }
  if (!edits.length) return src;
  let out = src;
  for (const e of edits.reverse()) out = out.slice(0, e.at) + e.text + out.slice(e.at + 1);
  return out;
}
