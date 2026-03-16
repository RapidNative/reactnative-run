import type { FileMap, ContentChange } from "almostmetro";

type Listener = () => void;

/**
 * Imperative file store that is the single source of truth for project files.
 *
 * - Writes are immediate (no React render cycle involved)
 * - Dirty changes are debounced and flushed to the worker automatically
 * - Can be written to from any source: UI keystrokes, server responses, etc.
 * - subscribe() enables React (or anything else) to react to changes
 */
export class EditorFS {
  private files: FileMap;
  private dirty = new Map<string, ContentChange>();
  private listeners = new Set<Listener>();
  private worker: Worker | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private _watchMode = false;
  private debounceMs: number;

  constructor(files: FileMap, debounceMs = 300) {
    this.files = { ...files };
    this.debounceMs = debounceMs;
  }

  // --- File operations ---

  read(path: string): string | undefined {
    const entry = this.files[path];
    if (entry === undefined) return undefined;
    return entry.content;
  }

  write(path: string, content: string): void {
    // Skip if content hasn't actually changed
    const entry = this.files[path];
    if (entry && entry.content === content) return;

    const existed = path in this.files;
    this.files[path] = { content, isExternal: false };
    this.dirty.set(path, {
      path,
      type: existed ? "update" : "create",
      content,
    });
    if (this._watchMode) this.scheduleFlush();
    this.notify();
  }

  delete(path: string): void {
    if (!(path in this.files)) return;
    delete this.files[path];
    this.dirty.set(path, { path, type: "delete" });
    if (this._watchMode) this.scheduleFlush();
    this.notify();
  }

  exists(path: string): boolean {
    return path in this.files;
  }

  list(): string[] {
    return Object.keys(this.files);
  }

  toFileMap(): FileMap {
    return { ...this.files };
  }

  /** Replace all files (project switch). Clears dirty state. */
  replaceAll(files: FileMap): void {
    this.files = { ...files };
    this.dirty.clear();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.notify();
  }

  // --- Worker sync ---

  setWorker(worker: Worker | null): void {
    this.worker = worker;
  }

  get watchMode(): boolean {
    return this._watchMode;
  }

  setWatchMode(enabled: boolean): void {
    this._watchMode = enabled;
    if (!enabled) {
      this.dirty.clear();
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), this.debounceMs);
  }

  /** Send all accumulated dirty changes to the worker immediately. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const changes = [...this.dirty.values()];
    this.dirty.clear();
    if (changes.length > 0 && this.worker && this._watchMode) {
      this.worker.postMessage({ type: "watch-update", changes });
    }
  }

  get pendingChanges(): number {
    return this.dirty.size;
  }

  // --- Subscription (useSyncExternalStore-compatible) ---

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }
}
