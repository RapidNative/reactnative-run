/**
 * Stable numeric module ids for Metro-format bundles.
 *
 * Metro's HMR contract needs ids that are stable for the lifetime of a
 * bundler session: an updated module is re-registered under the SAME id, and
 * ids of deleted modules are never reused (a reused id would alias an old
 * module's inverse-dependency state inside metro-runtime). Matches the
 * semantics of Metro's per-server createModuleIdFactory.
 */
export class ModuleIdRegistry {
  private ids = new Map<string, number>();
  private next = 0;

  /** Get (or assign) the id for a module key (VFS path or npm specifier). */
  idFor(key: string): number {
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.next++;
      this.ids.set(key, id);
    }
    return id;
  }

  has(key: string): boolean {
    return this.ids.has(key);
  }

  /** Known key -> id pairs (for symbolication / debugging). */
  entries(): Array<[string, number]> {
    return [...this.ids.entries()];
  }
}
