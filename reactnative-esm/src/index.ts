import express, { Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import os from "os";
import { execSync } from "child_process";
import esbuild from "esbuild";

const app = express();
const CACHE_DIR = path.join(__dirname, "..", "cache");
const PORT = 5200;

// Ensure cache dir exists
fs.mkdirSync(CACHE_DIR, { recursive: true });

// CORS for browser access
app.use((req: Request, res: Response, next: NextFunction) => {
	res.header("Access-Control-Allow-Origin", "*");
	res.header("Access-Control-Expose-Headers", "X-Externals");
	next();
});

// Parse unpkg-style specifier into { pkgName, version, subpath }
function parseSpecifier(raw: string) {
	let pkgName: string;
	let version: string;
	let subpath: string = "";

	if (raw.startsWith("@")) {
		// Scoped: @scope/name@ver/sub
		const slashIdx = raw.indexOf("/");
		if (slashIdx === -1) return null;
		const secondSlash = raw.indexOf("/", slashIdx + 1);
		if (secondSlash === -1) {
			pkgName = raw;
		} else {
			pkgName = raw.slice(0, secondSlash);
			subpath = raw.slice(secondSlash);
		}
	} else {
		const slashIdx = raw.indexOf("/");
		if (slashIdx === -1) {
			pkgName = raw;
		} else {
			pkgName = raw.slice(0, slashIdx);
			subpath = raw.slice(slashIdx);
		}
	}

	// Extract version from pkgName
	const atIdx = pkgName.lastIndexOf("@");
	if (atIdx > 0) {
		version = pkgName.slice(atIdx + 1);
		pkgName = pkgName.slice(0, atIdx);
	} else {
		version = "latest";
	}

	return { pkgName, version, subpath };
}

// Bundle and serve an npm package
async function handlePkgRequest(res: Response, pkgName: string, version: string, subpath: string) {
	const requireSpecifier = pkgName + subpath;
	const cacheKey = `${pkgName.replace(/\//g, "__")}@${version}${subpath.replace(/\//g, "__")}`;
	const cacheFile = path.join(CACHE_DIR, `${cacheKey}.js`);

	// Check disk cache
	const externalsFile = path.join(CACHE_DIR, `${cacheKey}.externals.json`);
	if (fs.existsSync(cacheFile)) {
		console.log(`[cache hit] ${requireSpecifier}@${version}`);
		if (fs.existsSync(externalsFile)) {
			res.header("X-Externals", fs.readFileSync(externalsFile, "utf-8"));
		}
		res.type("application/javascript").sendFile(cacheFile);
		return;
	}

	console.log(`[bundling] ${requireSpecifier}@${version}`);
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pkg-"));

	try {
		execSync("npm init -y", { cwd: tmpDir, stdio: "ignore" });
		execSync(`npm install ${pkgName}@${version} --legacy-peer-deps`, {
			cwd: tmpDir,
			stdio: "ignore",
			timeout: 60000,
		});

		// Resolve the actual installed version (semver range -> exact)
		const installedPkgJson = path.join(tmpDir, "node_modules", pkgName, "package.json");
		let resolvedVersion = version;
		if (fs.existsSync(installedPkgJson)) {
			const meta = JSON.parse(fs.readFileSync(installedPkgJson, "utf-8"));
			if (meta.version) {
				resolvedVersion = meta.version;
				// Check if we already have a cache for the resolved exact version
				const resolvedCacheKey = `${pkgName.replace(/\//g, "__")}@${resolvedVersion}${subpath.replace(/\//g, "__")}`;
				const resolvedCacheFile = path.join(CACHE_DIR, `${resolvedCacheKey}.js`);
				const resolvedExternalsFile = path.join(CACHE_DIR, `${resolvedCacheKey}.externals.json`);
				if (fs.existsSync(resolvedCacheFile)) {
					console.log(`[cache hit] ${requireSpecifier}@${resolvedVersion} (resolved from ${version})`);
					if (fs.existsSync(resolvedExternalsFile)) {
						res.header("X-Externals", fs.readFileSync(resolvedExternalsFile, "utf-8"));
					}
					res.type("application/javascript").sendFile(resolvedCacheFile);
					fs.rmSync(tmpDir, { recursive: true, force: true });
					return;
				}
			}
		}

		// Use resolved version for cache key from now on
		const resolvedCacheKey = `${pkgName.replace(/\//g, "__")}@${resolvedVersion}${subpath.replace(/\//g, "__")}`;
		const resolvedCacheFile = path.join(CACHE_DIR, `${resolvedCacheKey}.js`);
		const resolvedExternalsFile = path.join(CACHE_DIR, `${resolvedCacheKey}.externals.json`);

		// Read package metadata to detect RN/Expo packages and collect externals.
		// We externalize ALL dependencies (not just peerDependencies) so that
		// shared transitive deps (e.g. @react-navigation/core) are loaded once
		// at runtime rather than inlined into every bundle that uses them.
		let externals: string[] = [];
		let isReactNative = false;
		let keywords: string[] = [];
		if (fs.existsSync(installedPkgJson)) {
			const meta = JSON.parse(fs.readFileSync(installedPkgJson, "utf-8"));
			const deps = Object.keys(meta.dependencies || {});
			const peerDeps = Object.keys(meta.peerDependencies || {});
			externals = [...new Set([...deps, ...peerDeps])];
			keywords = Array.isArray(meta.keywords) ? meta.keywords : [];
			isReactNative =
				pkgName.startsWith("@expo/") ||
				pkgName.includes("react-native") ||
				keywords.some((k: string) => k === "react-native" || k === "expo");
		}

		if (isReactNative) {
			// Always externalize react-native for RN/Expo packages -- the runtime
			// resolves it to react-native-web. Many packages use it without listing
			// it as a dep.
			for (const dep of ["react-native", "react", "react-dom"]) {
				if (!externals.includes(dep)) externals.push(dep);
			}
		}

		// Don't externalize a package from itself (would create circular require).
		externals = externals.filter((dep) => dep !== requireSpecifier && !requireSpecifier.startsWith(dep + "/"));

		const entryFile = path.join(tmpDir, "__entry.js");
		fs.writeFileSync(
			entryFile,
			`module.exports = require("${requireSpecifier}");\n`
		);

		// Externalize bare package imports (e.g. "react") so shared deps are
		// loaded once. For subpath imports (e.g. "css-in-js-utils/lib/foo"),
		// generally inline them since they're internal implementation details.
		// Exception: react/react-dom/react-native subpaths are always externalized
		// because inlining them embeds version-sensitive code from the temp dir.
		const externalSet = new Set(externals);
		// Track which deps were actually externalized and their installed versions.
		// This map is sent as the X-Externals response header so the bundler can
		// fetch transitive deps at pinned versions instead of @latest.
		const externalizedMap: Record<string, string> = {};

		function getInstalledVersion(pkg: string): string | null {
			try {
				const depPkgJson = path.join(tmpDir, "node_modules", pkg, "package.json");
				const depMeta = JSON.parse(fs.readFileSync(depPkgJson, "utf-8"));
				return depMeta.version;
			} catch {
				return null;
			}
		}

		// Packages whose subpath imports must also be externalized to avoid
		// inlining version-sensitive code from the temp dir (e.g. react-dom/client
		// contains a version check against require("react").version).
		const alwaysExternalSubpaths = new Set(["react", "react-dom", "react-native"]);

		// Filter out native platform files (.android.*, .ios.*, .windows.*)
		// so esbuild only bundles .web.* or plain .js/.ts files for the browser.
		const filterNativePlatformsPlugin: esbuild.Plugin = {
			name: "filter-native-platforms",
			setup(build) {
				build.onLoad(
					{ filter: /\.(android|ios|windows)\.[jt]sx?$/ },
					() => ({ contents: "", loader: "js" })
				);
			},
		};

		const selectiveExternalPlugin: esbuild.Plugin = {
			name: "selective-external",
			setup(build) {
				build.onResolve({ filter: /^[^./]/ }, (args) => {
					let pkg: string;
					if (args.path.startsWith("@")) {
						const parts = args.path.split("/");
						pkg = parts.length >= 2 ? parts.slice(0, 2).join("/") : args.path;
					} else {
						pkg = args.path.split("/")[0];
					}
					if (!externalSet.has(pkg)) return null;

					// Track installed version for the base package
					if (!externalizedMap[pkg]) {
						const version = getInstalledVersion(pkg);
						if (version) externalizedMap[pkg] = version;
					}

					// Bare import: always externalize
					if (args.path === pkg) {
						return { path: pkg, external: true };
					}

					// Subpath import: for version-sensitive packages (react, react-dom,
					// react-native), always externalize to avoid inlining mismatched
					// versions. For other packages, try to resolve locally and inline.
					if (alwaysExternalSubpaths.has(pkg)) {
						return { path: args.path, external: true };
					}

					try {
						require.resolve(args.path, { paths: [args.resolveDir] });
						return null;
					} catch {
						return { path: args.path, external: true };
					}
				});
			},
		};

		const outFile = path.join(tmpDir, "__out.js");
		await esbuild.build({
			entryPoints: [entryFile],
			bundle: true,
			format: "iife",
			globalName: "__module",
			outfile: outFile,
			platform: "browser",
			target: "es2020",
			// For RN/Expo packages: prioritize .web.* extensions, handle JSX in .js,
			// and inline font/image assets as data URLs.
			...(isReactNative && {
				resolveExtensions: [
					".web.tsx", ".web.ts", ".web.js",
					".tsx", ".ts", ".js", ".json",
				],
				loader: {
					".js": "jsx",
					".ttf": "dataurl", ".otf": "dataurl", ".png": "dataurl",
				},
				banner: {
					js: "var process = { env: { NODE_ENV: 'production' } }; var React = require('react');",
				},
				define: {
					"__DEV__": "false",
				},
			}),
			plugins: [
				...(isReactNative ? [filterNativePlatformsPlugin] : []),
				selectiveExternalPlugin,
			],
		});

		const bundled = fs.readFileSync(outFile, "utf-8");
		const wrapped = `// Bundled: ${requireSpecifier}@${resolvedVersion}\n// Externals: ${externals.join(", ") || "none"}\n${bundled}\nif (typeof __module !== "undefined") { module.exports = __module; }\n`;

		fs.writeFileSync(resolvedCacheFile, wrapped);
		const externalsJson = JSON.stringify(externalizedMap);
		fs.writeFileSync(resolvedExternalsFile, externalsJson);
		console.log(`[cached] ${requireSpecifier}@${resolvedVersion} (externals: ${Object.keys(externalizedMap).length})`);

		res.header("X-Externals", externalsJson);
		res.header("X-Resolved-Version", resolvedVersion);
		res.type("application/javascript").send(wrapped);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[error] ${requireSpecifier}@${version}:`, message);
		if (!res.headersSent) {
			res.status(500).send(`// Error bundling ${requireSpecifier}@${version}\n// ${message}\n`);
		}
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

// GET /pkg/* - unpkg-style URLs:
//   /pkg/lodash           -> lodash@latest
//   /pkg/lodash@4.17.21   -> lodash@4.17.21
//   /pkg/react-dom/client -> react-dom@latest, require("react-dom/client")
//   /pkg/react-dom@19/client -> react-dom@19, require("react-dom/client")
//   /pkg/@scope/name@1.0/sub -> @scope/name@1.0, require("@scope/name/sub")
app.use((req: Request, res: Response, next: NextFunction) => {
	if (req.method !== "GET" || !req.path.startsWith("/pkg/")) { next(); return; }
	const raw = decodeURIComponent(req.path.slice("/pkg/".length));
	if (!raw) { next(); return; }

	const parsed = parseSpecifier(raw);
	if (!parsed) { res.status(400).send("// Invalid package specifier\n"); return; }

	handlePkgRequest(res, parsed.pkgName, parsed.version, parsed.subpath).catch(
		(err) => {
			console.error("[unhandled]", err);
			if (!res.headersSent) res.status(500).send("// Internal error\n");
		}
	);
});

app.listen(PORT, () => {
	console.log(`Package server running at http://localhost:${PORT}`);
});
