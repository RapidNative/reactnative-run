(function(modules) {
  var cache = {};
  function require(id) {
    if (cache[id]) return cache[id].exports;
    if (!modules[id]) throw new Error('Module not found: ' + id);
    var module = cache[id] = { exports: {} };
    modules[id].call(module.exports, module, module.exports, require);
    return module.exports;
  }
  require("/index.tsx");
})({
"/index.tsx": function(module, exports, require) {
"use strict"; function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
var _expo = require('expo');
var _App = require("/App.tsx"); var _App2 = _interopRequireDefault(_App);

_expo.registerRootComponent.call(void 0, _App2.default);

},

"/App.tsx": function(module, exports, require) {
"use strict";const _jsxFileName = "";Object.defineProperty(exports, "__esModule", {value: true}); function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }var _react = require('react'); var _react2 = _interopRequireDefault(_react);
var _expostatusbar = require('expo-status-bar');
var _reactnative = require('react-native');

 function App() {
  return (
    _react2.default.createElement(_reactnative.View, { style: styles.container, __self: this, __source: {fileName: _jsxFileName, lineNumber: 7}}
      , _react2.default.createElement(_reactnative.Text, {__self: this, __source: {fileName: _jsxFileName, lineNumber: 8}}, "Open up App.tsx to start working on your app!"        )
      , _react2.default.createElement(_expostatusbar.StatusBar, { style: "auto", __self: this, __source: {fileName: _jsxFileName, lineNumber: 9}} )
    )
  );
} exports.default = App;

const styles = _reactnative.StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
});

}
});
