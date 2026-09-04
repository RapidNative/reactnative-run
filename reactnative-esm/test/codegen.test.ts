// codegenNativeComponent view-config pass (New Architecture). Pinned here so an
// upstream rename of the spec convention, or a babel-preset change that stops
// emitting __INTERNAL_VIEW_CONFIG, fails CI instead of shipping a bundle that
// redboxes on device with "View config not found for component <Name>".

import { test } from "node:test";
import assert from "node:assert/strict";
import { CODEGEN_SPEC_FILE_RE, CODEGEN_HINT_RE, RN_CORE_RE, codegenViewConfig } from "../src/codegen";

// The two real-world spec filename conventions, plus the shapes we must NOT eat.
const MATCH = [
	// react-native-screens: *NativeComponent.ts under src/fabric/
	"/x/node_modules/react-native-screens/src/fabric/ScreenContentWrapperNativeComponent.ts",
	// react-native-safe-area-context: Native<Name>.ts under src/specs/
	"/x/node_modules/react-native-safe-area-context/src/specs/NativeSafeAreaProvider.ts",
	// .js flavour of both
	"/x/node_modules/some-lib/NativeThing.js",
	"/x/node_modules/some-lib/ThingNativeComponent.js",
];
const NO_MATCH = [
	"/x/node_modules/expo-linking/build/Linking.js", // ordinary module
	"/x/node_modules/some-lib/src/native.ts", // lowercase after Native -> not a spec name
	"/x/node_modules/some-lib/Component.tsx", // .tsx: codegen parser can't handle it
	"/x/node_modules/some-lib/NativeThing.tsx", // even a Native* name, if .tsx
	"/x/src/specs/NativeSafeAreaView.ts", // outside node_modules
];

test("CODEGEN_SPEC_FILE_RE matches both RN spec conventions (.js/.ts only)", () => {
	for (const p of MATCH) assert.ok(CODEGEN_SPEC_FILE_RE.test(p), `should match ${p}`);
});

test("CODEGEN_SPEC_FILE_RE ignores ordinary modules, .tsx, and non-node_modules paths", () => {
	for (const p of NO_MATCH) assert.ok(!CODEGEN_SPEC_FILE_RE.test(p), `should NOT match ${p}`);
});

test("RN_CORE_RE excludes react-native core (handled by the strip-flow preset pass)", () => {
	assert.ok(RN_CORE_RE.test("/x/node_modules/react-native/Libraries/Foo/NativeFoo.js"));
	assert.ok(!RN_CORE_RE.test("/x/node_modules/react-native-screens/src/fabric/ScreenNativeComponent.ts"));
});

const VIEW_SPEC = `
import { codegenNativeComponent } from 'react-native';
import type { ViewProps } from 'react-native';
export interface NativeProps extends ViewProps { title?: string }
export default codegenNativeComponent<NativeProps>('RNSScreenContentWrapper', {});
`;

const TURBOMODULE_SPEC = `
import { TurboModuleRegistry, type TurboModule } from 'react-native';
export interface Spec extends TurboModule { getConstants(): {}; doThing(): void }
export default TurboModuleRegistry.get<Spec>('RNSomeModule');
`;

test("codegenViewConfig turns a component spec into a NativeComponentRegistry view config", async () => {
	const out = await codegenViewConfig(VIEW_SPEC, "/x/node_modules/rns/ScreenContentWrapperNativeComponent.ts");
	assert.ok(out != null, "should transform");
	assert.match(out!, /__INTERNAL_VIEW_CONFIG/);
	assert.match(out!, /NativeComponentRegistry\.get/);
	// The component name from the codegenNativeComponent() argument survives.
	assert.match(out!, /RNSScreenContentWrapper/);
});

test("codegenViewConfig content-gate: preserves the codegenNativeComponent anchor", () => {
	assert.ok(CODEGEN_HINT_RE.test(VIEW_SPEC));
	assert.ok(!CODEGEN_HINT_RE.test(TURBOMODULE_SPEC));
});

test("codegenViewConfig returns null for a TurboModule spec (no view config, falls through to esbuild)", async () => {
	const out = await codegenViewConfig(TURBOMODULE_SPEC, "/x/node_modules/rns/NativeSomeModule.ts");
	assert.equal(out, null);
});
