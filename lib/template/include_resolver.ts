/**
 * Include path resolver - pure function extracted from TemplateEngine.
 *
 * Resolves include paths relative to the current template name.
 * Supports alias paths ($components/, $routes/, $lib/), relative paths,
 * views-root relative paths, and extension-based kind detection.
 */

import path, { dirname, extname, join, resolve as path_resolve } from "node:path";

import type { ResolveResult } from "./types";

/**
 * Resolve include path relative to the current template name.
 *
 * @param current_name - The current template name (views-root relative, no extension)
 * @param include_name - The include path to resolve
 * @param views_dir    - Absolute path to the views directory
 * @param ext         - Template file extension (e.g. ".ree")
 *
 * Supports:
 * - Alias names: "$components/partial", "$routes/partial", "$lib/partial"
 * - Relative names: "./partial", "../partial", "./validation.js"
 * - Absolute-from-views root: "/pages/home" or "pages/home"
 * - Extension rules:
 * * ext === param.ext -> treat as template (compiled)
 * * other ext        -> treat as raw file (unescaped text)
 * * no ext           -> template with this.ext
 */
export function resolve_include(current_name: string, include_name: string, views_dir: string, ext: string): ResolveResult {
	// Normalize include_name into views-relative form
	let name = include_name.trim();
	let is_alias_path = false;

	// ALIAS RESOLUTION - resolve to project root relative
	if (name.startsWith("$components/")) {
		name = name.replace("$components/", "components/");
		is_alias_path = true;
	} else if (name.startsWith("$routes/")) {
		name = name.replace("$routes/", "routes/");
		is_alias_path = true;
	} else if (name.startsWith("$lib/")) {
		name = name.replace("$lib/", "lib/");
		is_alias_path = true;
	}

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

	if (file_ext) {
		if (file_ext === ext) {
			// Treat as template with explicit extension -> remove ext to get name used by render()
			const template_name = name.slice(0, -file_ext.length);

			// If it's an alias path, resolve relative to project root instead of views_dir
			if (is_alias_path) {
				const project_root = dirname(views_dir);
				const file_path = join(project_root, template_name + ext);
				// For alias templates, we need to load them directly since they're outside views_dir
				return { kind: "raw", file_path }; // Will be treated as raw but compiled
			}

			return { kind: "template", template_name };
		} else {
			// Treat as raw file to be injected unescaped
			const base_path = is_alias_path ? dirname(views_dir) : views_dir;
			const raw_file_path = join(base_path, name);
			// Security: ensure it remains under appropriate directory
			const resolved = path_resolve(raw_file_path);
			const base_resolved = path_resolve(base_path);
			if (!resolved.startsWith(base_resolved)) { throw new Error(`Include path escapes base directory: ${include_name}`); }
			return { kind: "raw", file_path: resolved };
		}
	} else {
		// No extension -> template with default ext
		if (is_alias_path) {
			const project_root = dirname(views_dir);
			const file_path = join(project_root, name + ext);
			return { kind: "raw", file_path }; // Will load and compile as .ree
		}
		return { kind: "template", template_name: name };
	}
}
