import { randomUUID } from "node:crypto";

/**
 * Which bundle each device is running.
 *
 * Numeric module ids are minted per BundlerSession as modules are first seen,
 * so a device holds the id space of the exact bundle it loaded. Anything that
 * produces a session it didn't load from -- a package.json re-init, a process
 * restart, the lazy graph build after a cache-hit serve -- numbers the same
 * files differently, and Fast Refresh patches from that session make the
 * device `require` ids it never defined ("Requiring unknown module"). The
 * same goes for patches it simply missed: a device is deaf between fetching a
 * bundle and registering on /hot, and an `added` module it never received is
 * unknown forever.
 *
 * Metro solves this with revisions keyed by the bundle URL. rnrun does the
 * same with one extra query parameter: every manifest mints a client token
 * into launchAsset.url, the bundle route records (epoch, version) against it
 * when it serves, and both the /hot handshake and the in-bundle dev client
 * carry the token back (Expo Go registers on /hot with the full bundle URL,
 * and SourceCode.scriptURL is that same URL). A reload re-fetches the same
 * URL, so the record simply updates -- no reload loops.
 */
export const CLIENT_TOKEN_PARAM = "rnrunClient";

export interface ServedBundle {
  platform: string;
  /** BundlerSession.epoch of the session whose bundle was served. */
  epoch: string;
  /** BundlerSession.bundleVersion at serve time. */
  version: number;
  at: number;
}

export function newClientToken(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

/** The client token carried by a bundle / entrypoint URL, if any. */
export function clientTokenFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url, "http://localhost").searchParams.get(CLIENT_TOKEN_PARAM);
  } catch {
    return null;
  }
}

/** The platform a bundle / entrypoint URL asks for, if any. */
export function platformFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url, "http://localhost").searchParams.get("platform");
  } catch {
    return null;
  }
}

const MAX_CLIENTS = 256;

export class ClientRegistry {
  private served = new Map<string, ServedBundle>();

  /** Remember what was just served for this token (latest wins). */
  record(token: string, info: Omit<ServedBundle, "at">): void {
    // Re-insert so Map order is LRU-ish for the trim below.
    this.served.delete(token);
    this.served.set(token, { ...info, at: Date.now() });
    if (this.served.size > MAX_CLIENTS) {
      const oldest = this.served.keys().next().value;
      if (oldest !== undefined) this.served.delete(oldest);
    }
  }

  get(token: string): ServedBundle | null {
    return this.served.get(token) ?? null;
  }

  size(): number {
    return this.served.size;
  }
}
