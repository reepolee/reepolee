/**
 * MCP Server - shared filesystem paths.
 *
 * Single source of truth for the project root and the two directories the MCP
 * tools scan. Imported by index.ts, db.ts, and project.ts so the constants are
 * not re-derived per module.
 */

import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const PROJECT_ROOT = join(import.meta.dir, "..", "..");
export const COMPONENTS_DIR = join(PROJECT_ROOT, "components");
export const ROUTES_DIR = join(PROJECT_ROOT, "routes");

const SEARCH_EXCLUDE_GLOBS = [
	"!.env",
	"!.env.*",
	"!**/.env",
	"!**/.env.*",
	"!**/.git/**",
	"!**/node_modules/**",
	"!**/vendor/**",
	"!**/*.zip",
	"!**/*.tar",
	"!**/*.gz",
	"!**/*.7z",
	"!**/*.rar",
	"!**/*.pem",
	"!**/*.key",
	"!**/*secret*",
	"!**/*credential*",
];

function is_within_dir(path: string, dir: string): boolean {
	const relative_path = relative(dir, path);
	return !!relative_path && relative_path !== ".." && !relative_path.startsWith(`..${sep}`) && !isAbsolute(relative_path);
}

function assert_safe_relative_path(path: string, label: string): void {
	if (!path || path !== path.trim() || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
		throw new Error(`${label}: invalid path`);
	}

	const segments = path.split("/");
	if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
		throw new Error(`${label}: path traversal detected`);
	}
}

function assert_safe_search_glob(glob: string): void {
	assert_safe_relative_path(glob, "search glob");
	const normalized = glob.toLowerCase();
	if ([".env", ".git", "node_modules", "vendor", "secret", "credential", ".zip", ".tar", ".gz", ".7z", ".rar", ".pem", ".key"].some((blocked) => normalized.includes(blocked))) {
		throw new Error("search glob: protected paths are not searchable");
	}
}

export function resolve_template_file(path: string): string {
	assert_safe_relative_path(path, "template path");
	if (!path.endsWith(".ree")) { throw new Error("template path: only .ree files are allowed"); }

	const resolved = resolve(PROJECT_ROOT, path);
	if (!is_within_dir(resolved, ROUTES_DIR) && !is_within_dir(resolved, COMPONENTS_DIR)) {
		throw new Error("template path: file must be under routes or components");
	}

	return resolved;
}

export function resolve_route_dir(route_url: string): string {
	const relative_path = route_url.replace(/^\/+/, "");
	if (!relative_path) { return ROUTES_DIR; }
	assert_safe_relative_path(relative_path, "route path");
	const resolved = resolve(ROUTES_DIR, relative_path);
	if (!is_within_dir(resolved, ROUTES_DIR)) { throw new Error("route path: path traversal detected"); }
	return resolved;
}

export function build_code_search_args(pattern: string, glob?: string): string[] {
	if (!pattern) { throw new Error("search pattern is required"); }
	if (glob) { assert_safe_search_glob(glob); }

	const args = ["--line-number", "--with-filename", "--no-heading", "--color", "never"];
	if (glob) { args.push("--glob", glob); }
	for (const exclude_glob of SEARCH_EXCLUDE_GLOBS) {
		args.push("--glob", exclude_glob);
	}
	args.push("--", pattern, PROJECT_ROOT);
	return args;
}
