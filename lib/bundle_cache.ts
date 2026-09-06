import { join } from "node:path";

import { env_switch_on } from "$config/env_vars";
import { get_route_module_mount_version } from "$lib/route_module";
import { discover_static_dirs } from "$lib/static_discovery";

export type BundleEntry = {
	script_srcs: string[];
	output_url: string;
	hash: string;
};

const CACHE_DIR = "static/bundles";
const bundle_map = new Map<string, BundleEntry>();

// Off by default: these are hand-authored global-scope scripts (functions/
// classes attached to window), not ES modules. Bun.build's dead-code
// elimination strips top-level declarations with no in-blob reference, so
// turning this on can silently drop globals only used by inline <script>
// blocks elsewhere on the page. Only enable if all bundled sources are
// confirmed safe to minify (e.g. no cross-file global reliance).
const use_bundler = env_switch_on("BUNDLE_JS");

// Mirrors server.ts's static_dirs: project static/ first, then every normal
// and mounted route-local static/ dir, since scripts are served flat at root
// from whichever directory happens to contain them.
let static_search_dirs: string[] | null = null;
let static_search_version = -1;
function get_static_search_dirs(): string[] {
	const route_module_mount_version = get_route_module_mount_version();
	if (static_search_dirs && static_search_version === route_module_mount_version) return static_search_dirs;
	static_search_dirs = discover_static_dirs(process.cwd());
	static_search_version = route_module_mount_version;
	return static_search_dirs;
}

function normalize_script_path(src: string): string {
	return src.split("?")[0] ?? src;
}

async function resolve_source(src: string, search_dirs: string[]): Promise<string | null> {
	const clean_src = src.startsWith("/") ? src.slice(1) : src;
	for (const base of search_dirs) {
		const candidate = join(base, clean_src);
		if (await Bun.file(candidate).exists()) return candidate;
	}
	return null;
}

async function minify_via_bundler(code: string): Promise<string> {
	const tmp_path = join(process.cwd(), CACHE_DIR, `.tmp-${crypto.randomUUID()}.js`);
	await Bun.write(tmp_path, code);

	try {
		const result = await Bun.build({
			entrypoints: [tmp_path],
			target: "browser",
			format: "iife",
			minify: true,
		});

		if (!result.success || result.outputs.length === 0) {
			const error_msgs = result.logs.map(l => `${l.level}: ${l.message}`).join("; ");
			console.warn(`[bundle] Minify failed, using unminified code: ${error_msgs}`);
			return code;
		}

		const output = result.outputs[0];
		if (!output) {
			console.warn("[bundle] Minify produced no output, using unminified code");
			return code;
		}

		return await output.text();
	} finally {
		await Bun.file(tmp_path).delete().catch(() => {});
	}
}

// Cache key is a hash of the resolved sources' actual content, not just
// their paths - so an edited script produces a new bundle instead of
// silently reusing a stale one, with no need to clear the cache dir on
// restart or track file mtimes.
export async function get_or_bundle(script_srcs: string[]): Promise<string> {
	if (script_srcs.length === 0) {
		return "";
	}

	const normalized = script_srcs.map(normalize_script_path);
	const search_dirs = get_static_search_dirs();

	const resolved = await Promise.all(normalized.map(src => resolve_source(src, search_dirs)));

	const chunks: string[] = [];
	for (let i = 0; i < normalized.length; i++) {
		const entry = resolved[i];
		if (!entry) {
			console.warn(`[bundle] Source not found in any static dir: ${normalized[i]}, skipping`);
			continue;
		}
		chunks.push(await Bun.file(entry).text());
	}

	if (chunks.length === 0) {
		console.warn(`[bundle] No output for ${normalized.join(", ")}, using first source fallback`);
		return `/${normalized[0]}`;
	}

	const concatenated = chunks.join("\n;\n");
	const code = use_bundler ? await minify_via_bundler(concatenated) : concatenated;
	const hash = new Bun.CryptoHasher("sha256").update(code).digest("hex").slice(0, 16);
	const cache_key = hash;

	if (bundle_map.has(cache_key)) {
		return `/${bundle_map.get(cache_key)!.output_url}`;
	}

	const output_file = join(CACHE_DIR, `${hash}.js`);
	const output_path = join(process.cwd(), output_file);
	const output_url = `bundles/${hash}.js`;

	if (await Bun.file(output_path).exists()) {
		bundle_map.set(cache_key, { script_srcs: normalized, output_url, hash });
		return `/${output_url}`;
	}

	const cache_dir = join(process.cwd(), CACHE_DIR);
	const cache_dir_file = Bun.file(cache_dir);
	if (!(await cache_dir_file.exists())) {
		await Bun.write(join(cache_dir, ".gitkeep"), "");
	}

	await Bun.write(output_path, code);

	bundle_map.set(cache_key, { script_srcs: normalized, output_url, hash });

	console.log(`[bundle] Created cache: ${hash} (${normalized.length} sources)`);

	return `/${output_url}`;
}

export function invalidate_cache(script_src?: string): void {
	if (!script_src) {
		bundle_map.clear();
		return;
	}

	const normalized = normalize_script_path(script_src);
	const to_remove: string[] = [];
	for (const [key, entry] of bundle_map.entries()) {
		if (entry.script_srcs.includes(normalized)) {
			to_remove.push(key);
		}
	}

	to_remove.forEach(key => bundle_map.delete(key));
}
