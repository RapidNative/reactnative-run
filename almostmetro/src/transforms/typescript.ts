import { transform } from "sucrase";
import { Transformer } from "../types.js";

export const typescriptTransformer: Transformer = {
  transform({ src, filename }) {
    const ext = filename.slice(filename.lastIndexOf("."));
    const transforms: ("typescript" | "imports" | "jsx")[] = ["imports"];
    if (ext === ".ts" || ext === ".tsx") transforms.unshift("typescript");
    if (ext === ".tsx" || ext === ".jsx") transforms.push("jsx");
    return transform(src, { transforms });
  },
};
