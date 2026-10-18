import type { ServerResponse } from "node:http";

/**
 * Metro's multipart bundle response (metro/src/Server/MultipartResponse.js).
 *
 * React Native asks for a bundle with `Accept: multipart/mixed`. Metro answers
 * at once and writes JSON progress parts while it builds, then the bundle as
 * the last part, whose `X-Http-Status` header carries the real status. The
 * device shows each part's `status` on its loading screen, and the bytes keep
 * the connection alive: a silent request is dropped by the device after about
 * a minute, and by proxies in front of us (Cloudflare gives up at 100s), while
 * a cold native build waiting on the package server takes minutes.
 */
const CRLF = "\r\n";
const BOUNDARY = "3beqjf3apnqeu3h5jqorms4i";

export function acceptsMultipart(accept: string | undefined): boolean {
  return (accept || "").includes("multipart/mixed");
}

export interface MultipartResponse {
  /** A progress part: the device shows `status` (and a percentage only when done/total are sent). */
  progress(status: string): void;
  /** The last part: the response the client would have got without multipart. */
  end(status: number, headers: Record<string, string | number>, body: string): void;
}

export function startMultipart(res: ServerResponse): MultipartResponse {
  res.writeHead(200, { "Content-Type": `multipart/mixed; boundary="${BOUNDARY}"`, "Cache-Control": "no-cache" });
  res.write("If you are seeing this, your client does not support multipart response");
  const part = (headers: Record<string, string | number>, data: string, last: boolean) => {
    if (res.writableEnded) return;
    const head = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join(CRLF);
    res.write(`${CRLF}--${BOUNDARY}${CRLF}${head}${CRLF}${CRLF}${data}`);
    if (last) res.write(`${CRLF}--${BOUNDARY}--${CRLF}`);
  };
  return {
    progress(status) {
      part({ "Content-Type": "application/json" }, JSON.stringify({ status }), false);
    },
    end(status, headers, body) {
      part({ ...headers, "X-Http-Status": status, "Content-Length": Buffer.byteLength(body) }, body, true);
      res.end();
    },
  };
}
