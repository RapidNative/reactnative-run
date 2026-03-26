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

// JSON body parser for POST endpoints
app.use(express.json({ limit: "1mb" }));

// CORS for browser access
app.use((req: Request, res: Response, next: NextFunction) => {
	res.header("Access-Control-Allow-Origin", "*");
	res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	res.header("Access-Control-Allow-Headers", "Content-Type");
	res.header("Access-Control-Expose-Headers", "X-Externals");
	if (req.method === "OPTIONS") { res.sendStatus(204); return; }
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
// Resolve a semver range to an exact version via npm view (no install needed)
function resolveVersionQuick(pkgName: string, range: string): string | null {
	try {
		const result = execSync(`npm view ${pkgName}@${range} version`, {
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 10000,
		}).toString().trim();
		// npm view can return multiple lines for ranges; take the last (highest)
		const lines = result.split("\n");
		return lines[lines.length - 1].replace(/^'|'$/g, "").trim();
	} catch {
		return null;
	}
}

function cacheKeyFor(pkgName: string, version: string, subpath: string): string {
	return `${pkgName.replace(/\//g, "__")}@${version}${subpath.replace(/\//g, "__")}`;
}

function serveCached(res: Response, cacheFile: string, externalsFile: string, label: string): boolean {
	if (!fs.existsSync(cacheFile)) return false;
	console.log(`[cache hit] ${label}`);
	if (fs.existsSync(externalsFile)) {
		res.header("X-Externals", fs.readFileSync(externalsFile, "utf-8"));
	}
	res.type("application/javascript").sendFile(cacheFile);
	return true;
}

async function handlePkgRequest(res: Response, pkgName: string, version: string, subpath: string) {
	const requireSpecifier = pkgName + subpath;

	// 1. Check exact cache (works for exact versions like "6.0.12")
	const exactKey = cacheKeyFor(pkgName, version, subpath);
	const exactCache = path.join(CACHE_DIR, `${exactKey}.js`);
	const exactExternals = path.join(CACHE_DIR, `${exactKey}.externals.json`);
	if (serveCached(res, exactCache, exactExternals, `${requireSpecifier}@${version}`)) return;

	// 2. For semver ranges, quick-resolve to exact version and check cache
	let resolvedVersion = version;
	const isRange = /[~^<>=*|]/.test(version) || version === "latest";
	if (isRange) {
		const quick = resolveVersionQuick(pkgName, version);
		if (quick && quick !== version) {
			resolvedVersion = quick;
			const resolvedKey = cacheKeyFor(pkgName, resolvedVersion, subpath);
			const resolvedCache = path.join(CACHE_DIR, `${resolvedKey}.js`);
			const resolvedExternals = path.join(CACHE_DIR, `${resolvedKey}.externals.json`);
			if (serveCached(res, resolvedCache, resolvedExternals, `${requireSpecifier}@${resolvedVersion} (resolved from ${version})`)) return;
		}
	}

	// 3. No cache - install and bundle
	console.log(`[bundling] ${requireSpecifier}@${version}`);
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pkg-"));

	try {
		execSync("npm init -y", { cwd: tmpDir, stdio: "ignore" });
		execSync(`npm install ${pkgName}@${version} --legacy-peer-deps`, {
			cwd: tmpDir,
			stdio: "ignore",
			timeout: 60000,
		});

		// Get the actual installed version
		const installedPkgJson = path.join(tmpDir, "node_modules", pkgName, "package.json");
		if (fs.existsSync(installedPkgJson)) {
			const meta = JSON.parse(fs.readFileSync(installedPkgJson, "utf-8"));
			if (meta.version) resolvedVersion = meta.version;
		}

		// Final cache key uses resolved exact version
		const finalKey = cacheKeyFor(pkgName, resolvedVersion, subpath);
		const finalCacheFile = path.join(CACHE_DIR, `${finalKey}.js`);
		const finalExternalsFile = path.join(CACHE_DIR, `${finalKey}.externals.json`);

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

			// For RN/Expo packages: don't externalize @react-native/* utility
			// packages (e.g. @react-native/normalize-colors) that are installed
			// as direct deps - they should be inlined since they're small utils.
			// They'll only be externalized by the plugin if not locally resolvable.
			if (isReactNative) {
				externals = externals.filter(dep => !dep.startsWith("@react-native/"));
			}
		}

		if (isReactNative) {
			// Always externalize react-native and Expo platform modules for RN/Expo
			// packages. Many packages use these without listing them as deps,
			// expecting them to be available via the Expo/RN runtime.
			const implicitExternals = [
				"react-native", "react", "react-dom",
				"expo", "expo-modules-core", "expo-modules-autolinking",
				"expo-constants", "expo-linking", "expo-status-bar",
				"expo-splash-screen", "expo-font", "expo-asset",
			];
			for (const dep of implicitExternals) {
				if (!externals.includes(dep)) externals.push(dep);
			}

			// Scan node_modules for any @react-native/* and @expo/* scoped
			// packages and externalize them - they're platform modules that
			// should be loaded at runtime, not inlined.
			for (const scope of ["@react-native", "@expo"]) {
				const scopeDir = path.join(tmpDir, "node_modules", scope);
				if (fs.existsSync(scopeDir)) {
					for (const entry of fs.readdirSync(scopeDir)) {
						const scopedName = `${scope}/${entry}`;
						if (!externals.includes(scopedName)) externals.push(scopedName);
					}
				}
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

					// For RN/Expo builds, externalize @react-native/* and @expo/*
					// scoped packages that can't be resolved locally. If they're
					// installed (e.g. @react-native/normalize-colors as a dep of
					// react-native-web), let esbuild inline them.
					if (isReactNative && !externalSet.has(pkg) && (pkg.startsWith("@react-native/") || pkg.startsWith("@expo/"))) {
						try {
							require.resolve(args.path, { paths: [args.resolveDir] });
							return null; // resolvable locally - inline it
						} catch {
							return { path: args.path, external: true }; // not installed - externalize
						}
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

					// Subpath import: for version-sensitive packages and platform
					// scoped packages, always externalize to avoid inlining.
					if (alwaysExternalSubpaths.has(pkg) || pkg.startsWith("@react-native/") || pkg.startsWith("@expo/")) {
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
		const externalsJson = JSON.stringify(externalizedMap);
		const wrapped = `// Bundled: ${requireSpecifier}@${resolvedVersion}\n// @externals ${externalsJson}\n${bundled}\nif (typeof __module !== "undefined") { module.exports = __module; }\n`;

		fs.writeFileSync(finalCacheFile, wrapped);
		fs.writeFileSync(finalExternalsFile, externalsJson);
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

// ============================================================
// Batch dependency bundling: GET /bundle-deps/:hash, POST /bundle-deps
// ============================================================

const BUNDLE_DEPS_PREFIX = "bundle-deps-";

function hashDepsServer(deps: Record<string, string>): string {
	const sorted = Object.keys(deps).sort().map(k => `${k}@${deps[k]}`).join(",");
	let hash = 5381;
	for (let i = 0; i < sorted.length; i++) {
		hash = ((hash << 5) + hash + sorted.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(36);
}

// GET /bundle-deps/:hash - serve cached dep bundle (CDN cacheable)
app.get("/bundle-deps/:hash", (req: Request, res: Response) => {
	const hash = req.params.hash;
	const cacheFile = path.join(CACHE_DIR, `${BUNDLE_DEPS_PREFIX}${hash}.js`);

	if (fs.existsSync(cacheFile)) {
		console.log(`[bundle-deps cache hit] ${hash}`);
		res.header("Cache-Control", "public, max-age=31536000, immutable");
		res.type("application/javascript").sendFile(cacheFile);
		return;
	}

	res.status(404).send("// Not found\n");
});

// POST /bundle-deps - build a dep bundle
app.post("/bundle-deps", async (req: Request, res: Response) => {
	const { hash, dependencies } = req.body as { hash?: string; dependencies: Record<string, string> };

	if (!dependencies || typeof dependencies !== "object") {
		res.status(400).send("// Missing dependencies\n");
		return;
	}

	// Compute hash if not provided
	const depHash = hash || hashDepsServer(dependencies);
	const cacheFile = path.join(CACHE_DIR, `${BUNDLE_DEPS_PREFIX}${depHash}.js`);

	// Check cache
	if (fs.existsSync(cacheFile)) {
		console.log(`[bundle-deps cache hit] ${depHash}`);
		res.header("Cache-Control", "public, max-age=31536000, immutable");
		res.type("application/javascript").sendFile(cacheFile);
		return;
	}

	console.log(`[bundle-deps] Building for ${Object.keys(dependencies).length} deps (hash: ${depHash})`);
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-deps-"));

	try {
		// Install ALL deps in one go
		const installArgs = Object.entries(dependencies)
			.map(([name, ver]) => `${name}@${ver}`)
			.join(" ");
		execSync("npm init -y", { cwd: tmpDir, stdio: "ignore" });
		execSync(`npm install ${installArgs} --legacy-peer-deps`, {
			cwd: tmpDir,
			stdio: "ignore",
			timeout: 120000,
		});

		// Discover all packages to bundle: direct deps + their transitive deps
		const allPackages = new Map<string, { version: string; isRN: boolean }>();
		const nodeModules = path.join(tmpDir, "node_modules");

		function discoverPackages(pkgName: string, visited: Set<string>) {
			if (visited.has(pkgName)) return;
			visited.add(pkgName);

			const pkgJsonPath = path.join(nodeModules, pkgName, "package.json");
			if (!fs.existsSync(pkgJsonPath)) return;

			const meta = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
			const keywords = Array.isArray(meta.keywords) ? meta.keywords : [];
			const isRN = pkgName.startsWith("@expo/") ||
				pkgName.includes("react-native") ||
				keywords.some((k: string) => k === "react-native" || k === "expo");

			allPackages.set(pkgName, { version: meta.version, isRN });

			// Recurse into deps
			const deps = Object.keys(meta.dependencies || {});
			const peerDeps = Object.keys(meta.peerDependencies || {});
			for (const dep of [...deps, ...peerDeps]) {
				discoverPackages(dep, visited);
			}
		}

		const visited = new Set<string>();
		for (const name of Object.keys(dependencies)) {
			discoverPackages(name, visited);
		}

		// Only bundle the user's direct dependencies as separate entries.
		// Transitive deps get inlined into their consumers. This avoids
		// CJS/ESM interop issues with small utility packages.
		const directDeps = new Set(Object.keys(dependencies));
		for (const name of allPackages.keys()) {
			if (!directDeps.has(name)) {
				allPackages.delete(name);
			}
		}

		// Add known subpath entry points for direct deps that are commonly imported
		const knownSubpaths: Record<string, string[]> = {
			"react-dom": ["react-dom/client", "react-dom/server"],
			"react": ["react/jsx-runtime", "react/jsx-dev-runtime"],
		};
		for (const [pkg, subpaths] of Object.entries(knownSubpaths)) {
			if (directDeps.has(pkg)) {
				for (const sub of subpaths) {
					const subPkgPath = path.join(nodeModules, ...sub.split("/"));
					// Check if the subpath actually exists
					try {
						require.resolve(sub, { paths: [tmpDir] });
						allPackages.set(sub, { version: allPackages.get(pkg)?.version || "unknown", isRN: false });
					} catch {}
				}
			}
		}

		// Also scan all bundled code for subpath requires of direct deps and add them
		// This is done AFTER initial bundling in the subpath scanning section below

		console.log(`[bundle-deps] Bundling ${allPackages.size} entries (direct deps + subpaths)...`);

		// Only externalize other direct deps (they're separate entries in the batch)
		// Plus known platform modules
		const batchSet = new Set(allPackages.keys());
		for (const implicit of ["react-native", "react", "react-dom", "expo", "expo-modules-core"]) {
			batchSet.add(implicit);
		}

		// Build the manifest (name -> resolved version)
		const manifest: Record<string, string> = {};
		for (const [name, info] of allPackages) {
			manifest[name] = info.version;
		}

		// Bundle each package
		const chunks: string[] = [];
		const errors: string[] = [];

		for (const [pkgName, info] of allPackages) {
			try {
				const entryFile = path.join(tmpDir, `__entry_${pkgName.replace(/\//g, "__")}.js`);
				const outFile = path.join(tmpDir, `__out_${pkgName.replace(/\//g, "__")}.js`);
				fs.writeFileSync(entryFile, `module.exports = require("${pkgName}");\n`);

				// Create selective external plugin for this package
				const pkgExternalPlugin: esbuild.Plugin = {
					name: "batch-external",
					setup(build) {
						build.onResolve({ filter: /^[^./]/ }, (args) => {
							let dep: string;
							if (args.path.startsWith("@")) {
								const parts = args.path.split("/");
								dep = parts.length >= 2 ? parts.slice(0, 2).join("/") : args.path;
							} else {
								dep = args.path.split("/")[0];
							}

							// Don't externalize from self
							if (dep === pkgName) return null;

							// Only externalize other direct deps in the batch.
							// Transitive deps are inlined into their consumers.
							if (batchSet.has(dep)) {
								return { path: args.path, external: true };
							}

							// For RN packages, externalize @react-native/* and @expo/* if unresolvable
							if (info.isRN && (dep.startsWith("@react-native/") || dep.startsWith("@expo/"))) {
								try {
									require.resolve(args.path, { paths: [args.resolveDir] });
									return null;
								} catch {
									return { path: args.path, external: true };
								}
							}

							return null;
						});
					},
				};

				const filterNative: esbuild.Plugin = {
					name: "filter-native",
					setup(build) {
						build.onLoad({ filter: /\.(android|ios|windows)\.[jt]sx?$/ }, () => ({ contents: "", loader: "js" }));
					},
				};

				await esbuild.build({
					entryPoints: [entryFile],
					bundle: true,
					format: "iife",
					globalName: "__module",
					outfile: outFile,
					platform: "browser",
					target: "es2020",
					...(info.isRN && {
						resolveExtensions: [".web.tsx", ".web.ts", ".web.js", ".tsx", ".ts", ".js", ".json"],
						loader: { ".js": "jsx", ".ttf": "dataurl", ".otf": "dataurl", ".png": "dataurl" },
						banner: { js: "var process = { env: { NODE_ENV: 'production' } }; var React = require('react');" },
						define: { "__DEV__": "false" },
					}),
					plugins: [
						...(info.isRN ? [filterNative] : []),
						pkgExternalPlugin,
					],
					logLevel: "silent",
				});

				const bundled = fs.readFileSync(outFile, "utf-8");
				const wrapped = `${bundled}\nif (typeof __module !== "undefined") { module.exports = __module; }`;
				chunks.push(`// @dep-start ${pkgName}\n${wrapped}\n// @dep-end ${pkgName}`);

				// Also check for common subpath variants
				const subpathVariants: string[] = [];
				// Scan the bundled code for require("pkgName/...") patterns from OTHER packages
				// We'll handle subpaths in a second pass if needed
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				errors.push(`${pkgName}: ${msg}`);
				console.error(`[bundle-deps] Error bundling ${pkgName}:`, msg.slice(0, 200));
				// Add a stub so require() doesn't fail
				chunks.push(`// @dep-start ${pkgName}\n// Error bundling: ${msg.slice(0, 100)}\nmodule.exports = {};\n// @dep-end ${pkgName}`);
			}
		}

		// Now scan all chunks for subpath requires that need separate entries
		const allCode = chunks.join("\n");
		const subpathRequires = new Set<string>();
		const requireRe = /require\s*\(\s*["']([^"']+\/[^"']+)["']\s*\)/g;
		let m: RegExpExecArray | null;
		while ((m = requireRe.exec(allCode)) !== null) {
			const req = m[1];
			// Only handle subpath of packages in our batch (e.g. react-dom/client)
			let basePkg: string;
			if (req.startsWith("@")) {
				const parts = req.split("/");
				basePkg = parts.slice(0, 2).join("/");
			} else {
				basePkg = req.split("/")[0];
			}
			if (batchSet.has(basePkg) && req !== basePkg && !allPackages.has(req)) {
				subpathRequires.add(req);
			}
		}

		// Bundle subpath variants
		for (const subpath of subpathRequires) {
			try {
				const safeName = subpath.replace(/\//g, "__");
				const entryFile = path.join(tmpDir, `__entry_${safeName}.js`);
				const outFile = path.join(tmpDir, `__out_${safeName}.js`);
				fs.writeFileSync(entryFile, `module.exports = require("${subpath}");\n`);

				let basePkg: string;
				if (subpath.startsWith("@")) {
					const parts = subpath.split("/");
					basePkg = parts.slice(0, 2).join("/");
				} else {
					basePkg = subpath.split("/")[0];
				}
				const info = allPackages.get(basePkg);

				const subExternalPlugin: esbuild.Plugin = {
					name: "batch-sub-external",
					setup(build) {
						build.onResolve({ filter: /^[^./]/ }, (args) => {
							let dep: string;
							if (args.path.startsWith("@")) {
								const parts = args.path.split("/");
								dep = parts.length >= 2 ? parts.slice(0, 2).join("/") : args.path;
							} else {
								dep = args.path.split("/")[0];
							}
							if (batchSet.has(dep)) {
								return { path: args.path, external: true };
							}
							return null;
						});
					},
				};

				const filterNative: esbuild.Plugin = {
					name: "filter-native",
					setup(build) {
						build.onLoad({ filter: /\.(android|ios|windows)\.[jt]sx?$/ }, () => ({ contents: "", loader: "js" }));
					},
				};

				await esbuild.build({
					entryPoints: [entryFile],
					bundle: true,
					format: "iife",
					globalName: "__module",
					outfile: outFile,
					platform: "browser",
					target: "es2020",
					...(info?.isRN && {
						resolveExtensions: [".web.tsx", ".web.ts", ".web.js", ".tsx", ".ts", ".js", ".json"],
						loader: { ".js": "jsx", ".ttf": "dataurl", ".otf": "dataurl", ".png": "dataurl" },
						banner: { js: "var process = { env: { NODE_ENV: 'production' } }; var React = require('react');" },
						define: { "__DEV__": "false" },
					}),
					plugins: [
						...(info?.isRN ? [filterNative] : []),
						subExternalPlugin,
					],
					logLevel: "silent",
				});

				const bundled = fs.readFileSync(outFile, "utf-8");
				const wrapped = `${bundled}\nif (typeof __module !== "undefined") { module.exports = __module; }`;
				chunks.push(`// @dep-start ${subpath}\n${wrapped}\n// @dep-end ${subpath}`);
			} catch {
				chunks.push(`// @dep-start ${subpath}\nmodule.exports = {};\n// @dep-end ${subpath}`);
			}
		}

		// Assemble final bundle
		const header = `// @dep-bundle ${depHash}\n// @dep-manifest ${JSON.stringify(manifest)}\n// @dep-count ${chunks.length}\n`;
		const bundle = header + chunks.join("\n") + "\n";

		// Cache
		fs.writeFileSync(cacheFile, bundle);
		console.log(`[bundle-deps] Cached ${chunks.length} packages (hash: ${depHash}, size: ${(bundle.length / 1024).toFixed(0)}KB)`);

		res.header("Cache-Control", "public, max-age=31536000, immutable");
		res.type("application/javascript").send(bundle);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[bundle-deps error]`, message);
		if (!res.headersSent) {
			res.status(500).json({ error: message });
		}
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ============================================================
// Individual package endpoint (backward compatible)
// ============================================================

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
