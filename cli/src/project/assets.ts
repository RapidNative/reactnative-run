/**
 * Binary/asset files are never read into memory: the scanner marks them
 * isExternal in the FileMap (empty content) and the server streams their
 * bytes straight from disk. This is the single biggest memory lever besides
 * not running Metro.
 */
export const ASSET_RE =
  /\.(png|jpe?g|gif|svg|webp|avif|heic|bmp|ico|ttf|otf|woff2?|eot|mp[34]|m4a|mov|webm|wav|aac|ogg|pdf|zip|db|bin)$/i;

export function isAssetPath(path: string): boolean {
  return ASSET_RE.test(path);
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  avif: "image/avif",
  heic: "image/heic",
  bmp: "image/bmp",
  ico: "image/x-icon",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  eot: "application/vnd.ms-fontobject",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  aac: "audio/aac",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  pdf: "application/pdf",
  zip: "application/zip",
  json: "application/json",
  js: "application/javascript",
  map: "application/json",
  css: "text/css",
  html: "text/html",
};

export function mimeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  return MIME[ext] || "application/octet-stream";
}

/**
 * Sniff image dimensions from a buffer (PNG / JPEG / GIF headers only --
 * enough for RN Image layout; other types just get a hash).
 */
export function imageDimensions(buf: Buffer): { width: number; height: number } | null {
  // PNG: 8-byte signature, IHDR at offset 16 (width) / 20 (height), big-endian.
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF: "GIF8" then width/height little-endian at 6/8.
  if (buf.length > 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // JPEG: walk markers to the first SOFn frame header.
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      const len = buf.readUInt16BE(off + 2);
      off += 2 + len;
    }
  }
  return null;
}
