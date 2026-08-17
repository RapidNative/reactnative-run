import { transform } from "sucrase";
import type { RawSourceMap } from "../source-map.js";
import { Transformer } from "../types.js";

export interface TypescriptTransformerOptions {
  /**
   * "classic" (default) emits React.createElement; "automatic" emits
   * jsx()/jsxs() calls importing from `<jsxImportSource>/jsx-runtime`.
   * nativewind needs automatic with jsxImportSource "nativewind" so its
   * runtime sees className props on native.
   */
  jsxRuntime?: "classic" | "automatic";
  jsxImportSource?: string;
}

export function createTypescriptTransformer(
  options: TypescriptTransformerOptions = {},
): Transformer {
  return {
    transform({ src, filename }) {
      const ext = filename.slice(filename.lastIndexOf("."));
      const transforms: ("typescript" | "imports" | "jsx")[] = ["imports"];
      if (ext === ".ts" || ext === ".tsx") transforms.unshift("typescript");
      if (ext === ".tsx" || ext === ".jsx") transforms.push("jsx");
      const result = transform(src, {
        transforms,
        filePath: filename,
        ...(options.jsxRuntime === "automatic"
          ? {
              jsxRuntime: "automatic" as const,
              // production: use jsx-runtime, not jsx-dev-runtime (whose jsxDEV
              // signature needs babel-style source metadata we don't emit).
              production: true,
              ...(options.jsxImportSource ? { jsxImportSource: options.jsxImportSource } : {}),
            }
          : {}),
        sourceMapOptions: { compiledFilename: filename },
      });
      return {
        code: result.code,
        sourceMap: result.sourceMap as RawSourceMap | undefined,
      };
    },
  };
}

export const typescriptTransformer: Transformer = createTypescriptTransformer();
