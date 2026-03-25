interface ModuleNode {
  localDeps: Set<string>;
  npmDeps: Set<string>;
}

export class DependencyGraph {
  /** Forward edges: module -> its dependencies */
  private nodes: Map<string, ModuleNode> = new Map();
  /** Reverse edges: module -> modules that depend on it */
  private reverseDeps: Map<string, Set<string>> = new Map();

  /** Add or update a module's dependencies. Diffs against old deps to keep reverse edges in sync. */
  setModule(id: string, localDeps: string[], npmDeps: string[]): void {
    const newLocalSet = new Set(localDeps);
    const newNpmSet = new Set(npmDeps);
    const existing = this.nodes.get(id);

    if (existing) {
      // Remove stale reverse edges for local deps that are no longer referenced
      for (const oldDep of existing.localDeps) {
        if (!newLocalSet.has(oldDep)) {
          this.reverseDeps.get(oldDep)?.delete(id);
        }
      }
      // Remove stale reverse edges for npm deps
      for (const oldDep of existing.npmDeps) {
        if (!newNpmSet.has(oldDep)) {
          this.reverseDeps.get(oldDep)?.delete(id);
        }
      }
    }

    // Add new reverse edges
    for (const dep of newLocalSet) {
      if (!this.reverseDeps.has(dep)) {
        this.reverseDeps.set(dep, new Set());
      }
      this.reverseDeps.get(dep)!.add(id);
    }
    for (const dep of newNpmSet) {
      if (!this.reverseDeps.has(dep)) {
        this.reverseDeps.set(dep, new Set());
      }
      this.reverseDeps.get(dep)!.add(id);
    }

    this.nodes.set(id, { localDeps: newLocalSet, npmDeps: newNpmSet });
  }

  removeModule(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;

    // Remove forward edges from reverse map
    for (const dep of node.localDeps) {
      this.reverseDeps.get(dep)?.delete(id);
    }
    for (const dep of node.npmDeps) {
      this.reverseDeps.get(dep)?.delete(id);
    }

    // Remove reverse edges pointing to this module
    this.reverseDeps.delete(id);

    this.nodes.delete(id);
  }

  hasModule(id: string): boolean {
    return this.nodes.has(id);
  }

  /** Get direct reverse dependencies (modules that import this one) */
  getDependents(id: string): Set<string> {
    return this.reverseDeps.get(id) ?? new Set();
  }

  /** Get all modules transitively affected by changes to the given set (BFS upward) */
  getAffectedModules(ids: Set<string>): Set<string> {
    const affected = new Set<string>();
    const queue = [...ids];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (affected.has(current)) continue;
      affected.add(current);

      const dependents = this.reverseDeps.get(current);
      if (dependents) {
        for (const dep of dependents) {
          if (!affected.has(dep)) {
            queue.push(dep);
          }
        }
      }
    }

    return affected;
  }

  /** Find modules unreachable from the entry file (BFS downward) */
  findOrphans(entryFile: string): Set<string> {
    const reachable = new Set<string>();
    const queue = [entryFile];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (reachable.has(current)) continue;
      reachable.add(current);

      const node = this.nodes.get(current);
      if (node) {
        for (const dep of node.localDeps) {
          if (!reachable.has(dep)) {
            queue.push(dep);
          }
        }
      }
    }

    const orphans = new Set<string>();
    for (const id of this.nodes.keys()) {
      if (!reachable.has(id)) {
        orphans.add(id);
      }
    }
    return orphans;
  }

  /** Get the local deps of a module */
  getLocalDeps(id: string): Set<string> {
    return this.nodes.get(id)?.localDeps ?? new Set();
  }

  /** Get the npm deps of a module */
  getNpmDeps(id: string): Set<string> {
    return this.nodes.get(id)?.npmDeps ?? new Set();
  }

  /** Get a serializable map of module -> its reverse deps (for embedding in HMR runtime) */
  getReverseDepsMap(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [id, deps] of this.reverseDeps) {
      if (deps.size > 0) {
        result[id] = [...deps];
      }
    }
    return result;
  }
}
