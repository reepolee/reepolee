import { isAbsolute, resolve, sep } from "node:path";

/**
 * Containment check for a .sql file path before execution. Guards the web
 * action only (post_run_sql -> action_run_sql): the POST body is
 * client-controlled, so relative paths only (relative to the project root,
 * which is what the web form produces), no ".." segments, a mandatory .sql
 * extension, and - when `allowed_root` is given - containment inside that
 * subdirectory on top of the project root. Returns the resolved absolute
 * path. The CLI deliberately does NOT resolve through here - its contract
 * accepts any path (see execute_sql_file).
 *
 * Pure path math on purpose - no imports beyond node:path, so callers and
 * tests never pull in a database connection.
 */
export function validate_sql_file_path(relative_path: string, opts: { allowed_root?: string } = {}): string {
	const normalized = relative_path.trim();
	if (!normalized) { throw new Error("No SQL file selected."); }
	if (isAbsolute(normalized)) { throw new Error(`SQL file path must be relative to the project: ${normalized}`); }
	if (normalized.split(/[\\/]+/).includes("..")) { throw new Error(`SQL file path may not contain ".." segments: ${normalized}`); }
	if (!normalized.toLowerCase().endsWith(".sql")) { throw new Error(`Only .sql files can be executed: ${normalized}`); }

	const base = resolve(process.cwd());
	const abs_path = resolve(base, normalized);
	if (abs_path !== base && !abs_path.startsWith(base + sep)) {
		throw new Error(`SQL file path escapes the project directory: ${normalized}`);
	}
	if (opts.allowed_root !== undefined) {
		const root = resolve(opts.allowed_root);
		if (!abs_path.startsWith(root + sep)) {
			throw new Error(`SQL file path escapes the allowed directory: ${normalized}`);
		}
	}
	return abs_path;
}
