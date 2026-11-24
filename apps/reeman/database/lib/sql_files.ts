/**
 * SQL file discovery - finds editable .sql files under sql/ and
 * marketplace/ (excluding studio/'s own seed files) and validates that
 * a requested path is inside one of those roots. Lives in database/ (not
 * studio/) because the free /database page depends on it too; studio/ is
 * the paid addon and can be excluded from a release without breaking this.
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

type Dialect = "sqlite" | "mysql";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const DIALECTS = ["sqlite", "mysql"] as const;
const DEMO_ROOTS = ["marketplace"];
const EXCLUDED_DIRS = new Set(["studio", "init"]);

export interface SqlFileInfo {
	/** Path relative to the repo root, used as the API identifier. */
	path: string;
	dialect: Dialect;
	/** Grouping label for the file picker, e.g. "sql demos" or "marketplace/chefs-blog". */
	group: string;
	name: string;
}

export interface SqlFileGroup {
	group: string;
	files: SqlFileInfo[];
}

/** Build the canonical Studio URL for a dynamically discovered SQL file. */
export function studio_url(path: string, object_name = ""): string {
	const params = new URLSearchParams({ path });
	if (object_name) params.set("object", object_name);
	return `/studio?${params.toString()}`;
}

function dialect_of(path: string): Dialect {
	return path.includes(`${sep}mysql${sep}`) || path.includes("/mysql/") ? "mysql" : "sqlite";
}

function collect(dir: string, out: SqlFileInfo[]): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries.sort()) {
		const abs = join(dir, entry);
		const stat = statSync(abs);
		if (stat.isDirectory()) {
			if (EXCLUDED_DIRS.has(entry)) continue;
			collect(abs, out);
			continue;
		}
		if (!entry.endsWith(".sql")) continue;
		const relative_dir = relative(REPO_ROOT, dir);
		const group = relative_dir.replaceAll("\\", "/");
		out.push({ path: relative(REPO_ROOT, abs), dialect: dialect_of(abs), group, name: entry });
	}
}

/**
 * Return whether a repo-relative SQL path belongs to Studio's editable roots.
 * Keep this policy path-based and dynamic: new files under sql/{dialect}/
 * become editable without adding filenames here, while sql/{dialect}/init/
 * (fresh-install DDL + core translations, run by Quick Start) remains
 * run-only.
 */
export function is_studio_editable_path(rel_path: string): boolean {
	const normalized = rel_path.replaceAll("\\", "/").replace(/^\.\//, "");
	if (!normalized.endsWith(".sql") || normalized.split("/").includes("..")) return false;

	const parts = normalized.split("/");
	if (parts.length >= 3 && parts[0] === "sql" && DIALECTS.includes(parts[1] as (typeof DIALECTS)[number]) && !parts.includes("init")) return true;
	return parts.length >= 4 && parts[0] === "marketplace" && parts[2] !== undefined && DIALECTS.includes(parts[2] as (typeof DIALECTS)[number]);
}

/** List all editable .sql files under the dynamic Studio roots. */
export function list_demo_files(): SqlFileInfo[] {
	const out: SqlFileInfo[] = [];
	for (const dialect of DIALECTS) collect(join(REPO_ROOT, "sql", dialect), out);
	for (const root of DEMO_ROOTS) collect(join(REPO_ROOT, root), out);
	return out.filter((file) => is_studio_editable_path(file.path));
}

/** Group discovered files by their containing folder for the file picker. */
export function group_demo_files(files: SqlFileInfo[]): SqlFileGroup[] {
	const grouped_files = new Map<string, SqlFileInfo[]>();
	for (const file of files) {
		const group_files = grouped_files.get(file.group) ?? [];
		group_files.push(file);
		grouped_files.set(file.group, group_files);
	}
	const group_entries = [...grouped_files.entries()];
	return group_entries.map(([group, group_files]) => ({ group, files: group_files }));
}

/**
 * Resolve a client-supplied relative path to an absolute path, refusing anything
 * outside the allowed demo roots. Returns null when the path is not allowed.
 */
export function resolve_demo_path(rel_path: string): string | null {
	if (!is_studio_editable_path(rel_path)) return null;
	const abs = resolve(REPO_ROOT, rel_path);
	if (relative(REPO_ROOT, abs).startsWith("..")) return null;

	const allowed = list_demo_files().some((f) => resolve(REPO_ROOT, f.path) === abs);
	return allowed ? abs : null;
}
