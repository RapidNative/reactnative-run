import type { BundlerPlugin } from "../types.js";

function isJSX(filename: string): boolean {
  return filename.endsWith(".tsx") || filename.endsWith(".jsx");
}

function isTagNameChar(c: number): boolean {
  return (
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) || // A-Z, a-z
    (c >= 48 && c <= 57) || // 0-9
    c === 95 ||
    c === 46
  ); // _, .
}

function isTagStartChar(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95; // A-Z, a-z, _
}

function isWordChar(c: number): boolean {
  return (
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) || // A-Z, a-z
    (c >= 48 && c <= 57) || // 0-9
    c === 95 ||
    c === 36
  ); // _, $
}

const JSX_KEYWORDS = new Set([
  "return",
  "yield",
  "default",
  "case",
  "throw",
  "new",
  "await",
]);

/**
 * Check if `<` at position `pos` is in a JSX context (not a comparison operator).
 * Looks backwards to find the preceding non-whitespace token and decides:
 * - After `)` or `]` -> comparison (e.g. `fn() < x`, `arr[0] < x`)
 * - After a word char -> comparison UNLESS the word is a JSX keyword (return, yield, etc.)
 * - After anything else (operators, brackets, =, etc.) -> JSX
 */
function isJsxContext(src: string, pos: number): boolean {
  let j = pos - 1;
  while (j >= 0) {
    const c = src.charCodeAt(j);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break;
    j--;
  }
  if (j < 0) return true; // start of file

  const c = src.charCodeAt(j);

  // After ) or ] -> likely comparison
  if (c === 41 || c === 93) return false;

  // After a word character -> check if it's a JSX-preceding keyword
  if (isWordChar(c)) {
    const end = j + 1;
    while (j >= 0 && isWordChar(src.charCodeAt(j))) j--;
    const word = src.slice(j + 1, end);
    return JSX_KEYWORDS.has(word);
  }

  // After anything else (operators, brackets, etc.) -> likely JSX
  return true;
}

/**
 * Scan import statements and return a map of imported binding name → source path.
 * Handles: named, default, namespace, and mixed imports.
 *   import { A, B as C } from "foo"     -> A→foo, C→foo
 *   import D from "foo"                  -> D→foo
 *   import * as N from "foo"             -> N→foo
 *   import D, { A } from "foo"           -> D→foo, A→foo
 */
function extractImports(src: string): Map<string, string> {
  const map = new Map<string, string>();
  // Match `import ... from "source"` (handles single & double quotes)
  const importRe = /import\s+([^"';]+?)\s+from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(src)) !== null) {
    const clause = m[1].trim();
    const source = m[2];
    // Default + named: `D, { A, B as C }` or just `D` or just `{ A, B }` or `* as N`
    // Split off default first
    let rest = clause;
    // Namespace: `* as Name`
    const nsMatch = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(rest);
    if (nsMatch) {
      map.set(nsMatch[1], source);
      continue;
    }
    // Default + optional named: `Name` or `Name, { ... }`
    const defaultMatch = /^([A-Za-z_$][\w$]*)\s*(?:,\s*(\{[^}]*\}))?$/.exec(rest);
    if (defaultMatch) {
      map.set(defaultMatch[1], source);
      if (defaultMatch[2]) rest = defaultMatch[2];
      else continue;
    }
    // Named only: `{ A, B as C }`
    const namedMatch = /^\{([^}]*)\}$/.exec(rest);
    if (namedMatch) {
      const items = namedMatch[1].split(",");
      for (const item of items) {
        const trimmed = item.trim();
        if (!trimmed) continue;
        // Handle `A as B`
        const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(trimmed);
        if (asMatch) {
          map.set(asMatch[2], source);
        } else {
          const nameMatch = /^([A-Za-z_$][\w$]*)$/.exec(trimmed);
          if (nameMatch) map.set(nameMatch[1], source);
        }
      }
    }
  }
  return map;
}

/**
 * Decide whether to inject `dataSet` for a component imported from `source`.
 * - Local imports (./, ../, /, @/) → inject
 * - react-native, react-native-web → inject
 * - gluestack-ui packages (@gluestack-ui/*, @gluestack-style/*) → inject
 * - Anything else (third-party packages) → skip to avoid prop collisions
 *   (e.g. `react-native-gifted-charts` uses `dataSet` as its own prop)
 */
function shouldInjectForSource(source: string): boolean {
  if (source.startsWith(".") || source.startsWith("/") || source.startsWith("@/")) {
    return true;
  }
  if (source === "react-native" || source === "react-native-web") {
    return true;
  }
  if (source.startsWith("@gluestack-ui/") || source.startsWith("@gluestack-style/")) {
    return true;
  }
  return false;
}

function injectDataBxPath(src: string, filename: string): string {
  const imports = extractImports(src);
  const len = src.length;
  let result = "";
  let i = 0;
  let line = 1;
  let col = 1;
  // State: 0=normal, 1=single-quote, 2=double-quote, 3=template, 4=line-comment, 5=block-comment
  let state = 0;

  while (i < len) {
    const cc = src.charCodeAt(i);

    // Handle escape sequences in strings/template literals
    if ((state === 1 || state === 2 || state === 3) && cc === 92) {
      // backslash
      result += src[i];
      i++;
      col++;
      if (i < len) {
        result += src[i];
        if (src.charCodeAt(i) === 10) {
          line++;
          col = 1;
        } else {
          col++;
        }
        i++;
      }
      continue;
    }

    if (state === 0) {
      if (cc === 39) {
        state = 1; // '
      } else if (cc === 34) {
        state = 2; // "
      } else if (cc === 96) {
        state = 3; // `
      } else if (cc === 47 && i + 1 < len) {
        // /
        const next = src.charCodeAt(i + 1);
        if (next === 47) {
          state = 4; // //
        } else if (next === 42) {
          state = 5; // /*
        }
      } else if (
        cc === 60 &&
        i + 1 < len &&
        isTagStartChar(src.charCodeAt(i + 1))
      ) {
        // Potential JSX: < followed by [A-Za-z_]
        if (isJsxContext(src, i)) {
          const tagLine = line;
          const tagCol = col;

          // Emit '<'
          result += "<";
          i++;
          col++;

          // Extract tag name (supports dotted: Motion.div)
          let tagName = "";
          while (i < len && isTagNameChar(src.charCodeAt(i))) {
            tagName += src[i];
            result += src[i];
            i++;
            col++;
          }

          // Skip fragments and generics
          const nextCc = i < len ? src.charCodeAt(i) : 0;
          const isFragment =
            tagName === "Fragment" || tagName === "React.Fragment";
          const isGeneric = nextCc === 60; // followed by <

          if (!isFragment && !isGeneric && tagName.length > 0) {
            const pathVal = filename + ":" + tagLine + ":" + tagCol;
            const firstChar = tagName.charCodeAt(0);
            // Lowercase tags (HTML elements): use data- attribute (React passes it to DOM)
            if (firstChar >= 97 && firstChar <= 122) {
              result += ' data-bx-path="' + pathVal + '"';
            } else {
              // Uppercase/dotted tags (components): inject `dataSet` only for
              // local imports and react-native(-web) components. Third-party
              // packages may use `dataSet` as their own prop (e.g. gifted-charts).
              // For dotted tags like `Motion.View`, check the root identifier.
              const rootName = tagName.split(".")[0];
              const importSource = imports.get(rootName);
              // If not in import map, it's a local definition (function in the
              // same file) or React.X — safe to inject.
              const isLocal = importSource === undefined || shouldInjectForSource(importSource);
              if (isLocal) {
                result += ' dataSet={{"bx-path":"' + pathVal + '"}}';
              }
            }
          }

          continue;
        }
      }
    } else if (state === 1) {
      if (cc === 39) state = 0;
    } else if (state === 2) {
      if (cc === 34) state = 0;
    } else if (state === 3) {
      if (cc === 96) state = 0;
    } else if (state === 4) {
      if (cc === 10) state = 0;
    } else if (state === 5) {
      if (cc === 42 && i + 1 < len && src.charCodeAt(i + 1) === 47) {
        // */
        result += "*/";
        col += 2;
        i += 2;
        state = 0;
        continue;
      }
    }

    result += src[i];
    if (cc === 10) {
      line++;
      col = 1;
    } else {
      col++;
    }
    i++;
  }

  return result;
}

export function createDataBxPathPlugin(): BundlerPlugin {
  return {
    name: "data-bx-path",
    transformSource({ src, filename }) {
      if (!isJSX(filename)) return null;
      return { src: injectDataBxPath(src, filename) };
    },
  };
}
