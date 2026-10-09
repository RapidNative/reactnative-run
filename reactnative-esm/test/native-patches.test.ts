// react-native-css-interop's dev-only upgrade warning red-screened apps with "Couldn't find a
// navigation context" (nativewind/nativewind#1812). Native builds now swap its props serializer
// for one that cannot throw or walk into React internals; web bytes are untouched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeNativePatchesPlugin, patchNativeSource } from "../src/native-patches";

const RENDER_COMPONENT = "/tmp/b/node_modules/react-native-css-interop/dist/runtime/native/render-component.js";

// Verbatim from react-native-css-interop 0.2.7's dist (0.1.22 and 0.2.1 are identical here), plus
// an export so the test can call it.
const UPSTREAM = `"use strict";
function printUpgradeWarning(warning, originalProps) {
    console.log(\`CssInterop upgrade warning.\\n\\n\${warning}.\\n\\nThis warning was caused by a component with the props:\\n\${stringify(originalProps)}\\n\\nIf adding or removing sibling components caused this warning you should add a unique "key" prop to your components. https://react.dev/learn/rendering-lists#keeping-list-items-in-order-with-key\\n\`);
}
function stringify(object) {
    const seen = new WeakSet();
    return JSON.stringify(object, function replace(_, value) {
        if (!(value !== null && typeof value === "object")) {
            return value;
        }
        if (seen.has(value)) {
            return "[Circular]";
        }
        seen.add(value);
        const newValue = Array.isArray(value) ? [] : {};
        for (const entry of Object.entries(value)) {
            newValue[entry[0]] = replace(entry[0], entry[1]);
        }
        seen.delete(value);
        return newValue;
    }, 2);
}
exports.printUpgradeWarning = printUpgradeWarning;
`;

type Warn = (warning: string, props: unknown) => void;

function load(source: string): { printUpgradeWarning: Warn; logs: string[] } {
	const logs: string[] = [];
	const exports: { printUpgradeWarning?: Warn } = {};
	new Function("exports", "console", source)(exports, { log: (m: string) => logs.push(m) });
	return { printUpgradeWarning: exports.printUpgradeWarning!, logs };
}

function quietly<T>(fn: () => T): { result: T; warnings: string[] } {
	const warnings: string[] = [];
	const original = console.warn;
	console.warn = (m: string) => warnings.push(m);
	try {
		return { result: fn(), warnings };
	} finally {
		console.warn = original;
	}
}

const MISSING_CONTEXT = "Couldn't find a navigation context. Have you wrapped your app with 'NavigationContainer'?";

/** The shape that crashed on device: a child element's _owner is a fiber under the screen's
 *  NavigationStateContext provider, whose default value throws from its getters (React Native
 *  is the primary renderer, so _currentValue2 always holds that default). */
function seatCardProps() {
	const defaultValue = {
		isDefault: true,
		get getKey(): never {
			throw new Error(MISSING_CONTEXT);
		},
	};
	const NavigationStateContext = {
		$$typeof: Symbol.for("react.context"),
		_currentValue: defaultValue,
		_currentValue2: defaultValue,
	};
	const provider = { tag: 10, type: NavigationStateContext, return: null };
	const owner = { tag: 0, type: function SeatInfoCard() {}, return: provider };
	const element = (type: unknown, props: object) => ({
		$$typeof: Symbol.for("react.transitional.element"),
		type,
		key: null,
		props,
		_owner: owner,
	});
	return {
		className: "rounded-2xl bg-card px-4 py-3 shadow-sm shadow-black/5",
		children: [element(function Text() {}, { children: "Seat 07" }), element("RCTView", {})],
	};
}

const WARNING = "Components need to set a variable during the initial render otherwise they will remount";

test("upstream's warning throws the navigation error (the bug this patches)", () => {
	const upstream = load(UPSTREAM);
	assert.throws(() => upstream.printUpgradeWarning(WARNING, seatCardProps()), /Couldn't find a navigation context/);
});

test("the patched warning prints, naming child elements instead of walking into them", () => {
	const patched = load(patchNativeSource(RENDER_COMPONENT, UPSTREAM));
	patched.printUpgradeWarning(WARNING, seatCardProps());
	assert.equal(patched.logs.length, 1);
	const [log] = patched.logs;
	assert.match(log, /^CssInterop upgrade warning\.\n\nComponents need to set a variable/);
	assert.match(log, /"className": "rounded-2xl bg-card px-4 py-3 shadow-sm shadow-black\/5"/);
	assert.match(log, /"<Text \/>"/);
	assert.match(log, /"<RCTView \/>"/);
	assert.doesNotMatch(log, /isDefault|_owner/, "React internals stay out of the log");
});

test("a throwing getter on an ordinary prop is marked, not fatal", () => {
	const patched = load(patchNativeSource(RENDER_COMPONENT, UPSTREAM));
	const style = {
		height: 2,
		get width(): never {
			throw new Error("boom");
		},
	};
	patched.printUpgradeWarning(WARNING, { style });
	assert.match(patched.logs[0], /"width": "\[unreadable\]"/);
	assert.match(patched.logs[0], /"height": 2/);
});

test("anything that still throws prints a placeholder instead", () => {
	const patched = load(patchNativeSource(RENDER_COMPONENT, UPSTREAM));
	const when = {
		toJSON(): never {
			throw new Error("boom");
		},
	};
	patched.printUpgradeWarning(WARNING, { when });
	assert.match(patched.logs[0], /component with the props:\n\[props could not be printed\]\n/);
});

test("each object is visited once, so shared and circular graphs finish", { timeout: 5000 }, () => {
	const patched = load(patchNativeSource(RENDER_COMPONENT, UPSTREAM));
	const circular: Record<string, unknown> = { name: "loop" };
	circular.self = circular;
	// 2^40 paths to the bottom: upstream forgets each node on the way back out and walks it again
	// for every path, so it never finishes.
	let shared: Record<string, unknown> = { leaf: true };
	for (let i = 0; i < 40; i++) shared = { left: shared, right: shared };
	patched.printUpgradeWarning(WARNING, { circular, shared });
	assert.match(patched.logs[0], /"self": "\[Circular\]"/);
	assert.match(patched.logs[0], /"leaf": true/);
});

test("the patch only touches css-interop's native render-component, and needs its anchor", () => {
	assert.equal(patchNativeSource("/tmp/b/node_modules/other/render-component.js", UPSTREAM), UPSTREAM);
	assert.equal(
		patchNativeSource(RENDER_COMPONENT.replace("/native/", "/web/"), UPSTREAM),
		UPSTREAM,
		"web runtime file"
	);

	const renamed = UPSTREAM.replace("function stringify(object) {", "function serialize(object) {");
	const twice = `${UPSTREAM}\nfunction stringify(object) {}\n`;
	const unrelated = UPSTREAM.replace("stringify(originalProps)", "String(originalProps)");
	for (const source of [renamed, twice, unrelated]) {
		const { result, warnings } = quietly(() => patchNativeSource(RENDER_COMPONENT, source));
		assert.equal(result, source, "an unrecognised file ships unpatched");
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /\[native-patches\] css-interop upgrade-warning serializer did not apply/);
	}
});

test("the original serializer is renamed, not deleted", () => {
	const patched = patchNativeSource(RENDER_COMPONENT, UPSTREAM);
	assert.equal(patched.match(/function stringify\(object\) \{/g)?.length, 1);
	assert.match(patched, /function stringifyUnpatched\(object\) \{\n    const seen = new WeakSet\(\);/);
});

test("the plugin registers nothing on web", () => {
	const registered = (platform: "web" | "ios" | "android") => {
		const filters: RegExp[] = [];
		makeNativePatchesPlugin(platform).setup({
			onLoad: (options: { filter: RegExp }) => filters.push(options.filter),
		} as never);
		return filters;
	};
	assert.equal(registered("web").length, 0);
	for (const platform of ["ios", "android"] as const) {
		const [filter] = registered(platform);
		assert.ok(filter.test(RENDER_COMPONENT));
		assert.ok(filter.test(RENDER_COMPONENT.replace(/\//g, "\\")), "windows separators");
		assert.ok(!filter.test(RENDER_COMPONENT.replace("/native/", "/web/")));
	}
});
