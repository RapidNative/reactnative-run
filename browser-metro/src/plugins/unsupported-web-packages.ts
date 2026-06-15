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
  // Multi-export native module: `import MapView, { Marker, Polyline,
  // PROVIDER_GOOGLE } from 'react-native-maps'`. MapView renders a neutral
  // map-shaped placeholder; every sub-component (Marker, Callout, overlays,
  // tiles) is a render-null no-op so map JSX mounts without crashing; constants
  // and AnimatedRegion are stubbed so calling code keeps its types. The default
  // export carries all named exports as properties, and the degraded wrapper
  // preserves them (see degradedWrapper) so named imports resolve correctly.
  "react-native-maps": {
    mode: "degraded",
    note: "Approximate map shown here. Markers, live location, and Google/Apple tiles render fully once your app runs on a device.",
    stub: `
      var React = require('react');
      var RN = require('react-native');

      // Class component (not a plain function) so a ref resolves to an instance
      // carrying the imperative map API as no-ops — e.g. mapRef.current.animateCamera(...).
      // The degraded wrapper forwards the ref through to this instance.
      function MapView(props) {
        React.Component.call(this, props);
      }
      MapView.prototype = Object.create(React.Component.prototype);
      MapView.prototype.constructor = MapView;
      MapView.prototype.render = function () {
        var props = this.props || {};
        var style = props.style || {};
        var container = Object.assign(
          { minHeight: 160, flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#e8eaed', overflow: 'hidden', position: 'relative' },
          style
        );
        // Derive a center + span from region/initialRegion/camera so we can render
        // a real (approximate) OpenStreetMap tile view instead of a gray box.
        var region = props.region || props.initialRegion;
        var lat, lon, latD = 0.02, lonD = 0.02;
        if (region && typeof region.latitude === 'number') {
          lat = region.latitude; lon = region.longitude;
          if (typeof region.latitudeDelta === 'number' && region.latitudeDelta > 0) latD = region.latitudeDelta;
          if (typeof region.longitudeDelta === 'number' && region.longitudeDelta > 0) lonD = region.longitudeDelta;
        } else if (props.camera && props.camera.center && typeof props.camera.center.latitude === 'number') {
          lat = props.camera.center.latitude; lon = props.camera.center.longitude;
          var z = typeof props.camera.zoom === 'number' ? props.camera.zoom : 14;
          latD = 360 / Math.pow(2, z); lonD = latD;
        }
        if (typeof lat === 'number' && typeof lon === 'number' && !isNaN(lat) && !isNaN(lon)) {
          var bbox = (lon - lonD / 2) + ',' + (lat - latD / 2) + ',' + (lon + lonD / 2) + ',' + (lat + latD / 2);
          var src = 'https://www.openstreetmap.org/export/embed.html?bbox=' + encodeURIComponent(bbox) + '&layer=mapnik&marker=' + encodeURIComponent(lat + ',' + lon);
          return React.createElement(
            RN.View,
            { style: container },
            React.createElement('iframe', {
              src: src,
              title: 'map-preview',
              loading: 'lazy',
              style: { border: 'none', width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }
            }),
            props.children
          );
        }
        // No coordinates known (markers-only / fitToCoordinates apps) — neutral placeholder.
        return React.createElement(
          RN.View,
          { style: container },
          React.createElement(RN.Text, { style: { fontSize: 30 } }, '\\uD83D\\uDDFA\\uFE0F'),
          React.createElement(RN.Text, { style: { marginTop: 6, color: '#5f6368', fontSize: 13 } }, 'Map preview'),
          props.children
        );
      };
      // Imperative methods used via the map ref. Void methods no-op; methods that
      // return a promise on a real device resolve to a neutral value here.
      var voidMethods = ['animateToRegion', 'animateCamera', 'setCamera', 'fitToElements', 'fitToSuppliedMarkers', 'fitToCoordinates', 'setMapBoundaries'];
      voidMethods.forEach(function (m) { MapView.prototype[m] = function () {}; });
      MapView.prototype.getCamera = function () { return Promise.resolve({ center: { latitude: 0, longitude: 0 }, zoom: 0, heading: 0, pitch: 0, altitude: 0 }); };
      MapView.prototype.getMapBoundaries = function () { return Promise.resolve({ northEast: { latitude: 0, longitude: 0 }, southWest: { latitude: 0, longitude: 0 } }); };
      MapView.prototype.addressForCoordinate = function () { return Promise.resolve({}); };
      MapView.prototype.pointForCoordinate = function () { return Promise.resolve({ x: 0, y: 0 }); };
      MapView.prototype.coordinateForPoint = function () { return Promise.resolve({ latitude: 0, longitude: 0 }); };

      function makeNoop(name) {
        function C() { return null; }
        C.displayName = name;
        return C;
      }

      var Marker = makeNoop('Marker');
      Marker.Animated = makeNoop('Marker.Animated');

      // Best-effort AnimatedRegion: a plain value bag whose animation methods are
      // chainable no-ops, so new AnimatedRegion(...).timing(...).start() is safe.
      function AnimatedRegion(initial) {
        var self = Object.assign({}, initial);
        var anim = { start: function (cb) { if (typeof cb === 'function') cb({ finished: true }); }, stop: function () {} };
        self.timing = function () { return anim; };
        self.spring = function () { return anim; };
        self.setValue = function () {};
        self.setOffset = function () {};
        self.stopAnimation = function () {};
        self.addListener = function () { return ''; };
        self.removeListener = function () {};
        return self;
      }

      MapView.Marker = Marker;
      MapView.Callout = makeNoop('Callout');
      MapView.CalloutSubview = makeNoop('CalloutSubview');
      MapView.Polyline = makeNoop('Polyline');
      MapView.Polygon = makeNoop('Polygon');
      MapView.Circle = makeNoop('Circle');
      MapView.Overlay = makeNoop('Overlay');
      MapView.Heatmap = makeNoop('Heatmap');
      MapView.Geojson = makeNoop('Geojson');
      MapView.LocalTile = makeNoop('LocalTile');
      MapView.UrlTile = makeNoop('UrlTile');
      MapView.WMSTile = makeNoop('WMSTile');
      MapView.MapView = MapView;
      MapView.Animated = MapView;
      MapView.AnimatedRegion = AnimatedRegion;
      MapView.PROVIDER_GOOGLE = 'google';
      MapView.PROVIDER_DEFAULT = null;
      MapView.MAP_TYPES = { STANDARD: 'standard', SATELLITE: 'satellite', HYBRID: 'hybrid', TERRAIN: 'terrain', NONE: 'none', MUTEDSTANDARD: 'mutedStandard' };

      module.exports = MapView;
    `,
  },
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
        // forwardRef so a ref on the default component (e.g. <MapView ref={...} />)
        // reaches the underlying class instance and its imperative methods, instead
        // of being swallowed by the wrapper (which also silences React's
        // "function components cannot be given refs" warning).
        var Wrapped = React.forwardRef(function (props, ref) {
          React.useEffect(function () { __postNotice(); }, []);
          return React.createElement(__orig, Object.assign({}, props, { ref: ref }));
        });
        // Carry over the original's named exports (e.g. Marker, PROVIDER_GOOGLE
        // on a default-exported MapView) so multi-export packages keep working:
        // only the default component is mount-wrapped to post the notice.
        try {
          Object.keys(__orig).forEach(function (k) { Wrapped[k] = __orig[k]; });
        } catch (e) {}
        module.exports = new Proxy(Wrapped, {
          get: function (target, prop) {
            if (prop === '__esModule') return false;
            // Preserve real named exports; fall back to the wrapped component so
            // single-export packages (and unknown prop access) still resolve.
            if (prop in target) return target[prop];
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
