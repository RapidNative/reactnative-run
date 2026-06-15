import type { BundlerPlugin } from "../types.js";

/**
 * Packages that need special handling in this (web) preview environment.
 *
 * Two tiers, both opt-in — a package is ONLY affected if it is listed here.
 * Anything not in this map is fetched and rendered completely normally.
 *
 *   "unsupported" — native-only modules with no web build (e.g. wrappers around
 *     iOS/Android native views). We shim them so the shared bundle still builds
 *     (an un-fetchable package would otherwise fail the whole bundle and break
 *     every artboard) and render a "not supported" placeholder where the package
 *     would have appeared. Only the screen that uses it shows the placeholder.
 *
 *   "degraded" — works on a real device but can't render faithfully on web. We
 *     shim it (with a best-effort `stub`, or a neutral placeholder) AND post a
 *     notice to the host so the editor can show a banner under that artboard:
 *     "may look different here — works correctly on a real device." The notice
 *     fires only when the package is actually loaded on a screen, so it is
 *     scoped to the right artboard automatically.
 *
 * Grow this map one entry at a time as packages are encountered. Shimmed modules
 * are never fetched from the package server, so nothing enters the error/AI loop.
 */
export interface UnsupportedPackageEntry {
  /** Defaults to "unsupported". */
  mode?: "unsupported" | "degraded";
  /**
   * Optional custom module source (CommonJS). Replaces the package verbatim.
   *   - unsupported: use for non-visual native modules where a placeholder
   *     component would not match how the code calls the package; return safe,
   *     correctly-typed no-op values so calling code does not crash.
   *   - degraded: use to provide a best-effort web approximation that still
   *     renders something usable.
   * When omitted, a generic placeholder component is used.
   */
  stub?: string;
  /** Banner text for the host (degraded only). Falls back to a default message. */
  note?: string;
}

export const UNSUPPORTED_WEB_PACKAGES: Record<string, UnsupportedPackageEntry> = {
  // Nearest web equivalent: browsers render PDFs natively, so embed the source
  // uri in an <iframe>. Renders the real PDF in preview; the banner notes it runs
  // natively on a real device.
  "react-native-pdf": {
    mode: "degraded",
    note: "Shown as a preview here. The real version works once your app is published.",
    stub: `
      var React = require('react');
      function Pdf(props) {
        var source = props && props.source;
        var uri = source && (typeof source === 'string' ? source : source.uri);
        var style = (props && props.style) || {};
        if (!uri) return null;
        return React.createElement('iframe', {
          src: uri,
          title: 'pdf-preview',
          style: Object.assign({ border: 'none', width: '100%', height: '100%' }, style),
        });
      }
      module.exports = new Proxy(Pdf, {
        get: function (target, prop) {
          if (prop === '__esModule') return false;
          return target;
        },
      });
    `,
  },
  // Add one entry per package as you hit it, e.g.:
  // "react-native-maps": {
  //   mode: "degraded",
  //   note: "Maps render approximately here — full map works on a real device.",
  //   // stub: `...best-effort web map...`  // optional
  // },
  // "react-native-keychain": {
  //   stub: `module.exports = {
  //     getGenericPassword: async () => false,
  //     setGenericPassword: async () => false,
  //     resetGenericPassword: async () => true,
  //   };`,
  // },
};

const DEFAULT_DEGRADED_NOTE =
  "Shown as a preview here. The real version works once your app is published.";

/** Escape a string for embedding inside a single-quoted JS string literal. */
function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n");
}

/**
 * Generic placeholder: a single module that renders a notice no matter how the
 * package is imported. The export is a Proxy over a React component so default,
 * named, and property-access imports all resolve to a renderable component.
 */
function placeholderModule(message: string, bg: string, color: string): string {
  return `
    var React = require('react');
    var RN = require('react-native');
    function Placeholder() {
      return React.createElement(
        RN.View,
        { style: { flex: 1, minHeight: 120, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '${bg}' } },
        React.createElement(
          RN.Text,
          { style: { textAlign: 'center', color: '${color}', fontSize: 14, lineHeight: 20 } },
          '${esc(message)}'
        )
      );
    }
    module.exports = new Proxy(Placeholder, {
      get: function (target, prop) {
        if (prop === '__esModule') return false;
        return target;
      },
    });
  `;
}

/**
 * Wrapper (appended after the shim body) that posts the host notice when the
 * package's component actually MOUNTS — not at module load. expo-router evaluates
 * route modules even for screens it isn't showing (to build the nav tree), so a
 * load-time post would fire from the wrong iframe and attach the banner to the
 * wrong artboard. Mounting only happens in the iframe that truly renders the
 * package, so the host maps it to the correct artboard.
 *
 * It re-wraps whatever the body assigned to module.exports: if that's a component
 * (function), every import shape resolves to a wrapper that posts on mount then
 * renders the original. If it's a non-component value (rare for degraded), it
 * falls back to a best-effort load-time post.
 */
function degradedWrapper(pkg: string, note: string): string {
  return `
    (function () {
      var React = require('react');
      var __orig = module.exports;
      var __posted = false;
      function __postNotice() {
        if (__posted) return;
        __posted = true;
        try {
          if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
            // Report this iframe's own route so the host can map the notice to the
            // correct artboard deterministically (no event.source identity guess).
            var route = '';
            try { route = (window.location.hash || '').replace(/^#/, ''); } catch (e) {}
            window.parent.postMessage({
              type: 'iframe.preview.notice',
              payload: { package: '${esc(pkg)}', note: '${esc(note)}', route: route }
            }, '*');
          }
        } catch (e) {}
      }
      if (typeof __orig === 'function') {
        function Wrapped(props) {
          React.useEffect(function () { __postNotice(); }, []);
          return React.createElement(__orig, props);
        }
        module.exports = new Proxy(Wrapped, {
          get: function (target, prop) {
            if (prop === '__esModule') return false;
            return Wrapped;
          },
        });
      } else {
        __postNotice();
      }
    })();
  `;
}

function buildShim(pkg: string, entry: UnsupportedPackageEntry): string {
  const mode = entry.mode ?? "unsupported";
  if (mode === "degraded") {
    const note = entry.note ?? DEFAULT_DEGRADED_NOTE;
    const body =
      entry.stub ??
      placeholderModule(
        "\\uD83D\\uDCF1 " + pkg + " — preview limited",
        "#f3f4f6",
        "#6b7280",
      );
    // Body assigns module.exports, then the wrapper re-wraps it to post on mount.
    return body + "\n" + degradedWrapper(pkg, note);
  }
  // unsupported
  return (
    entry.stub ??
    placeholderModule(
      "\\uD83D\\uDCE6 " + pkg + " is not supported in this environment",
      "#f6f6f6",
      "#888",
    )
  );
}

export function createUnsupportedWebPackagesPlugin(): BundlerPlugin {
  return {
    name: "unsupported-web-packages",
    shimModules() {
      const shims: Record<string, string> = {};
      for (const [pkg, entry] of Object.entries(UNSUPPORTED_WEB_PACKAGES)) {
        shims[pkg] = buildShim(pkg, entry);
      }
      return shims;
    },
  };
}
