/**
 * Eager template precompilation.
 *
 * Walks every template root (views dir, the shared views dir, mounted route
 * module roots, and the project's components/ dir) for *.ree files once at startup and:
 * - builds the component index (tag name -> include path) so the ReeTag
 *   preprocessor resolves components from components/, the routes tree, or
 *   mounted module roots without per-compile existsSync checks
 * - builds name/locale lookup indexes so render()/include() resolve cache keys
 *   with zero disk I/O
 * - in prod (engine.cache), reads and compiles every file once into
 *   compiled_cache under both the resolved template name and the absolute
 *   file path - alias includes ($components/, $lib/) hit the path keys
 *
 * Two passes on purpose: the complete index is built BEFORE any template is
 * compiled, so compile-time ReeTag resolution never depends on root
 * processing order (e.g. a module template compiled before a sibling
 * component's file was registered), and prod can treat the index as
 * authoritative (no self-heal globs).
 *
 * Dev mode (cache off) only builds the registry/indexes; templates keep
 * recompiling from disk on every render for hot reload.
 *
 * A template that fails to compile aborts boot with a loud error listing the
 * offending file(s) - the project's fail-loud convention (no silent
 * fallback). Dev never compiles (hot reload recompiles per render), so broken
 * templates there surface at render time as before.
 */

import { join, relative, resolve, sep } from "node:path";

import { file } from "bun";

import type TemplateEngine from "../template_engine";

/**
 * Build the set of suffixes that count as a locale variant, from the host's
 * configured locale list. Locale is the single localization axis - a full BCP
 * 47 language-region code - so only these exact values count. Matching a shape
 * instead (any 2-3 letter subtag) would swallow a real component named e.g.
 * "chart.max.ree" or "button.min.ree", registering it under the wrong base
 * name with no way to tell from the filename that it happened.
 */
export function make_locale_suffixes(locales: readonly string[]): Set<string> {
	return new Set<string>(locales.map((l) => l.toLowerCase()));
}

export function split_locale(rel_no_ext: string, locale_suffixes: Set<string>): { base_rel: string; locale: string | null; } {
	const last_dot = rel_no_ext.lastIndexOf(".");
	if (last_dot > 0) {
		const maybe = rel_no_ext.slice(last_dot + 1).toLowerCase();
		if (locale_suffixes.has(maybe)) {
			return { base_rel: rel_no_ext.slice(0, last_dot), locale: maybe };
		}
	}
	return { base_rel: rel_no_ext, locale: null };
}

// A ReeTag is only ever matched as a custom element, which requires at least
// one hyphen in the name (cust_elem_regex in template/custom_elements.ts).
// Plain route pages ("form.ree", "index.ree") can never be referenced as a
// tag, so a repeated name among them is not a component collision.
const REE_TAG_RE = /^[a-zA-Z][a-zA-Z0-9]*-[a-zA-Z0-9-]*$/;

function is_ree_tag(tag: string): boolean { return REE_TAG_RE.test(tag); }

export type PrecompileResult = { total: number; };

/**
 * Glob + compile every template/component at startup. Idempotent - safe to
 * call again (e.g. after clear_cache()) to rebuild the full cache.
 *
 * Throws if any template fails to compile (fail loud at boot - no silent
 * fallback). The error lists every offending file so they can all be fixed in
 * one boot.
 */
export async function precompile_templates(engine: TemplateEngine): Promise<PrecompileResult> {
	const failures: string[] = [];
	let total = 0;

	// Roots are (name-prefix, absolute dir) pairs. The views root and the
	// components/ dir map to plain names; mounted route modules map to their
	// module code ("studio/index" etc.).
	const roots: { code: string | null; root: string; is_components: boolean; }[] = [
		{ code: null, root: engine.views_dir, is_components: false },
		...(engine.shared_views_dir ? [{ code: null, root: engine.shared_views_dir, is_components: false }] : []),
		{ code: null, root: join(engine.project_root, "components"), is_components: true },
		...Array.from(engine.route_module_mounts.entries(), ([code, root]) => ({ code, root, is_components: false })),
	];

	// Pass 1: glob every root once and build the complete component index and
	// name/locale variant indexes. Nothing is compiled yet - resolution during
	// pass 2's compiles sees the full index, so ReeTag lookups never depend on
	// root processing order. Stale negative lookups are dropped: any tag that
	// now has a file is re-registered, and absent tags re-negative-cache on use.
	engine.component_misses.clear();
	const to_compile: { resolved_name: string; file_path: string; }[] = [];
	const seen = new Set<string>();
	// tag -> where it was first indexed, plus every same-root file that also
	// claims it. More than one file here is an ambiguous component (reported
	// after the index is complete, so one boot lists them all).
	const tag_origins = new Map<string, { root: string; include_path: string; files: string[]; }>();
	// Tags provided by components/ - a shared component is the documented way
	// to resolve a name collision, so it suppresses the ambiguity error.
	const components_tags = new Set<string>();
	for (const { code, root, is_components } of roots) {
		if (seen.has(root)) continue;
		seen.add(root);

		let files: string[];
		try {
			files = Array.from(new Bun.Glob("**/*.ree").scanSync({ cwd: root, onlyFiles: true, absolute: true }));
		} catch {
			continue; // root does not exist
		}

		for (const raw_path of files) {
			const file_path = resolve(raw_path);
			const rel = relative(root, file_path).split(sep).join("/");
			const rel_no_ext = rel.slice(0, -engine.ext.length);
			const { base_rel, locale } = split_locale(rel_no_ext, engine.locale_suffixes);

			// Component index: tag -> include path. components/ wins
			// (unconditional overwrite, so a shared component shadows a
			// same-named routes-tree file); routes-tree and module files fill
			// gaps (first-wins across roots - views roots run before module
			// roots, so a views-tree file beats a same-named module file).
			// Locale variants share the base, so this stays unique per tag.
			//
			// Two distinct components with the same tag name *within one root*
			// are ambiguous - an arbitrary glob-order winner would make it
			// impossible to tell which file renders - so they are collected and
			// reported below rather than silently resolved.
			const tag = base_rel.split("/").pop()!;
			const include_path = code ? `${code}/${base_rel}` : base_rel;
			if (is_components) {
				engine.component_paths.set(tag, `$components/${base_rel}`);
				components_tags.add(tag);
			} else if (!engine.component_paths.has(tag)) {
				engine.component_paths.set(tag, include_path);
				if (is_ree_tag(tag)) { tag_origins.set(tag, { root, include_path, files: [rel] }); }
			} else {
				const origin = tag_origins.get(tag);
				const is_same_root_conflict = origin !== undefined && origin.root === root && origin.include_path !== include_path;
				if (is_same_root_conflict) { origin.files.push(rel); }
			}

			const resolved_name = code ? `${code}/${rel_no_ext}` : rel_no_ext;
			const base_name = code ? `${code}/${base_rel}` : base_rel;

			let variants = engine.name_variants.get(base_name);
			if (!variants) { variants = new Map(); engine.name_variants.set(base_name, variants); }
			if (locale) {
				variants.set(locale, resolved_name);
				// Path-keyed variant index for raw includes:
				// base path (no ext) -> locale -> full file path.
				const base_without_ext = file_path.slice(0, -engine.ext.length - locale.length - 1);
				let raw = engine.raw_variants.get(base_without_ext);
				if (!raw) { raw = new Map(); engine.raw_variants.set(base_without_ext, raw); }
				raw.set(locale, file_path);
			} else {
				variants.set("*", resolved_name);
			}

			to_compile.push({ resolved_name, file_path });
		}
	}
	// Fail loud on ambiguous components before anything compiles: a tag with
	// two distinct files in one root has no defensible winner. components/
	// resolves the collision explicitly, so tags it provides are exempt.
	const ambiguous: string[] = [];
	for (const [tag, origin] of tag_origins) {
		if (components_tags.has(tag)) continue;
		if (origin.files.length < 2) continue;
		const found = Array.from(origin.files).sort().join(", ");
		ambiguous.push(`<${tag}>: ${origin.files.length} components named "${tag}${engine.ext}" in ${origin.root} (${found})`);
	}
	if (ambiguous.length > 0) {
		throw new Error(`[template] precompile: ${ambiguous.length} ambiguous component tag(s):\n  ✗ ${ambiguous.join("\n  ✗ ")}\nRename all but one, or move the intended component to components/ to make it win.`);
	}

	engine.component_index_built = true;

	// Pass 2: compile every file once (prod only). Dev never compiles - hot
	// reload recompiles per render, so broken templates there surface at
	// render time as before.
	if (engine.cache) {
		for (const { resolved_name, file_path } of to_compile) {
			total++;
			try {
				const content = await file(file_path).text();
				const fn = engine.compile(content);
				engine.compiled_cache[resolved_name] = fn;
				engine.compiled_cache[file_path] = fn;
			} catch (err) {
				failures.push(`${file_path}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	if (failures.length > 0) {
		throw new Error(`[template] precompile: ${failures.length} template(s) failed to compile:\n  ✗ ${failures.join("\n  ✗ ")}`);
	}

	return { total };
}
