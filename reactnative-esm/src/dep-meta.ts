/**
 * Package metadata for a bundle-deps build: what a hoisted
 * `node_modules/<name>/package.json` says, from either source.
 *
 * Every chunk cache key is computed from this metadata alone (package@version
 * plus the dependency closure's declared names), so when every chunk of a dep
 * set is already cached the install itself buys nothing. `bun install
 * --lockfile-only` resolves the same tree in ~100ms without extracting a
 * single package, against seconds for a full install (and an occasional hang
 * into the 90s timeout). Measured on production dep sets: bun.lock's hoisted
 * entries match the installed package.json files exactly (versions, and the
 * union of dependencies + peerDependencies), once packages for other
 * platforms are left out the way the installer leaves them out.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";

export interface PackageMeta {
	version: string;
	dependencies: Record<string, string>;
	peerDependencies: Record<string, string>;
	keywords: string[];
}

/** Metadata of the hoisted copy of `name`, or null when it isn't installed. */
export type MetaSource = (name: string) => PackageMeta | null;

/** Something a cache-only assembly would have to build: install and build instead. */
export class NeedsBuild extends Error {}

/** Reads installed package.json files under `<root>/node_modules`. */
export function nodeModulesMeta(root: string): MetaSource {
	const memo = new Map<string, PackageMeta | null>();
	return (name) => {
		if (memo.has(name)) return memo.get(name)!;
		let meta: PackageMeta | null = null;
		try {
			const pj = JSON.parse(fs.readFileSync(path.join(root, "node_modules", name, "package.json"), "utf8"));
			meta = {
				version: pj.version,
				dependencies: pj.dependencies ?? {},
				peerDependencies: pj.peerDependencies ?? {},
				keywords: Array.isArray(pj.keywords) ? pj.keywords : [],
			};
		} catch {
			/* not installed (or no package.json at that path) */
		}
		memo.set(name, meta);
		return meta;
	};
}

/** npm's os/cpu matching: a list of allowed values, or "!value" exclusions. */
function platformMatches(field: unknown, current: string): boolean {
	if (field === undefined) return true;
	const values = ([] as unknown[]).concat(field).filter((v): v is string => typeof v === "string");
	if (values.includes(`!${current}`)) return false;
	const allowed = values.filter((v) => !v.startsWith("!"));
	return allowed.length === 0 || allowed.includes(current);
}

/**
 * The hoisted packages of a text bun.lock. Keys without a nested path segment
 * ("react", "@expo/config") are what lands at node_modules/<name>. Keywords
 * aren't recorded; they only steer how a package is built, never a cache key.
 */
export function bunLockMeta(lockText: string): MetaSource {
	// bun.lock is JSON with trailing commas.
	const lock = JSON.parse(lockText.replace(/,(\s*[}\]])/g, "$1")) as {
		packages?: Record<string, [string, string, Record<string, unknown>?, string?]>;
	};
	const packages = lock.packages ?? {};
	return (name) => {
		// Only hoisted entries: "parent/child" keys are nested copies, and a
		// subpath ("react-native/Libraries/x") has no package.json of its own.
		if (name.split("/").length !== (name.startsWith("@") ? 2 : 1)) return null;
		const entry = packages[name];
		if (!entry) return null;
		const info = (entry[2] ?? {}) as {
			dependencies?: Record<string, string>;
			peerDependencies?: Record<string, string>;
			os?: unknown;
			cpu?: unknown;
		};
		if (!platformMatches(info.os, process.platform) || !platformMatches(info.cpu, process.arch)) return null;
		const spec = entry[0];
		return {
			version: spec.slice(spec.lastIndexOf("@") + 1),
			dependencies: info.dependencies ?? {},
			peerDependencies: info.peerDependencies ?? {},
			keywords: [],
		};
	};
}

/**
 * Resolve `specs` with `bun install --lockfile-only` in `dir` (which must hold
 * a package.json) and return the resulting tree, or null when resolution fails
 * or stalls -- the caller then installs as it always has.
 *
 * Resolution takes ~0.1s with bun's manifest cache warm and ~1.5s cold, but an
 * attempt occasionally stalls in "Resolving dependencies" (3 of ~30 on the
 * origin, never reproduced outside the server). A stalled attempt is killed
 * after `timeoutMs` and retried once; the next attempt has always been quick.
 */
export async function resolveWithBunLockfile(
	dir: string,
	specs: string[],
	timeoutMs: number,
	attempts = 2
): Promise<MetaSource | null> {
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const result = await runLockfileOnly(dir, specs, timeoutMs);
		if (result === "ok") {
			try {
				return bunLockMeta(fs.readFileSync(path.join(dir, "bun.lock"), "utf8"));
			} catch {
				return null;
			}
		}
		// A real failure (an unsatisfiable range) fails the same way again.
		if (result === "failed") return null;
		console.warn(`[bundle-deps] lockfile-only resolve stalled past ${timeoutMs}ms (attempt ${attempt}/${attempts})`);
	}
	return null;
}

function runLockfileOnly(dir: string, specs: string[], timeoutMs: number): Promise<"ok" | "failed" | "stalled"> {
	return new Promise((resolve) => {
		const child = spawn(
			"bun",
			["install", "--lockfile-only", "--save-text-lockfile", "--no-progress", "--ignore-scripts", ...specs],
			// stdin closed: nothing to answer, and an open pipe is one more way to wait forever.
			{ cwd: dir, stdio: ["ignore", "ignore", "pipe"] }
		);
		let stderr = "";
		child.stderr?.on("data", (d) => {
			if (stderr.length < 4000) stderr += d;
		});
		let stalled = false;
		const timer = setTimeout(() => {
			stalled = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.on("error", () => {
			clearTimeout(timer);
			resolve("failed");
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (stalled) return resolve("stalled");
			if (code !== 0) console.warn(`[bundle-deps] lockfile-only resolve failed (exit ${code}): ${stderr.trim().slice(0, 300)}`);
			resolve(code === 0 ? "ok" : "failed");
		});
	});
}

/** worklets.ts's workletsRuntimeVersion, from metadata instead of node_modules. */
export function workletsRuntimeVersionFrom(meta: MetaSource): string | null {
	const worklets = meta("react-native-worklets");
	if (worklets) return String(worklets.version);
	const reanimated = meta("react-native-reanimated");
	return reanimated ? `reanimated-${reanimated.version}` : null;
}

/**
 * Identity of this server's bundling code: every source file's bytes. Recorded
 * build failures are only trusted by the code that recorded them, so a deploy
 * that fixes how a package bundles is never masked by an old failure.
 */
export const SERVER_CODE_ID = (() => {
	const hash = crypto.createHash("sha256");
	for (const file of fs.readdirSync(__dirname).filter((f) => f.endsWith(".ts")).sort()) {
		hash.update(file).update(fs.readFileSync(path.join(__dirname, file)));
	}
	return hash.digest("hex").slice(0, 12);
})();

/**
 * Chunks that failed to bundle because something could not be resolved: the
 * same package, version and externals fail the same way every time, so a dep
 * set containing one (sql.js's `node:fs`, react-dom/server on web) can still
 * be assembled from cache instead of reinstalling to watch it fail again.
 * Other failures (timeouts, crashes) are never recorded.
 */
export function failureCache(dir: string, enabled: boolean) {
	const file = (key: string) => path.join(dir, `${key}.failed-${SERVER_CODE_ID}.js`);
	return {
		read(key: string): string | null {
			if (!enabled) return null;
			try {
				return fs.readFileSync(file(key), "utf8");
			} catch {
				return null;
			}
		},
		write(key: string, body: string, reason: string): void {
			if (!enabled || !/Could not resolve/.test(reason)) return;
			try {
				fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(file(key), body);
			} catch {
				/* cache write failure is non-fatal */
			}
		},
	};
}
