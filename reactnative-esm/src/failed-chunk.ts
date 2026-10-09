import type { BuildPlatform } from "./platform";

/**
 * The chunk for a dependency the server could not build or install.
 *
 * It stays an empty module, so one broken package does not fail the whole bundle. But on native it
 * now says so when the app requires it: an empty @base44/sdk let the app start and then die with
 * "Cannot read property 'call' of undefined", nowhere near the cause, while the reason sat in a
 * comment nobody reads. Chunks evaluate on first require, so a package the app never imports stays
 * silent.
 *
 * Web keeps the old bytes exactly: its namespace is byte-frozen, and the editor turns console
 * errors into fix prompts that no code edit could satisfy.
 */
export function failedChunk(name: string, platform: BuildPlatform, reason: string, label = "Error bundling"): string {
	if (platform === "web") {
		// Collapsed to one line: a multi-line esbuild error after `//` would leave live JS behind.
		const safe = reason.replace(/[\r\n\t]+/g, " ").slice(0, 200);
		return `// @dep-start ${name}\n// ${label}: ${safe}\nmodule.exports = {};\n// @dep-end ${name}`;
	}
	// The build's temp directory is noise on a device. Each path loses everything up to its FIRST
	// node_modules/, so "../../../tmp/bundle-deps-x/node_modules/engine.io-client/node_modules/ws/…"
	// reads "engine.io-client/node_modules/ws/…" and still shows which package pulled the other in.
	const readable = reason
		.replace(/[^\s"'(]+/g, (token) => {
			const at = token.indexOf("node_modules/");
			return at === -1 ? token : token.slice(at + "node_modules/".length);
		})
		.replace(/[\r\n\t\u2028\u2029]+/g, " ")
		.slice(0, 300);
	const message = `[package server] ${name} could not be built for ${platform}, so it is empty here: ${readable}`;
	return `// @dep-start ${name}\n// ${label}: ${readable}\nconsole.error(${JSON.stringify(message)});\nmodule.exports = {};\n// @dep-end ${name}`;
}
