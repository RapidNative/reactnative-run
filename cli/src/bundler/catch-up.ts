import type { HmrUpdate } from "browser-metro";

/** One applied rebuild: the HMR update that produced `version`, or null when
 *  that rebuild was a full one (the client has to reload to reach it). */
export interface HistoryEntry {
  version: number;
  update: HmrUpdate | null;
}

/** Updates kept per session. Generously above any realistic gap between a
 *  device fetching a bundle and registering on /hot. */
export const HISTORY_LIMIT = 500;

/**
 * Fold the updates after `from` into the single patch that brings a client at
 * bundleVersion `from` to `current`. Returns null when that isn't expressible
 * (a full rebuild in between, a version the history no longer holds, or a
 * client ahead of the server); an empty update when nothing changed.
 *
 * Later entries win per module; a module removed and then re-added lands in
 * updatedModules, one added and then removed in removedModules.
 */
export function mergeHistory(history: HistoryEntry[], from: number, current: number): HmrUpdate | null {
  const merged: HmrUpdate = { updatedModules: {}, removedModules: [], requiresReload: false, reverseDepsMap: {} };
  if (from === current) return merged;
  if (from > current) return null;

  const removed = new Set<string>();
  let expected = from + 1;
  for (const entry of history) {
    if (entry.version <= from) continue;
    if (entry.version !== expected) return null; // gap: trimmed or out of order
    if (!entry.update) return null; // full rebuild in between
    expected++;
    for (const [key, code] of Object.entries(entry.update.updatedModules)) {
      merged.updatedModules[key] = code;
      removed.delete(key);
    }
    for (const key of entry.update.removedModules) {
      delete merged.updatedModules[key];
      removed.add(key);
    }
    Object.assign(merged.reverseDepsMap!, entry.update.reverseDepsMap ?? {});
  }
  if (expected !== current + 1) return null; // history doesn't reach `current`
  merged.removedModules = [...removed];
  return merged;
}
