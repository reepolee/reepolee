/**
 * File-Based Template Engine - Inspired by Eta.js & Svelte
 * Pure vanilla JavaScript implementation with layouts and partials
 * Optimized for Bun runtime
 *
 * Tags and directives:
 * - {= expr }     -> escaped output
 * - {~ expr }     -> unescaped output
 * - {{ ... }}     -> raw JS (double braces)
 * - {#layout('path', props?) }
 * - {#include('path', props?) }    // treated as HTML block; not escaped as a whole
 * - {#each list as item[, index][, key] } ... {:else} ... {/each}
 * - {#if condition }              ... {:else} ... {/if}
 * - {#with expr }                 ... {/with}
 * - .identifier             -> spread shorthand: {~ key_values(identifier)} (unescaped)
 * - <tag-name>...</tag-name>   -> custom HTML element shorthand (ReeTag)
 * (any tag whose name has at least one hyphen;
 * attributes on the tag are passed under props.attributes;
 * pre-processor emits a NUL marker that compile_to_code
 * resolves into a __rtInclude call)
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { file, write } from "bun";

import { compile_to_code as _compile_to_code } from "./template/compiler";
import { preprocess_template } from "./template/custom_elements";
import { include_resolved_handler, type IncludeHandlerDeps } from "./template/include_handler";
import { resolve_include, resolve_layout } from "./template/include_resolver";
import { make_locale_suffixes, split_locale } from "./template/precompile";
import type { CompiledFn } from "./template/types";

// A mount point for a route module: templates under "<module_code>/..." resolve
// against <module_root> instead of views_dir. Declared here rather than
// imported so the engine carries no host-app dependency.
export type RouteModuleMount = { module_code: string; module_root: string; };

type Config = {
	views?: string;
	cache?: boolean;
	auto_escape?: boolean;
	ext?: string;
	route_module_mounts?: RouteModuleMount[];
	// Additional views root searched when a name has no file under views_dir
	// and matches no mounted module. Holds templates shared by every app
	// (reepolee's platform/): they keep plain, views-relative names, so
	// render("notfound") reaches platform/notfound.ree without the caller
	// knowing which tree the file lives in.
	shared_views?: string;
	// Host localization facts. The engine only needs the configured locale list
	// (to recognize a "<name>.<locale>.ree" variant suffix) and which one is the
	// fallback - not the host's aliasing or display-name machinery.
	locales?: readonly string[];
	default_locale?: string;
	// Optional source transform applied to every .ree file as it is read, before
	// compiling. The dev inspector uses this to stamp data-ree attributes; the
	// engine itself attaches no meaning to it. Receives the raw text and the
	// project-root-relative path of the file it came from.
	transform_source?: (content: string, rel_path: string) => string;
	// Base the paths handed to transform_source are made relative to. Defaults
	// to the parent of views_dir, which is right when views sit one level below
	// the repo root (reepolee's routes/). Hosts that nest them deeper
	// (ree-web's src/public/) must pass the real root, or stamped paths lose the
	// prefix and round-trips like the inspector's open/save cannot find the file.
	project_root?: string;
	// Helper names bound as bare identifiers inside compiled templates. Which
	// helpers are system-level is a host decision - the set differs per project
	// and grows as helpers prove themselves - so the engine takes the list
	// rather than owning it. Anything omitted is still reachable as
	// helpers.<name>.
	helper_names?: readonly string[];
};

class TemplateEngine {
	views_dir: string;
	// Secondary views root (see Config.shared_views). Empty when unconfigured.
	shared_views_dir: string;
	cache: boolean;
	auto_escape: boolean;
	ext: string;
	compiled_cache: Record<string, CompiledFn>;
	route_module_mounts: Map<string, string>;
	// Populated by precompile_templates() (lib/template/precompile.ts):
	// name -> { locale -> resolved_name, "*" -> resolved_name } for zero-I/O
	// cache-key resolution in render().
	name_variants: Map<string, Map<string, string>>;
	// base file path (no ext) -> { locale -> full file path } for raw includes.
	raw_variants: Map<string, Map<string, string>>;
	// tag name -> include path for ReeTag resolution (built by
	// precompile_templates, self-healed lazily in dev): "$components/<tag>"
	// for components/, a views-relative name for routes-tree files, and
	// "<code>/<name>" for mounted route modules.
	component_paths: Map<string, string>;
	// Tags proven to have no component file anywhere (negative cache - native
	// custom elements like <toasts-area> must not glob per compile).
	component_misses: Set<string>;
	// Set once precompile_templates() has built the complete index. In prod
	// the index is then authoritative: a tag absent from it has no component
	// file, so component_include skips the self-heal glob.
	component_index_built: boolean;
	// Repo root (one level above views_dir) - used to build the
	// project-root-relative paths the inspector's data-ree stamps and
	// /__ree_open expect. Only read when stamping (dev, cache off).
	project_root: string;
	// Configured locales, lowercased, for matching the variant suffix in
	// "index.sl-si.ree". Locale is the single localization axis - a full BCP 47
	// language-region code - so only these exact values count as a suffix.
	locale_suffixes: Set<string>;
	default_locale: string;
	transform_source: ((content: string, rel_path: string) => string) | null;
	helper_names: readonly string[];

	constructor(config: Config = {}) {
		this.views_dir = config.views || "./views";
		this.shared_views_dir = config.shared_views ?? "";
		this.project_root = config.project_root ? resolve(config.project_root) : resolve(this.views_dir, "..");
		// cache only in production unless explicitly set
		this.cache = typeof config.cache === "boolean" ? config.cache : Bun.env.NODE_ENV === "production";
		this.auto_escape = config.auto_escape !== false;
		this.ext = config.ext || ".ree";
		this.locale_suffixes = make_locale_suffixes(config.locales ?? []);
		this.default_locale = (config.default_locale ?? "").toLowerCase();
		this.transform_source = config.transform_source ?? null;
		this.helper_names = config.helper_names ?? [];
		this.compiled_cache = {};
		this.route_module_mounts = new Map();
		this.name_variants = new Map();
		this.raw_variants = new Map();
		this.component_paths = new Map();
		this.component_misses = new Set();
		this.component_index_built = false;
		const route_module_mounts = config.route_module_mounts ?? [];
		for (const mount of route_module_mounts) {
			this.route_module_mounts.set(mount.module_code, mount.module_root);
		}
	}

	private resolve_template_file(name: string): string {
		const normalized_name = name.replaceAll("\\", "/");
		const views_path = join(this.views_dir, normalized_name + this.ext);
		// The apps/ tree is the primary root. Check it before route-module
		// mounts because an app directory can share a name with a module
		// (apps/reeman/ and apps/reeman/reeman/ are both valid here).
		if (existsSync(views_path)) return views_path;
		const slash_index = normalized_name.indexOf("/");
		const module_code = slash_index === -1 ? normalized_name : normalized_name.slice(0, slash_index);
		const module_root = this.route_module_mounts.get(module_code);
		if (!module_root) {
			if (!this.shared_views_dir) return views_path;
			const shared_path = join(this.shared_views_dir, normalized_name + this.ext);
			return existsSync(shared_path) ? shared_path : views_path;
		}

		const relative_name = slash_index === -1 ? "" : normalized_name.slice(slash_index + 1);
		const file_path = resolve(join(module_root, relative_name + this.ext));
		const relative_path = relative(module_root, file_path);
		const parent_prefix = `..${sep}`;
		const is_outside = relative_path === ".." || relative_path.startsWith(parent_prefix) || isAbsolute(relative_path);
		if (is_outside) {
			throw new Error(`Template path escapes mounted route module "${module_code}": ${name}`);
		}

		return file_path;
	}

	// Load template text from file
	async load_template(name: string): Promise<string> {
		const file_path = this.resolve_template_file(name);
		if (!existsSync(file_path)) { throw new Error(`Template file not found: ${file_path}`); }
		const f = file(file_path);
		return this.stamp_source(await f.text(), file_path);
	}

	/**
	 * Load template with locale-specific fallback chain (lowercase filenames):
	 * {name}.{locale}.ree -> {name}.{default_locale}.ree -> {name}.ree
	 * e.g. home.sl-si.ree -> home.en-us.ree -> home.ree
	 * Returns the content and the resolved name (for cache key usage).
	 *
	 * Only a configured locale counts as a variant suffix - the same rule
	 * split_locale() applies when indexing files. A bare language subtag
	 * ("sl") is not a locale here, so it resolves to the default variant
	 * rather than matching a "home.sl.ree" that indexing would treat as a
	 * component named "home.sl".
	 */
	async load_localized(name: string, locale: string): Promise<{ content: string; resolved_name: string; }> {
		const requested = locale.toLowerCase();
		const localized_candidate = this.locale_suffixes.has(requested) ? [`${name}.${requested}`] : [];
		const candidates = [...localized_candidate, `${name}.${this.default_locale}`, name];
		for (const candidate of candidates) {
			const file_path = this.resolve_template_file(candidate);
			if (existsSync(file_path)) {
				const f = file(file_path);
				return { content: this.stamp_source(await f.text(), file_path), resolved_name: candidate };
			}
		}
		throw new Error(`Template not found: ${name} (tried: ${candidates.map((c) => c + this.ext).join(", ")})`);
	}

	/**
	 * Apply the host's source transform (if any) to a freshly read .ree file.
	 * No-op when cache is on (production) or no transform was configured - the
	 * dev inspector supplies one to stamp data-ree attributes.
	 */
	private stamp_source(content: string, file_path: string): string {
		if (this.cache || !this.transform_source) return content;
		const rel = relative(this.project_root, file_path).replaceAll("\\", "/");
		return this.transform_source(content, rel);
	}

	/**
	 * Internal: include with resolution relative to current template.
	 * Delegates to the extracted handler in include_handler.ts.
	 */
	private async include_resolved(current_name: string, include_name: string, props: Record<string, any>): Promise<string> {
		const deps: IncludeHandlerDeps = {
			resolve_include: (c, i) => resolve_include(c, i, this.views_dir, this.ext, this.project_root),
			render: (n, p) => this.render(n, p),
			compile: (t) => this.compile(t),
			include: (n, p) => this.include(n, p),
			auto_escape: this.auto_escape,
			escape: (s) => this.escape(s),
			ext: this.ext,
			default_locale: this.default_locale,
			// Precompiled fast paths (no-op when precompile_templates() never ran).
			compiled_for_path: (p) => this.compiled_cache[p],
			raw_variant: (p, locale) => this.raw_variants.get(p.slice(0, -this.ext.length))?.get(locale) ?? null,
		};
		return include_resolved_handler(deps, current_name, include_name, props);
	}

	/**
	 * Compile template string to async function
	 * Supports tags/directives:
	 * - {= expr }    (escaped)
	 * - {~ expr }    (unescaped)
	 * - {{ ... }}    (raw JS - double braces)
	 * - {#layout('path', props?) }
	 * - {#include('path', props?) }  (treated as HTML block; not escaped as a whole)
	 * - {#each list as item[, index][, key] } ... {:else} ... {/each}		 *  - {#if condition } ... {:else} ... {/if}
	 * - {#with expr } ... {/with}
	 * - <tag-name>...</tag-name>     (ReeTag; includes /components/tag-name.ree with props)
	 */
	compile(template: string) {
		const { fn } = this.compile_to_code(template);
		return fn;
	}

	/**
	 * Compile and return both the generated JavaScript source code and the
	 * compiled async render function. Useful for debugging and the MCP
	 * server's compile_template tool.
	 */
	compile_to_code(template: string): { code: string; fn: CompiledFn; } {
		// Pre-process: custom elements, HTML comments, spread shorthand.
		// The index-backed component_include resolves tags without per-compile
		// existsSync; it falls back to the filesystem (and self-heals) in dev.
		const { template: processed_template, slot_fns } = preprocess_template(
			template,
			this.views_dir,
			this.ext,
			(content) => this.compile(content),
			(tag) => this.component_include(tag),
			this.project_root,
		);

		// Compile: template directives -> async render function
		return _compile_to_code(processed_template, slot_fns, this.helper_names);
	}

	// HTML escape (single-pass)
	escape(str: any): string {
		if (str == null) return "";
		const s = String(str);
		return s.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	}

	async include(name: string, props: Record<string, any>): Promise<string> {
		// bare include() keeps views-root semantics
		return await this.render(name, props);
	}

	/**
	 * Internal: resolve a {#layout()} name co-location-first, then views root.
	 * Layout names are never extension-sniffed, so dotted convention names
	 * ("docs.layout", "wallpaper.layout") stay intact.
	 */
	private async layout_resolved(current_name: string, layout_name: string, props: Record<string, any>): Promise<string> {
		const resolved_name = resolve_layout(current_name, layout_name, this.views_dir, this.ext, existsSync);
		return await this.render(resolved_name, props);
	}

	async render(name: string, props: Record<string, any> = {}): Promise<string> {
		const current_name = name; // used by relative includes within this template
		const locale = props?.locale;

		// Prod fast path: precompiled/cached templates render with zero disk
		// I/O. name_variants maps name -> locale-resolved cache keys, built by
		// precompile_templates(). When absent (no precompile, or after
		// clear_cache()), fall through to the disk-based path below, which
		// lazily compiles and caches as before.
		if (this.cache) {
			const resolved = this.resolve_cached_name(name, locale);
			const compiled_fn = resolved !== undefined ? this.compiled_cache[resolved] : undefined;
			if (compiled_fn) { return await this.run_compiled(compiled_fn, props, current_name); }
		}

		// Resolve localized variant when a locale is available:
		// {name}.{locale}.ree -> {name}.{default_locale}.ree -> {name}.ree
		let resolved_name = name;
		let template: string;
		if (locale) {
			const result = await this.load_localized(name, locale);
			template = result.content;
			resolved_name = result.resolved_name;
		} else {
			template = await this.load_template(name);
		}

		let compiled_fn = this.cache ? this.compiled_cache[resolved_name] : undefined;
		if (!compiled_fn) {
			compiled_fn = this.compile(template);
			if (this.cache) { this.compiled_cache[resolved_name] = compiled_fn; }
		}

		return await this.run_compiled(compiled_fn, props, current_name);
	}

	/**
	 * Resolve the compiled-cache key for a template name + locale using the
	 * precompile index - the in-memory equivalent of load_localized()'s
	 * {name.locale -> name.default_locale -> name} fallback chain.
	 */
	private resolve_cached_name(name: string, locale: string | undefined): string | undefined {
		const variants = this.name_variants.get(name);
		if (!variants) return undefined;
		if (locale) {
			const exact = variants.get(locale.toLowerCase());
			if (exact) return exact;
			const def = variants.get(this.default_locale);
			if (def) return def;
		}
		return variants.get("*");
	}

	/**
	 * Resolve the include path for a ReeTag tag name, or null when no
	 * component file exists (the tag is passed through as native HTML).
	 *
	 * Resolution order (indexed at boot by precompile_templates):
	 * 1. components/<tag>.ree             -> "$components/<tag>"
	 * 2. any routes-tree file named <tag> -> views-relative name
	 * 3. any mounted module-root file     -> "<code>/<name>"
	 *
	 * Self-heals in dev (cache off): a tag absent from the boot index
	 * triggers one filesystem search - components/ first, then a glob over
	 * the views tree and module roots - and both hits and misses are cached,
	 * so native custom elements (<toasts-area>, <field-wrapper>) don't pay a
	 * glob per compile.
	 */
	component_include(tag_name: string): string | null {
		const known = this.component_paths.get(tag_name);
		if (known !== undefined) return known;
		if (this.component_misses.has(tag_name)) return null;

		const components_file = join(this.project_root, "components", tag_name + this.ext);
		if (existsSync(components_file)) {
			const include_path = `$components/${tag_name}`;
			this.component_paths.set(tag_name, include_path);
			return include_path;
		}

		if (this.cache && this.component_index_built) {
			// Prod with a boot-built index: precompile registers every tag with
			// a file anywhere before compiling anything, so a miss here is a
			// genuine absence - negative-cache without globbing.
			this.component_misses.add(tag_name);
			return null;
		}

		const tree_hit = this.find_component_in_tree(tag_name);
		if (tree_hit) {
			this.component_paths.set(tag_name, tree_hit);
			return tree_hit;
		}

		this.component_misses.add(tag_name);
		return null;
	}

	/**
	 * Search the views tree and mounted module roots for a file named
	 * <tag>.ree (dev self-heal for files created after boot). Returns the
	 * include path of the single match, or null when there is none.
	 *
	 * Throws when two or more distinct components share the tag name: an
	 * arbitrary glob-order winner would make it impossible to tell which file
	 * actually renders. Locale variants of one component (foo.ree, foo.sl.ree)
	 * collapse to the same include path and are not a conflict.
	 *
	 * Roots are searched in order and the first root with any match wins - a
	 * views-tree component intentionally shadows a same-named module file, so
	 * ambiguity is only reported within a single root.
	 */
	private find_component_in_tree(tag_name: string): string | null {
		const pattern = `**/${tag_name}${this.ext}`;
		const roots: { code: string | null; root: string; }[] = [
			{ code: null, root: this.views_dir },
			...(this.shared_views_dir ? [{ code: null, root: this.shared_views_dir }] : []),
			...Array.from(this.route_module_mounts.entries(), ([code, root]) => ({ code, root })),
		];
		for (const { code, root } of roots) {
			let files: string[];
			try {
				files = Array.from(new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true, absolute: true }));
			} catch {
				continue; // root does not exist
			}

			// include path -> the file that produced it, for the error message.
			const matches = new Map<string, string>();
			for (const raw_path of files) {
				const file_path = resolve(raw_path);
				const rel = relative(root, file_path).split(sep).join("/");
				const rel_no_ext = rel.slice(0, -this.ext.length);
				const { base_rel } = split_locale(rel_no_ext, this.locale_suffixes);
				const include_path = code ? `${code}/${base_rel}` : base_rel;
				if (!matches.has(include_path)) { matches.set(include_path, rel); }
			}

			if (matches.size === 0) { continue; }
			if (matches.size > 1) {
				const found = Array.from(matches.values()).sort().join(", ");
				throw new Error(`Ambiguous component <${tag_name}>: ${matches.size} components named "${tag_name}${this.ext}" found in ${root} (${found}). Rename all but one, or move the intended component to components/${tag_name}${this.ext} to make it win.`);
			}

			const only_include_path = Array.from(matches.keys())[0]!;
			return only_include_path;
		}
		return null;
	}

	/**
	 * Run a compiled template function with the standard bound includes.
	 */
	private async run_compiled(compiled_fn: CompiledFn, props: Record<string, any>, current_name: string): Promise<string> {
		const bound_include = this.include.bind(this);
		const rt_include = this.include_resolved.bind(this, current_name);
		const rt_layout = this.layout_resolved.bind(this, current_name);
		const escape = this.auto_escape ? this.escape.bind(this) : (s: any) => String(s ?? "");
		return await (compiled_fn as any)(props, escape, bound_include, rt_include, current_name, rt_layout);
	}

	async render_string(template_string: string, props: Record<string, any> = {}): Promise<string> {
		const compiled_fn = this.compile(template_string);
		const current_name = ""; // treat render_string as views-root
		const bound_include = this.include.bind(this);
		const rt_include = this.include_resolved.bind(this, current_name);
		const rt_layout = this.layout_resolved.bind(this, current_name);
		const escape = this.auto_escape ? this.escape.bind(this) : (s: any) => String(s ?? "");
		return await (compiled_fn as any)(props, escape, bound_include, rt_include, current_name, rt_layout);
	}

	clear_cache(): void {
		this.compiled_cache = {};
		// Forget negative ReeTag lookups and the index-built flag too, so a
		// component created/moved after the clear (dev) resolves on the next
		// compile. precompile_templates() is idempotent and rebuilds the index.
		this.component_misses = new Set();
		this.component_index_built = false;
	}

	async write_output(file_path: string, content: string): Promise<void> {
		const dir = dirname(file_path);
		if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); }
		await write(file_path, content);
	}
}

export default TemplateEngine;
