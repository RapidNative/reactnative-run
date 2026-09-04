// codegenNativeComponent -> static JS view config (New Architecture).
//
// On the New Architecture / bridgeless (`global.RN$Bridgeless === true`, which
// SDK 50+ Expo Go and every RN 0.76+ app runs) RN's `codegenNativeComponent`
// REQUIRES the build-time codegen transform: its runtime fallback is
// `requireNativeComponent`, which the RN source itself notes is "not available
// in Bridgeless mode" -- so an untransformed spec throws
// `Invariant Violation: View config not found for component <Name>` the moment
// it renders. react-native-screens 4.x is the common trigger (its
// `src/fabric/*NativeComponent.ts` specs power every expo-router Stack) and
// react-native-safe-area-context another (`src/specs/Native*.ts`), but any
// package shipping the pattern hits it. Metro runs
// @react-native/babel-plugin-codegen (part of @react-native/babel-preset) over
// every package; we do the same, but narrowly.

/** The two RN codegen-spec filename conventions, native only:
 *  `*NativeComponent.{js,ts}` (react-native-screens' `src/fabric/*`) and
 *  `Native<Name>.{js,ts}` (react-native-safe-area-context's `src/specs/*`).
 *  `.js`/`.ts` ONLY -- the codegen parser rejects `.tsx`/`.jsx`, and real specs
 *  never carry JSX. Same-named TurboModule specs (`Native<Name>.ts` exporting
 *  `TurboModuleRegistry.get`) also match the name but are dropped by
 *  CODEGEN_HINT_RE, which requires an actual `codegenNativeComponent` call. */
export const CODEGEN_SPEC_FILE_RE = /node_modules[/\\].*(?:[/\\]Native[A-Z][^/\\]*|NativeComponent)\.[cm]?[jt]s$/;

/** Content gate: only files that actually call codegenNativeComponent. */
export const CODEGEN_HINT_RE = /codegenNativeComponent/;

/** react-native CORE is handled by makeStripFlowPlugin's full preset (codegen
 *  included), earlier in the plugin stack -- exclude it here. */
export const RN_CORE_RE = /node_modules[/\\]react-native[/\\]/;

/** Run @react-native/babel-preset (which includes @react-native/babel-plugin-codegen)
 *  over a NativeComponent spec, returning the compiled JS if it produced a view
 *  config, or null otherwise. `null` means: not actually a codegen component
 *  spec (e.g. a TurboModule that slipped the filename gate, or an upstream
 *  refactor that broke the pattern) -- the caller then falls through to esbuild.
 *  A null on a file that DID call codegenNativeComponent is a loud regression:
 *  the component will crash on the New Architecture, so it is logged. */
export async function codegenViewConfig(src: string, filename: string): Promise<string | null> {
	if (!CODEGEN_HINT_RE.test(src)) return null;
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const babel = require("@babel/core") as typeof import("@babel/core");
		const result = await babel.transformAsync(src, {
			filename,
			presets: [[require.resolve("@react-native/babel-preset"), { enableBabelRuntime: false }]],
			babelrc: false,
			configFile: false,
			compact: false,
			sourceMaps: false,
		});
		if (result?.code == null) return null;
		if (!result.code.includes("__INTERNAL_VIEW_CONFIG")) {
			console.warn(`[codegen] ${filename} calls codegenNativeComponent but produced no view config; New-Arch render will crash -- falling through`);
			return null;
		}
		return result.code;
	} catch (err) {
		console.warn(`[codegen] transform failed for ${filename}: ${(err as Error).message.slice(0, 200)}`);
		return null;
	}
}
