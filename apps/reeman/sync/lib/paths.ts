import { statSync } from "node:fs";
import { resolve, sep } from "node:path";

/** Normalize a filesystem-joined relative path to forward slashes for comparison keys and ignore patterns. */
export function to_forward_slashes(rel_path: string): string {
	return rel_path.split(sep).join("/");
}

/** True when `child` (canonical, absolute) is `root` itself or nested inside it. */
export function is_contained(root: string, child: string): boolean {
	const canonical_root = resolve(root);
	const canonical_child = resolve(child);
	if (canonical_child === canonical_root) return true;
	return canonical_child.startsWith(canonical_root + sep);
}

export type SourceValidationError = "empty" | "not-found" | "not-directory" | "equals-project" | "nested-in-project" | "contains-project";

/**
 * Validate a submitted upstream source directory against the current project
 * root. Resolves both to canonical absolute paths before comparing so `..`
 * segments and relative input can't slip past containment checks.
 */
export async function validate_source_dir(raw_source: string, project_root: string): Promise<{ ok: true; canonical: string } | { ok: false; error: SourceValidationError }> {
	const trimmed = raw_source.trim();
	if (!trimmed) return { ok: false, error: "empty" };

	const canonical_source = resolve(trimmed);
	const canonical_project = resolve(project_root);

	let is_dir = false;
	try {
		is_dir = statSync(canonical_source).isDirectory();
	} catch {
		return { ok: false, error: "not-found" };
	}
	if (!is_dir) return { ok: false, error: "not-directory" };

	if (canonical_source === canonical_project) return { ok: false, error: "equals-project" };
	if (is_contained(canonical_project, canonical_source)) return { ok: false, error: "nested-in-project" };
	if (is_contained(canonical_source, canonical_project)) return { ok: false, error: "contains-project" };

	return { ok: true, canonical: canonical_source };
}
