import { buildBundlePreamble } from "./utils.js";

/**
 * HMR-capable bundle runtime template.
 *
 * Called at emit time as an IIFE with:
 *   modules       - the module map object
 *   reverseDeps   - JSON reverse dependency map
 *   entryId       - entry file path string
 *   reactRefreshEnabled - boolean
 */
export const HMR_RUNTIME_TEMPLATE = `(function(modules, reverseDeps, entryId, reactRefreshEnabled) {
  var cache = {};
  var hotState = {};

  function initHot(id) {
    if (hotState[id]) return hotState[id];
    var state = {
      acceptCallbacks: [],
      disposeCallbacks: [],
      data: {},
      declined: false,
      accepted: false
    };
    hotState[id] = state;
    return state;
  }

  function createHotAPI(id) {
    var state = initHot(id);
    return {
      accept: function(cb) {
        state.accepted = true;
        if (cb) state.acceptCallbacks.push(cb);
      },
      dispose: function(cb) {
        if (cb) state.disposeCallbacks.push(cb);
      },
      decline: function() {
        state.declined = true;
      },
      get data() {
        return state.data;
      }
    };
  }

  function require(id) {
    if (cache[id]) return cache[id].exports;
    if (!modules[id]) throw new Error('Module not found: ' + id);
    var module = cache[id] = { exports: {}, hot: createHotAPI(id) };
    modules[id].call(module.exports, module, module.exports, require);
    return module.exports;
  }

  // Walk reverse deps to find nearest module.hot.accept() boundary
  function findAcceptBoundary(changedId) {
    var visited = {};
    var queue = [changedId];
    var boundaries = [];

    while (queue.length > 0) {
      var current = queue.shift();
      if (visited[current]) continue;
      visited[current] = true;

      var state = hotState[current];
      if (state && state.declined) {
        return null;
      }
      if (state && state.accepted) {
        boundaries.push(current);
        continue;
      }
      // Walk upward through reverse deps
      var parents = reverseDeps[current];
      if (!parents || parents.length === 0) {
        return null;
      }
      for (var i = 0; i < parents.length; i++) {
        queue.push(parents[i]);
      }
    }

    return boundaries.length > 0 ? boundaries : null;
  }

  function applyUpdate(updatedModules, removedModules, newReverseDeps) {
    // Merge updated reverse deps so boundary walk sees new modules
    if (newReverseDeps) {
      for (var key in newReverseDeps) {
        reverseDeps[key] = newReverseDeps[key];
      }
    }

    // Phase 1: Check boundaries FIRST, before any state mutation.
    // The dispose phase used to reset accepted=false here, which wiped
    // out the accept registrations before the boundary walk could see them.
    var needsReload = false;
    var modulesToReExecute = new Set();

    for (var uid in updatedModules) {
      var boundaries = findAcceptBoundary(uid);
      if (!boundaries) {
        needsReload = true;
        break;
      }
      for (var b = 0; b < boundaries.length; b++) {
        modulesToReExecute.add(boundaries[b]);
      }
      modulesToReExecute.add(uid);
    }

    if (needsReload) {
      console.warn('[HMR] No accept boundary found, requesting full reload');
      window.parent.postMessage({ type: 'hmr-full-reload' }, '*');
      return;
    }

    // Phase 2: Run dispose callbacks and reset state for modules about to be re-executed
    modulesToReExecute.forEach(function(id) {
      var state = hotState[id];
      if (state) {
        var newData = {};
        for (var i = 0; i < state.disposeCallbacks.length; i++) {
          state.disposeCallbacks[i](newData);
        }
        state.data = newData;
        state.disposeCallbacks = [];
        state.acceptCallbacks = [];
        state.accepted = false;
      }
    });

    // Phase 3: Update module factories
    for (var mid in updatedModules) {
      modules[mid] = new Function('module', 'exports', 'require', updatedModules[mid]);
    }

    // Phase 4: Remove deleted modules
    for (var r = 0; r < removedModules.length; r++) {
      var rmId = removedModules[r];
      delete modules[rmId];
      delete cache[rmId];
      delete hotState[rmId];
    }

    // Phase 5: Re-execute modules. Clear ALL caches first so that nested
    // require() calls during re-execution pick up the new factories rather
    // than stale cached exports (e.g. entry requiring a dependency that
    // hasn't been re-executed yet in this loop).
    modulesToReExecute.forEach(function(execId) {
      delete cache[execId];
    });
    modulesToReExecute.forEach(function(execId) {
      try {
        require(execId);
      } catch(err) {
        console.error('[HMR] Error re-executing module ' + execId + ':', err);
        window.parent.postMessage({ type: 'hmr-full-reload' }, '*');
      }
    });

    // Phase 6: React Refresh -- tell React to re-render with new component definitions
    if (reactRefreshEnabled && window.__REACT_REFRESH_RUNTIME__) {
      try {
        window.__REACT_REFRESH_RUNTIME__.performReactRefresh();
      } catch(err) {
        console.error('[HMR] React Refresh error:', err);
      }
    }

    console.log('[HMR] Updated ' + Object.keys(updatedModules).length + ' module(s)');
  }

  // Expose HMR API globally
  window.__BUNDLER_HMR__ = {
    applyUpdate: applyUpdate,
    modules: modules,
    cache: cache,
    hotState: hotState
  };

  // Listen for HMR updates from parent window
  window.addEventListener('message', function(e) {
    var data = e.data;
    if (data && data.type === 'hmr-update') {
      applyUpdate(data.updatedModules || {}, data.removedModules || [], data.reverseDepsMap);
    }
  });

  // Initialize React Refresh runtime BEFORE executing the entry module,
  // so $RefreshReg$ and $RefreshSig$ are available when component modules load.
  if (reactRefreshEnabled) {
    try {
      var RefreshRuntime = require('react-refresh/runtime');
      RefreshRuntime.injectIntoGlobalHook(window);
      window.__REACT_REFRESH_RUNTIME__ = RefreshRuntime;
      window.$RefreshReg$ = function() {};
      window.$RefreshSig$ = function() { return function(type) { return type; }; };
    } catch(e) {
      console.warn('[HMR] React Refresh runtime not available:', e.message || e);
    }
  }

  // Execute entry module
  require(entryId);
})`;

/**
 * Emit an HMR-capable bundle string.
 */
export function emitHmrBundle(
  moduleMap: Record<string, string>,
  entryFile: string,
  reverseDepsMap: Record<string, string[]>,
  reactRefresh: boolean,
  env?: Record<string, string>,
  routerShim?: boolean,
): string {
  const moduleEntries = Object.keys(moduleMap)
    .map((id) => {
      return (
        JSON.stringify(id) +
        ": function(module, exports, require) {\n" +
        moduleMap[id] +
        "\n}"
      );
    })
    .join(",\n\n");

  return (
    buildBundlePreamble(env, routerShim) +
    HMR_RUNTIME_TEMPLATE +
    "({\n" +
    moduleEntries +
    "\n}, " +
    JSON.stringify(reverseDepsMap) +
    ", " +
    JSON.stringify(entryFile) +
    ", " +
    String(reactRefresh) +
    ");\n"
  );
}
