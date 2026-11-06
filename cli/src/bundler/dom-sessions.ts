import { VirtualFS } from "browser-metro";
import type { ContentChange, FileMap } from "browser-metro";
import type { BundlerSession } from "./session.js";
import { hasUseDomDirective, isDomComponentCandidate } from "./dom-components.js";

/**
 * One web bundler session per Expo DOM component, built on the first request
 * for its page (a WebView in the app opening it) and kept in step with edits.
 *
 * Holds its own copy of the project files: a session created after an edit
 * must see that edit, and the app's web session can't be relied on for that
 * (it may never have been built, and it writes synthetic files of its own).
 */
export class DomComponentSessions {
  private vfs: VirtualFS;
  private sessions = new Map<string, Promise<BundlerSession>>();
  /** The edit currently being applied; a page request waits it out. */
  private updating: Promise<void> = Promise.resolve();
  private listeners = new Set<(vfsPath: string) => void>();

  constructor(
    files: FileMap,
    /** Makes a web session that bundles `domEntry` from `files`. */
    private makeSession: (domEntry: string, files: FileMap) => BundlerSession,
    private log: (msg: string) => void = () => {}
  ) {
    this.vfs = new VirtualFS(files);
  }

  /** True when `vfsPath` is a "use dom" module of the project as it is now. */
  isDomComponent(vfsPath: string): boolean {
    if (!isDomComponentCandidate(vfsPath)) return false;
    const src = this.vfs.read(vfsPath);
    return !!src && hasUseDomDirective(src);
  }

  /** Called with a DOM component's path when its page must reload. */
  onChange(fn: (vfsPath: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(vfsPath: string): void {
    for (const fn of this.listeners) fn(vfsPath);
  }

  /** The built session for a DOM component, or null when the path isn't one. */
  async get(vfsPath: string): Promise<BundlerSession | null> {
    await this.updating;
    if (!this.isDomComponent(vfsPath)) return null;
    let pending = this.sessions.get(vfsPath);
    if (!pending) {
      const session = this.makeSession(vfsPath, this.vfs.toFileMap());
      const started = performance.now();
      pending = session.ensureBuilt().then((ok) => {
        this.log(
          ok
            ? `[dom] bundled ${vfsPath} in ${Math.round(performance.now() - started)}ms (${(session.getBundle().length / 1024).toFixed(0)} KB)`
            : `[dom] build of ${vfsPath} failed:\n${session.buildError}`
        );
        return session;
      });
      this.sessions.set(vfsPath, pending);
    }
    const session = await pending;
    // A failed first build (package server down, a syntax error) is served as
    // an error page; the next request tries again rather than replaying it.
    if (!session.getBundle() && this.sessions.get(vfsPath) === pending) this.sessions.delete(vfsPath);
    return session;
  }

  /** The paths of the DOM components a page has asked for. */
  livePaths(): string[] {
    return [...this.sessions.keys()];
  }

  /**
   * Apply file changes: to the file copy now (so a session made from here on
   * sees them), then to every live session. A page whose bundle changed, or
   * whose module stopped being a DOM component, is told to reload.
   */
  applyChanges(changes: ContentChange[]): Promise<void> {
    if (changes.length === 0) return this.updating;
    for (const c of changes) {
      if (c.type === "delete") this.vfs.delete(c.path);
      else this.vfs.write(c.path, c.content ?? "");
    }
    const run = this.updating.then(async () => {
      for (const [vfsPath, pending] of [...this.sessions]) {
        if (!this.isDomComponent(vfsPath)) {
          this.sessions.delete(vfsPath);
          this.notify(vfsPath);
          continue;
        }
        const session = await pending;
        const before = session.getBundle();
        const hadError = session.buildError;
        await session.applyChanges(changes);
        if (session.getBundle() !== before || session.buildError !== hadError) this.notify(vfsPath);
      }
    });
    this.updating = run.catch((err) => {
      this.log(`[dom] rebuild failed: ${(err as Error)?.stack || err}`);
    });
    return this.updating;
  }

  /** A re-init: new files, every session dropped, every open page reloaded. */
  reset(files: FileMap): void {
    const live = this.livePaths();
    this.vfs = new VirtualFS(files);
    this.sessions.clear();
    this.updating = Promise.resolve();
    for (const p of live) this.notify(p);
  }
}
