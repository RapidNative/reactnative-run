import { transform } from "sucrase";
import type { RawSourceMap } from "../source-map.js";
import { Transformer } from "../types.js";

export const typescriptTransformer: Transformer = {
  transform({ src, filename }) {
    const ext = filename.slice(filename.lastIndexOf("."));
    const transforms: ("typescript" | "imports" | "jsx")[] = ["imports"];
    if (ext === ".ts" || ext === ".tsx") transforms.unshift("typescript");
    if (ext === ".tsx" || ext === ".jsx") transforms.push("jsx");
    const result = transform(src, {
      transforms,
      filePath: filename,
      sourceMapOptions: { compiledFilename: filename },
    });
    return {
      code: result.code,
      sourceMap: result.sourceMap as RawSourceMap | undefined,
    };
  },
};
