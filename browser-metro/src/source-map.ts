/** Source map v3 interface */
export interface RawSourceMap {
  version: number;
  file?: string;
  sources: string[];
  sourcesContent?: string[];
  mappings: string;
  names: string[];
}

/**
 * Decoded segment: either [genCol] (unmapped) or
 * [genCol, srcIdx, origLine, origCol] or
 * [genCol, srcIdx, origLine, origCol, nameIdx]
 */
export type Segment =
  | [number]
  | [number, number, number, number]
  | [number, number, number, number, number];

const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_DECODE: number[] = new Array(128).fill(-1);
for (let i = 0; i < BASE64.length; i++) BASE64_DECODE[BASE64.charCodeAt(i)] = i;

export function encodeVLQ(value: number): string {
  let vlq = value < 0 ? (-value << 1) | 1 : value << 1;
  let result = "";
  do {
    let digit = vlq & 0x1f;
    vlq >>>= 5;
    if (vlq > 0) digit |= 0x20;
    result += BASE64[digit];
  } while (vlq > 0);
  return result;
}

export function decodeVLQ(
  str: string,
  offset: number,
): { value: number; next: number } {
  let result = 0;
  let shift = 0;
  let continuation: boolean;
  let i = offset;
  do {
    const digit = BASE64_DECODE[str.charCodeAt(i++)];
    continuation = (digit & 0x20) !== 0;
    result += (digit & 0x1f) << shift;
    shift += 5;
  } while (continuation);
  const isNegative = (result & 1) !== 0;
  result >>= 1;
  return { value: isNegative ? -result : result, next: i };
}

export function decodeMappings(mappings: string): Segment[][] {
  const lines: Segment[][] = [];
  let srcIdx = 0;
  let origLine = 0;
  let origCol = 0;
  let nameIdx = 0;

  for (const lineStr of mappings.split(";")) {
    const segments: Segment[] = [];
    let genCol = 0;
    if (lineStr) {
      for (const segStr of lineStr.split(",")) {
        if (!segStr) continue;
        let pos = 0;
        const fields: number[] = [];
        while (pos < segStr.length) {
          const { value, next } = decodeVLQ(segStr, pos);
          fields.push(value);
          pos = next;
        }
        if (fields.length >= 4) {
          genCol += fields[0];
          srcIdx += fields[1];
          origLine += fields[2];
          origCol += fields[3];
          if (fields.length >= 5) {
            nameIdx += fields[4];
            segments.push([genCol, srcIdx, origLine, origCol, nameIdx]);
          } else {
            segments.push([genCol, srcIdx, origLine, origCol]);
          }
        } else if (fields.length >= 1) {
          genCol += fields[0];
          segments.push([genCol]);
        }
      }
    }
    lines.push(segments);
  }

  return lines;
}

export function encodeMappings(decoded: Segment[][]): string {
  let prevSrcIdx = 0;
  let prevOrigLine = 0;
  let prevOrigCol = 0;
  let prevNameIdx = 0;

  const lineStrs: string[] = [];
  for (const segments of decoded) {
    let prevGenCol = 0;
    const segStrs: string[] = [];
    for (const seg of segments) {
      let result = encodeVLQ(seg[0] - prevGenCol);
      prevGenCol = seg[0];
      if (seg.length >= 4) {
        result += encodeVLQ((seg as [number, number, number, number])[1] - prevSrcIdx);
        prevSrcIdx = (seg as [number, number, number, number])[1];
        result += encodeVLQ((seg as [number, number, number, number])[2] - prevOrigLine);
        prevOrigLine = (seg as [number, number, number, number])[2];
        result += encodeVLQ((seg as [number, number, number, number])[3] - prevOrigCol);
        prevOrigCol = (seg as [number, number, number, number])[3];
        if (seg.length >= 5) {
          result += encodeVLQ(
            (seg as [number, number, number, number, number])[4] - prevNameIdx,
          );
          prevNameIdx = (seg as [number, number, number, number, number])[4];
        }
      }
      segStrs.push(result);
    }
    lineStrs.push(segStrs.join(","));
  }

  return lineStrs.join(";");
}

export interface ModuleSourceMapInput {
  sourceFile: string;
  sourceContent: string;
  map: RawSourceMap;
  generatedLineOffset: number;
}

export function buildCombinedSourceMap(
  modules: ModuleSourceMapInput[],
): RawSourceMap {
  const sources: string[] = [];
  const sourcesContent: string[] = [];
  const names: string[] = [];
  const allLines: Segment[][] = [];

  for (const mod of modules) {
    const sourceIndex = sources.length;
    sources.push(mod.sourceFile);
    sourcesContent.push(mod.sourceContent);

    const nameOffset = names.length;
    if (mod.map.names) {
      names.push(...mod.map.names);
    }

    const decoded = decodeMappings(mod.map.mappings);

    for (let i = 0; i < decoded.length; i++) {
      const lineIdx = mod.generatedLineOffset + i;
      while (allLines.length <= lineIdx) {
        allLines.push([]);
      }
      for (const seg of decoded[i]) {
        if (seg.length >= 4) {
          let remapped: Segment;
          if (seg.length === 5) {
            remapped = [seg[0], sourceIndex, seg[2], seg[3], seg[4] + nameOffset];
          } else {
            remapped = [seg[0], sourceIndex, (seg as [number, number, number, number])[2], (seg as [number, number, number, number])[3]];
          }
          allLines[lineIdx].push(remapped);
        } else {
          allLines[lineIdx].push(seg);
        }
      }
    }
  }

  return {
    version: 3,
    sources,
    sourcesContent,
    names,
    mappings: encodeMappings(allLines),
  };
}

function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function inlineSourceMap(map: RawSourceMap): string {
  return (
    "//# sourceMappingURL=data:application/json;base64," +
    toBase64(JSON.stringify(map))
  );
}

/**
 * Shift all origLine values in a source map by `lineOffset`.
 * Use negative offset to compensate for lines prepended by plugins.
 */
export function shiftSourceMapOrigLines(
  map: RawSourceMap,
  lineOffset: number,
): RawSourceMap {
  const decoded = decodeMappings(map.mappings);
  for (const line of decoded) {
    for (const seg of line) {
      if (seg.length >= 4) {
        (seg as [number, number, number, number])[2] += lineOffset;
      }
    }
  }
  return {
    ...map,
    mappings: encodeMappings(decoded),
  };
}

export function countNewlines(s: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) count++;
  }
  return count;
}
