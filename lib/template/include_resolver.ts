/**
 * Include path resolver - pure function extracted from TemplateEngine.
 *
 * Resolves include paths relative to the current template name.
 * Supports alias paths ($components/, $lib/), relative paths, views-root
 * relative paths, and extension-based kind detection.
 *
 * $components/ and $lib/ reach outside the views tree, under the project
 * root (which defaults to the views dir's parent).
 */

import path, { dirname, extname, join, resolve as path_resolve } from "node:path";

import type { ResolveResult } from "./types";

function assert_within_base(file_path: string, base_path: string, include_name: string): string {
	const resolved_path = path_resolve(file_path);
	const resolved_base = path_resolve(base_path);
	const relative_path = path.relative(resolved_base, resolved_path);

	if (relative_path === "" || (!relative_path.startsWith(`..${path.sep}`) && relative_path !== ".." && !path.isAbsolute(relative_path))) {
		return resolved_path;
	}

	throw new Error(`Include path escapes base directory: ${include_name}`);
}

/**
 * Resolve include path relative to the current template name.
 *
 * @param current_name - The current template name (views-root relative, no extension)
 * @param include_name - The include path to resolve
 * @param views_dir    - Absolute path to the views directory
 * @param ext         - Template file extension (e.g. ".ree")
 * @param project_root - Base for the $components/ and $lib/ aliases
 *
 * Supports:
 * - Alias names: "$components/partial", "$lib/partial"
 * - Relative names: "./partial", "../partial", "./validation.js"
 * - Absolute-from-views root: "/pages/home" or "pages/home"
 * - Extension rules:
 * * ext === param.ext -> treat as template (compiled)
 * * other ext        -> treat as raw file (unescaped text)
 * * no ext           -> template with this.ext
 */
export function resolve_include(current_name: string, include_name: string, views_dir: string, ext: string, project_root: string = dirname(views_dir)): ResolveResult {
	// Normalize include_name into views-relative form
	let name = include_name.trim();
	let alias_base: string | null = null;

	// ALIAS RESOLUTION - each alias names a directory outside the views tree.
	if (name.startsWith("$components/")) {
		name = name.slice("$components/".length);
		alias_base = join(project_root, "components");
	} else if (name.startsWith("$lib/")) {
		name = name.slice("$lib/".length);
		alias_base = join(project_root, "lib");
	}

	const is_alias_path = alias_base !== null;

	// If it starts with '/', drop the leading slash and treat as views-root relative
	if (!is_alias_path && name.startsWith("/")) {
		name = name.slice(1);
	} else if (!is_alias_path && (name.startsWith("./") || name.startsWith("../"))) {
		// Relative to the current template dir
		const base_dir = dirname(current_name);
		// Use posix-style joining to keep forward slashes in names
		const joined = path.posix.join(base_dir.replace(/\\\\/g, "/"), name);
		name = joined;
	}
	// else: treat as already views-root relative (e.g., "components/card") or alias path

	const file_ext = extname(name);
	const base_path = alias_base ?? views_dir;
	const target_path = file_ext ? name : name + ext;
	const safe_file_path = assert_within_base(join(base_path, target_path), base_path, include_name);

	if (file_ext) {
		if (file_ext === ext) {
			// Treat as template with explicit extension -> remove ext to get name used by render()
			const template_name = name.slice(0, -file_ext.length);

			// If it's an alias path, resolve relative to project root instead of views_dir
			if (is_alias_path) {
				// For alias templates, we need to load them directly since they're outside views_dir
				return { kind: "raw", file_path: safe_file_path }; // Will be treated as raw but compiled
			}

			return { kind: "template", template_name };
		} else {
			// Treat as raw file to be injected unescaped
			return { kind: "raw", file_path: safe_file_path };
		}
	} else {
		// No extension -> template with default ext
		if (is_alias_path) {
			return { kind: "raw", file_path: safe_file_path }; // Will load and compile as .ree
		}
		return { kind: "template", template_name: name };
	}
}

/**
 * Resolve a {#layout()} name to a views-root-relative template name.
 *
 * Layouts differ from includes in two ways:
 * - The name is always a template; never extension-sniffed. A dotted
 *   convention name like "wallpaper.layout" must not be read as a file
 *   with a ".layout" extension.
 * - Resolution is co-location-first: a layout sitting next to the page
 *   wins, otherwise fall back to the views root (preserving the historic
 *   root-only behaviour for "layout", "docs.layout", etc).
 *
 * @param current_name - Current template name (views-root relative, no extension)
 * @param layout_name  - Name from the {#layout()} directive
 * @param views_dir    - Absolute path to the views directory
 * @param ext          - Template file extension (e.g. ".ree")
 * @param exists       - Predicate used to test candidate files
 */
export function resolve_layout(current_name: string, layout_name: string, views_dir: string, ext: string, exists: (file_path: string) => boolean): string {
	const name = layout_name.trim().replace(/^\//, "");

	// Explicitly relative names are resolved against the page dir only.
	const is_explicit_relative = name.startsWith("./") || name.startsWith("../");
	const base_dir = dirname(current_name).replace(/\\/g, "/");
	const relative_name = path.posix.normalize(path.posix.join(base_dir === "." ? "" : base_dir, name));

	if (is_explicit_relative) {
		assert_within_base(join(views_dir, relative_name + ext), views_dir, layout_name);
		return relative_name;
	}

	// Bare name: prefer a co-located layout, else the views root.
	const co_located_path = assert_within_base(join(views_dir, relative_name + ext), views_dir, layout_name);
	if (relative_name !== name && exists(co_located_path)) { return relative_name; }

	assert_within_base(join(views_dir, name + ext), views_dir, layout_name);
	return name;
}
