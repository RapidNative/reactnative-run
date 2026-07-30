import type { BundlerPlugin } from "../types.js";

/**
 * NOTE — `expo-modules-core` is intentionally NOT shimmed: it used to be
 * replaced with an inline web shim, but that was a mistake — it's the
 * foundation every Expo native module builds on, its public surface is large
 * and central, and any gap breaks a downstream package at runtime (e.g.
 * expo-image's `<Image>` crashed on a missing `createSnapshotFriendlyRef`).
 * It resolves to its real web build through the package server instead.
 *
 * `expo-speech-recognition` was previously shimmed (it predated the package's
 * web support), but it now ships a real web build (`*.web.js` wrapping the
 * browser Web Speech API). Since the package server's platform resolution
 * prefers `.web.*`, it resolves to that real build — no shim needed.
 */

/**
 * `react-native`, re-exported from react-native-web with a working Alert.
 *
 * react-native-web ships Alert as a silent no-op (Alert is an imperative
 * bridge into the OS dialog on native; there is no OS dialog on web, and RNW
 * chose not to invent a UI for it), so `Alert.alert(...)` renders NOTHING on
 * web — and any flow gated on an alert button (confirm sign-out, delete item)
 * can never proceed in the preview.
 *
 * This shim renders an iOS-style dialog in plain DOM — no React, so it works
 * no matter what state the app's tree is in, exactly like the imperative
 * native call it stands in for. Every button renders (including middle
 * buttons of 3+ button alerts), cancel/destructive styles apply, and
 * Alert.prompt gets a real text input.
 *
 * The override wraps the rnw namespace in a Proxy — it does NOT mutate rnw's
 * own Alert export. Interop layers can expose exports through frozen
 * namespaces or getter-only properties, where assignment fails silently and a
 * mutation-style patch never takes effect.
 *
 * Relies on the embedder's `react-native → react-native-web` alias having put
 * react-native-web in the fetch set (this shim replaces `react-native`, so
 * nothing else would pull rnw in). Shim injection runs after alias injection,
 * so this module wins over the alias's plain re-export.
 */
const REACT_NATIVE_WITH_ALERT = `
module.exports = require("react-native-web");
var __rnw = module.exports;
var __alertShim = (function () {
  function press(btn, value) {
    if (btn && typeof btn.onPress === "function") {
      try { btn.onPress(value); } catch (e) { console.error("[Alert shim]", e); }
    }
  }
  function el(tag, styles, textContent) {
    var node = document.createElement(tag);
    for (var k in styles) node.style[k] = styles[k];
    if (textContent) node.textContent = textContent;
    return node;
  }
  // iOS-alert-style dialog. buttons: RN AlertButton[]; withInput adds a text
  // field (Alert.prompt) whose value is passed to onPress. options.cancelable
  // (Android semantics): backdrop tap dismisses + fires options.onDismiss.
  function showDialog(title, message, buttons, options, withInput, defaultValue) {
    var list = Array.isArray(buttons) ? buttons.filter(Boolean) : [];
    if (list.length === 0) list = [{ text: "OK" }];

    var overlay = el("div", {
      position: "fixed", top: "0", right: "0", bottom: "0", left: "0",
      background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center",
      justifyContent: "center", zIndex: "999999",
    });
    var card = el("div", {
      background: "rgba(250,250,250,0.97)", borderRadius: "14px",
      width: "270px", maxWidth: "80vw", overflow: "hidden", textAlign: "center",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      boxShadow: "0 12px 40px rgba(0,0,0,0.3)",
    });
    if (title) card.appendChild(el("div", {
      padding: message || withInput ? "19px 16px 4px" : "19px 16px",
      fontWeight: "600", fontSize: "17px", color: "#000", lineHeight: "22px",
      whiteSpace: "pre-line", wordBreak: "break-word",
    }, String(title)));
    if (message) card.appendChild(el("div", {
      padding: title ? "0 16px 17px" : "19px 16px 17px",
      fontSize: "13px", color: "#242424", lineHeight: "18px",
      whiteSpace: "pre-line", wordBreak: "break-word",
    }, String(message)));

    var input = null;
    if (withInput) {
      input = el("input", {
        display: "block", width: "calc(100% - 32px)", margin: "0 16px 16px",
        padding: "7px 8px", fontSize: "13px", border: "1px solid #c9c9c9",
        borderRadius: "7px", boxSizing: "border-box", background: "#fff",
        outline: "none",
      });
      input.value = defaultValue || "";
      card.appendChild(input);
    }

    function close(btn) {
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      press(btn, input ? input.value : undefined);
    }
    var cancelBtn = null;
    for (var c = 0; c < list.length; c++) {
      if (list[c].style === "cancel") { cancelBtn = list[c]; break; }
    }
    function onKey(e) {
      if (e.key === "Escape") { e.stopPropagation(); close(cancelBtn || null); }
    }

    var row = list.length === 2; // iOS: exactly two buttons sit side by side
    var btnWrap = el("div", {
      display: "flex", flexDirection: row ? "row" : "column",
      borderTop: "1px solid rgba(0,0,0,0.15)",
    });
    for (var i = 0; i < list.length; i++) {
      (function (btn, idx) {
        var b = el("button", {
          flex: row ? "1" : "none", padding: "11px 8px", fontSize: "17px",
          background: "transparent", border: "none", cursor: "pointer",
          lineHeight: "22px",
          color: btn.style === "destructive" ? "#FF3B30" : "#007AFF",
          fontWeight: btn.style === "cancel" ? "600" : "400",
          borderLeft: row && idx > 0 ? "1px solid rgba(0,0,0,0.15)" : "none",
          borderTop: !row && idx > 0 ? "1px solid rgba(0,0,0,0.15)" : "none",
        }, btn.text || "OK");
        b.onmouseenter = function () { b.style.background = "rgba(0,0,0,0.06)"; };
        b.onmouseleave = function () { b.style.background = "transparent"; };
        b.onclick = function () { close(btn); };
        btnWrap.appendChild(b);
      })(list[i], i);
    }
    card.appendChild(btnWrap);
    overlay.appendChild(card);

    if (options && options.cancelable) {
      overlay.onclick = function (e) {
        if (e.target !== overlay) return;
        overlay.remove();
        document.removeEventListener("keydown", onKey, true);
        if (typeof options.onDismiss === "function") {
          try { options.onDismiss(); } catch (err) { console.error("[Alert shim]", err); }
        }
      };
    }
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(overlay);
    if (input) input.focus();
  }
  return {
    alert: function (title, message, buttons, options) {
      showDialog(title, message, buttons, options, false);
    },
    prompt: function (title, message, callbackOrButtons, _type, defaultValue) {
      var buttons;
      if (typeof callbackOrButtons === "function") {
        buttons = [
          { text: "Cancel", style: "cancel" },
          { text: "OK", onPress: callbackOrButtons },
        ];
      } else {
        buttons = callbackOrButtons;
      }
      showDialog(title, message, buttons, null, true, defaultValue);
    },
  };
})();
try {
  module.exports = new Proxy(__rnw, {
    get: function (target, prop, receiver) {
      if (prop === "Alert") return __alertShim;
      return Reflect.get(target, prop, receiver);
    },
  });
  console.info("[browser-metro] Alert shim active (react-native shim)");
} catch (e) {
  /* Proxy misbehaving — keep the plain re-export (Alert stays a no-op) */
}
`;

export function createExpoWebShimsPlugin(): BundlerPlugin {
  return {
    name: "expo-web-shims",
    shimModules() {
      return {
        "react-native": REACT_NATIVE_WITH_ALERT,
      };
    },
  };
}
