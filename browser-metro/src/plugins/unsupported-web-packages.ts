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
  // Multi-export native module: `import { RTCView, RTCPeerConnection, mediaDevices }
  // from 'react-native-webrtc'`. The browser already provides RTCPeerConnection /
  // MediaStream / navigator.mediaDevices, so the call APIs pass straight through;
  // the only visual surface, RTCView, renders the stream into a <video>. We patch
  // MediaStream.toURL (native-only, used by RTCView's streamURL) and expose RTCView
  // as the module's component so the degraded wrapper posts the on-mount banner.
  // The non-visual API hangs off RTCView as named exports; RTCView/default keys are
  // intentionally omitted so those imports fall through to the mount-wrapped
  // component (see degradedWrapper).
  "react-native-webrtc": {
    mode: "degraded",
    note: "Live camera and mic preview shown here. Real-time calls, peer connections, and camera switching work fully once your app runs on a device.",
    stub: `
      var React = require('react');
      var RN = require('react-native');

      var _win = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
      var _nav = typeof navigator !== 'undefined' ? navigator : null;

      // Registry of MediaStream objects keyed by stream.id, populated by toURL()
      // so RTCView can resolve a streamURL string back to the live stream.
      var _streamRegistry = {};
      var _STREAM_URL_PREFIX = 'rn-webrtc-stream://';

      // The browser's MediaStream has no toURL(), but native code calls it routinely
      // (e.g. <RTCView streamURL={stream.toURL()} />). Patch it to return a marker URL.
      if (_win.MediaStream && !_win.MediaStream.prototype.toURL) {
        _win.MediaStream.prototype.toURL = function () {
          _streamRegistry[this.id] = this;
          return _STREAM_URL_PREFIX + this.id;
        };
      }

      // _switchCamera is a react-native-webrtc-specific track method; no-op on web.
      if (_win.MediaStreamTrack && !_win.MediaStreamTrack.prototype._switchCamera) {
        _win.MediaStreamTrack.prototype._switchCamera = function () {};
      }

      function _resolveStream(streamOrUrl) {
        if (!streamOrUrl) return null;
        if (typeof streamOrUrl === 'object' && (streamOrUrl.getTracks || streamOrUrl.getVideoTracks)) return streamOrUrl;
        if (typeof streamOrUrl === 'string' && streamOrUrl.indexOf(_STREAM_URL_PREFIX) === 0) {
          return _streamRegistry[streamOrUrl.slice(_STREAM_URL_PREFIX.length)] || null;
        }
        return null;
      }

      // Plain function component (NOT forwardRef) so the degraded wrapper sees
      // module.exports as a component (typeof === 'function') and posts the
      // on-mount banner. RTCView refs (rare) are not forwarded in this shim.
      function RTCView(props) {
        var videoRef = React.useRef(null);
        React.useEffect(function () {
          var v = videoRef.current;
          if (!v) return;
          var stream = _resolveStream(props.streamURL) || _resolveStream(props.stream);
          try { v.srcObject = stream || null; } catch (e) {}
        }, [props.streamURL, props.stream]);

        var flat = (RN.StyleSheet && RN.StyleSheet.flatten) ? RN.StyleSheet.flatten(props.style) : props.style;
        var containerStyle = Object.assign({ overflow: 'hidden', backgroundColor: '#000' }, flat || {});
        var objectFit = props.objectFit === 'contain' ? 'contain' : 'cover';

        return React.createElement(RN.View, { style: containerStyle },
          React.createElement('video', {
            ref: videoRef,
            autoPlay: true,
            playsInline: true,
            muted: props.muted !== undefined ? !!props.muted : true,
            style: { width: '100%', height: '100%', objectFit: objectFit, transform: props.mirror ? 'scaleX(-1)' : undefined, backgroundColor: '#000' }
          })
        );
      }
      RTCView.displayName = 'RTCView';

      var mediaDevices = {
        getUserMedia: function (c) { return (_nav && _nav.mediaDevices) ? _nav.mediaDevices.getUserMedia(c) : Promise.reject(new Error('mediaDevices unavailable')); },
        getDisplayMedia: function (c) { return (_nav && _nav.mediaDevices) ? _nav.mediaDevices.getDisplayMedia(c) : Promise.reject(new Error('mediaDevices unavailable')); },
        enumerateDevices: function () { return (_nav && _nav.mediaDevices) ? _nav.mediaDevices.enumerateDevices() : Promise.resolve([]); },
        getSupportedConstraints: function () { return (_nav && _nav.mediaDevices && _nav.mediaDevices.getSupportedConstraints) ? _nav.mediaDevices.getSupportedConstraints() : {}; },
        addEventListener: function (e, h) { if (_nav && _nav.mediaDevices) _nav.mediaDevices.addEventListener(e, h); },
        removeEventListener: function (e, h) { if (_nav && _nav.mediaDevices) _nav.mediaDevices.removeEventListener(e, h); },
        ondevicechange: null
      };

      function registerGlobals() {}
      var permissions = {
        request: function () { return Promise.resolve('granted'); },
        check: function () { return Promise.resolve('granted'); }
      };

      // Hang the non-visual WebRTC API off RTCView as named exports. NO RTCView or
      // default keys: those imports fall through the wrapper's proxy to the
      // mount-wrapped component, so the banner fires wherever a stream renders.
      RTCView.RTCPeerConnection = _win.RTCPeerConnection;
      RTCView.RTCIceCandidate = _win.RTCIceCandidate;
      RTCView.RTCSessionDescription = _win.RTCSessionDescription;
      RTCView.RTCRtpReceiver = _win.RTCRtpReceiver;
      RTCView.RTCRtpSender = _win.RTCRtpSender;
      RTCView.RTCRtpTransceiver = _win.RTCRtpTransceiver;
      RTCView.RTCErrorEvent = _win.RTCErrorEvent;
      RTCView.RTCDataChannelEvent = _win.RTCDataChannelEvent;
      RTCView.RTCTrackEvent = _win.RTCTrackEvent;
      RTCView.RTCPeerConnectionIceEvent = _win.RTCPeerConnectionIceEvent;
      RTCView.MediaStream = _win.MediaStream;
      RTCView.MediaStreamTrack = _win.MediaStreamTrack;
      RTCView.mediaDevices = mediaDevices;
      RTCView.registerGlobals = registerGlobals;
      RTCView.permissions = permissions;

      module.exports = RTCView;
    `,
  },
  // Non-visual native module: routes call audio (speaker/earpiece), drives the
  // proximity sensor, and plays ringtones — none of which have a browser analogue.
  // Unsupported tier (no UI, so no banner): replace with a no-op singleton so calls
  // like InCallManager.start(...) don't crash the preview. Exposed as both a callable
  // constructor (new InCallManager()) and a static object, since AI-generated code
  // uses both shapes.
  "react-native-incall-manager": {
    mode: "unsupported",
    stub: `
      // incall-manager is invoked imperatively (e.g. onPress -> InCallManager.start()),
      // never rendered, so the mount-based degraded wrapper can't fire. Instead we post
      // the preview banner the first time any method runs, giving feedback that the call
      // APIs are no-ops here and work on a real device.
      var __posted = false;
      function __postNotice() {
        if (__posted) return;
        __posted = true;
        try {
          if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
            var route = '';
            try { route = (window.location.hash || '').replace(/^#/, ''); } catch (e) {}
            window.parent.postMessage({
              type: 'iframe.preview.notice',
              payload: {
                package: 'react-native-incall-manager',
                note: 'Call audio (speaker, ringtone, mute, proximity) is a no-op in this preview — it works once your app runs on a device.',
                route: route
              }
            }, '*');
          }
        } catch (e) {}
      }

      function _noop() { __postNotice(); }
      function _resolveVoid() { __postNotice(); return Promise.resolve(); }

      var _api = {
        start: _noop,
        stop: _noop,
        setKeepScreenOn: _noop,
        setSpeakerphoneOn: _noop,
        setForceSpeakerphoneOn: _noop,
        setMicrophoneMute: _noop,
        turnScreenOn: _noop,
        turnScreenOff: _noop,
        setFlashOn: _noop,
        startRingtone: _noop,
        stopRingtone: _noop,
        startRingback: _noop,
        stopRingback: _noop,
        startProximitySensor: _noop,
        stopProximitySensor: _noop,
        pokeScreen: _noop,
        chooseAudioRoute: _noop,
        requestAudioFocus: _resolveVoid,
        abandonAudioFocus: _resolveVoid,
        getAudioUriJS: function () { __postNotice(); return Promise.resolve(null); },
        getIsWiredHeadsetPluggedIn: function () { __postNotice(); return Promise.resolve({ isWiredHeadsetPluggedIn: false }); }
      };

      // Callable as both a constructor (new InCallManager()) and a singleton
      // (InCallManager.start(...)). The constructor returns the shared singleton
      // so both shapes hit the same no-ops.
      function InCallManager() { return _api; }
      Object.assign(InCallManager, _api);
      InCallManager.prototype = _api;

      module.exports = InCallManager;
      InCallManager.default = InCallManager;
      InCallManager.__esModule = true;
    `,
  },
  // RevenueCat in-app purchases: a non-rendering native module (StoreKit /
  // Play Billing) with no web analogue. Unsupported tier, imperative like
  // incall-manager: the banner posts on the first SDK call. Read APIs resolve
  // with sample offerings so AI-built paywalls render localized-price rows in
  // the preview instead of crashing; purchase APIs reject with a clear message
  // (never userCancelled, so well-written paywalls surface their error state).
  // The rapidnative `revenuecat` skill routes all access through a facade that
  // mocks these same shapes itself — this stub is the safety net for code that
  // imports the SDK directly.
  "react-native-purchases": {
    mode: "unsupported",
    stub: `
      var __posted = false;
      function __postNotice() {
        if (__posted) return;
        __posted = true;
        try {
          if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
            var route = '';
            try { route = (window.location.hash || '').replace(/^#/, ''); } catch (e) {}
            window.parent.postMessage({
              type: 'iframe.preview.notice',
              payload: {
                package: 'react-native-purchases',
                note: 'In-app purchases are simulated in this preview — sample prices are shown and buying is disabled. Real purchases work once your app runs as an installed build.',
                route: route
              }
            }, '*');
          }
        } catch (e) {}
      }

      function _product(id, price, priceString) {
        return {
          identifier: id, price: price, priceString: priceString, currencyCode: 'USD',
          title: 'Premium (preview)', description: 'Sample product shown in preview',
          introPrice: null, discounts: [], defaultOption: null, productCategory: 'SUBSCRIPTION',
          subscriptionPeriod: id === 'annual' ? 'P1Y' : 'P1M'
        };
      }
      function _pkg(identifier, type, id, price, priceString) {
        return {
          identifier: identifier, packageType: type,
          product: _product(id, price, priceString),
          offeringIdentifier: 'default', presentedOfferingContext: { offeringIdentifier: 'default' }
        };
      }
      var _annual = _pkg('$rc_annual', 'ANNUAL', 'annual', 49.99, '$49.99');
      var _monthly = _pkg('$rc_monthly', 'MONTHLY', 'monthly', 5.99, '$5.99');
      var _offering = {
        identifier: 'default', serverDescription: 'Preview sample offering', metadata: {},
        availablePackages: [_annual, _monthly],
        annual: _annual, monthly: _monthly,
        lifetime: null, sixMonth: null, threeMonth: null, twoMonth: null, weekly: null
      };
      function _emptyCustomerInfo() {
        return {
          entitlements: { active: {}, all: {}, verification: 'NOT_REQUESTED' },
          activeSubscriptions: [], allPurchasedProductIdentifiers: [],
          latestExpirationDate: null, firstSeen: new Date().toISOString(),
          originalAppUserId: 'preview-user', requestDate: new Date().toISOString(),
          allExpirationDates: {}, allPurchaseDates: {}, originalApplicationVersion: null,
          originalPurchaseDate: null, managementURL: null, nonSubscriptionTransactions: []
        };
      }
      function _rejectPurchase() {
        __postNotice();
        var err = new Error('Purchases are simulated in this preview. Real purchases work once your app runs as an installed build.');
        err.userCancelled = false;
        err.code = 'UnsupportedError';
        return Promise.reject(err);
      }
      function _noopAsync() { __postNotice(); return Promise.resolve(); }

      var Purchases = {
        configure: function () { __postNotice(); },
        isConfigured: function () { return Promise.resolve(true); },
        setLogLevel: function () {},
        setLogHandler: function () {},
        getOfferings: function () { __postNotice(); return Promise.resolve({ current: _offering, all: { 'default': _offering } }); },
        getProducts: function () { __postNotice(); return Promise.resolve([_annual.product, _monthly.product]); },
        getCustomerInfo: function () { return Promise.resolve(_emptyCustomerInfo()); },
        purchasePackage: _rejectPurchase,
        purchaseStoreProduct: _rejectPurchase,
        purchaseProduct: _rejectPurchase,
        purchaseDiscountedPackage: _rejectPurchase,
        purchaseSubscriptionOption: _rejectPurchase,
        restorePurchases: function () { __postNotice(); return Promise.resolve(_emptyCustomerInfo()); },
        syncPurchases: _noopAsync,
        logIn: function () { return Promise.resolve({ customerInfo: _emptyCustomerInfo(), created: false }); },
        logOut: function () { return Promise.resolve(_emptyCustomerInfo()); },
        isAnonymous: function () { return Promise.resolve(true); },
        getAppUserID: function () { return Promise.resolve('preview-user'); },
        addCustomerInfoUpdateListener: function () {},
        removeCustomerInfoUpdateListener: function () { return true; },
        showManageSubscriptions: _noopAsync,
        presentCodeRedemptionSheet: _noopAsync,
        checkTrialOrIntroductoryPriceEligibility: function () { return Promise.resolve({}); },
        setAttributes: _noopAsync, setEmail: _noopAsync, setDisplayName: _noopAsync,
        setPushToken: _noopAsync, collectDeviceIdentifiers: _noopAsync,
        enableAdServicesAttributionTokenCollection: _noopAsync,
        invalidateCustomerInfoCache: _noopAsync,
        canMakePayments: function () { return Promise.resolve(false); }
      };

      module.exports = Purchases;
      Purchases.default = Purchases;
      Purchases.__esModule = true;
      Purchases.LOG_LEVEL = { VERBOSE: 'VERBOSE', DEBUG: 'DEBUG', INFO: 'INFO', WARN: 'WARN', ERROR: 'ERROR' };
      Purchases.PACKAGE_TYPE = {
        UNKNOWN: 'UNKNOWN', CUSTOM: 'CUSTOM', LIFETIME: 'LIFETIME', ANNUAL: 'ANNUAL',
        SIX_MONTH: 'SIX_MONTH', THREE_MONTH: 'THREE_MONTH', TWO_MONTH: 'TWO_MONTH',
        MONTHLY: 'MONTHLY', WEEKLY: 'WEEKLY'
      };
      Purchases.INTRO_ELIGIBILITY_STATUS = {
        INTRO_ELIGIBILITY_STATUS_UNKNOWN: 0, INTRO_ELIGIBILITY_STATUS_INELIGIBLE: 1,
        INTRO_ELIGIBILITY_STATUS_ELIGIBLE: 2, INTRO_ELIGIBILITY_STATUS_NO_INTRO_OFFER_EXISTS: 3
      };
      Purchases.PURCHASES_ERROR_CODE = {
        UNKNOWN_ERROR: '0', PURCHASE_CANCELLED_ERROR: '1', STORE_PROBLEM_ERROR: '2',
        PURCHASE_NOT_ALLOWED_ERROR: '3', PURCHASE_INVALID_ERROR: '4',
        PRODUCT_NOT_AVAILABLE_FOR_PURCHASE_ERROR: '5', PRODUCT_ALREADY_PURCHASED_ERROR: '6',
        RECEIPT_ALREADY_IN_USE_ERROR: '7', INVALID_RECEIPT_ERROR: '8',
        MISSING_RECEIPT_FILE_ERROR: '9', NETWORK_ERROR: '10', INVALID_CREDENTIALS_ERROR: '11',
        UNEXPECTED_BACKEND_RESPONSE_ERROR: '12', OPERATION_ALREADY_IN_PROGRESS_ERROR: '15',
        UNSUPPORTED_ERROR: '24', CONFIGURATION_ERROR: '23'
      };
    `,
  },
  // Sentry crash reporting: JS-heavy SDK whose native hooks don't exist here, and
  // whose bundle weight buys the preview nothing. Silent no-op tier — no banner:
  // monitoring is invisible UI-wise, so a notice would only confuse. wrap()/
  // ErrorBoundary pass children through untouched; capture/init/setUser are no-ops.
  // The rapidnative `sentry` skill routes access through a facade that skips the
  // SDK in the preview anyway — this stub is the safety net for direct imports.
  "@sentry/react-native": {
    mode: "unsupported",
    stub: `
      var React = require('react');
      function _noop() {}
      function _id(x) { return x; }
      function ErrorBoundary(props) { return (props && props.children) || null; }
      function TouchEventBoundary(props) { return (props && props.children) || null; }
      var _scope = {
        setUser: _noop, setTag: _noop, setTags: _noop, setExtra: _noop, setExtras: _noop,
        setContext: _noop, setLevel: _noop, addBreadcrumb: _noop, clear: _noop
      };
      var Sentry = {
        init: _noop, close: function () { return Promise.resolve(true); },
        wrap: _id,
        captureException: function () { return ''; },
        captureMessage: function () { return ''; },
        captureEvent: function () { return ''; },
        setUser: _noop, setTag: _noop, setTags: _noop, setExtra: _noop, setExtras: _noop,
        setContext: _noop, addBreadcrumb: _noop,
        withScope: function (cb) { try { cb(_scope); } catch (e) {} },
        configureScope: function (cb) { try { cb(_scope); } catch (e) {} },
        getCurrentScope: function () { return _scope; },
        startSpan: function (opts, cb) { return typeof cb === 'function' ? cb({ end: _noop, setStatus: _noop }) : undefined; },
        startInactiveSpan: function () { return { end: _noop, setStatus: _noop }; },
        addIntegration: _noop, lastEventId: function () { return undefined; },
        flush: function () { return Promise.resolve(true); },
        nativeCrash: _noop,
        reactNavigationIntegration: function () { return { name: 'ReactNavigation' }; },
        reactNativeTracingIntegration: function () { return { name: 'ReactNativeTracing' }; },
        mobileReplayIntegration: function () { return { name: 'MobileReplay' }; },
        feedbackIntegration: function () { return { name: 'Feedback' }; },
        ErrorBoundary: ErrorBoundary,
        TouchEventBoundary: TouchEventBoundary,
        Mask: function (props) { return React.createElement(React.Fragment, null, (props && props.children) || null); },
        Unmask: function (props) { return React.createElement(React.Fragment, null, (props && props.children) || null); }
      };
      module.exports = Sentry;
      Sentry.default = Sentry;
      Sentry.__esModule = true;
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
    // These are real native npm packages — the shim keeps the WEB preview working,
    // but they must still be in package.json for the native build to resolve them.
    // The bundler fails if one is imported but undeclared (see findUndeclaredNativePackages).
    nativePackages() {
      return Object.keys(UNSUPPORTED_WEB_PACKAGES);
    },
  };
}
