#!/usr/bin/env bun
/**
 * MCP Server - Project helpers
 *
 * Provides project-state introspection: routes, templates, translations,
 * generators, config, code search, and template analysis.
 */

import { existsSync, readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";

import { file, spawnSync } from "bun";

import pkg_json from "../../package.json";

import { db } from "$config/db";
import { db_type } from "$lib/resolve_db_type";
import { get_db_config as get_project_db_config } from "./db";
import { build_code_search_args, COMPONENTS_DIR, PROJECT_ROOT, resolve_route_dir, ROUTES_DIR } from "./paths";

// ---------------------------------------------------------------------------
// Directory traversal (shared by the route and template scanners)
// ---------------------------------------------------------------------------

// Directories that never hold routes or authored .ree templates.
const SKIP_DIRS = new Set(["schema", "translations", "node_modules"]);

/**
 * Recurse `dir`, invoking `on_entry` for every direct child (file or folder).
 * Does not descend into SKIP_DIRS. A missing directory is a no-op.
 */
function walk_dir(dir: string, on_entry: (full_path: string, entry: Dirent, parent: string) => void): void {
	if (!existsSync(dir)) return;
	const entries = readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full_path = join(dir, entry.name);
		on_entry(full_path, entry, dir);
		if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) { walk_dir(full_path, on_entry); }
	}
}

// ---------------------------------------------------------------------------
// Route listing
// ---------------------------------------------------------------------------

/**
 * Scan routes/ for folders containing an index.ts and derive route metadata.
 *
 * Type is inferred from sibling files (same signals as get_route_detail):
 *   - crud     : has sql.ts + schema/ + form.ree
 *   - resource : has sql.ts (or schema/) but no form.ree
 *   - page     : plain index.ts route
 *
 * URL is derived from the folder path. The auth routes live under
 * routes/system/auth/* but the server mounts them at the root - that mount
 * remapping is not represented on disk, so their URL is reported as their
 * folder path with a note. The `home` folder maps to `/`.
 */
export function list_route_paths(): Array<{ url: string; type: string; module: string | null; }> {
	const routes: Array<{ url: string; type: string; module: string | null; }> = [];

	function classify(dir: string): string {
		const has_sql = existsSync(join(dir, "sql.ts"));
		const has_schema = existsSync(join(dir, "schema"));
		const has_form = existsSync(join(dir, "form.ree"));
		if ((has_sql || has_schema) && has_form) return "crud";
		if (has_sql || has_schema) return "resource";
		return "page";
	}

	walk_dir(ROUTES_DIR, (_full_path, entry, parent) => {
		if (!entry.isFile() || entry.name !== "index.ts") return;
		const rel = parent.slice(ROUTES_DIR.length + 1).replace(/\\/g, "/");
		const segments = rel.split("/").filter(Boolean);
		const url = rel === "home" ? "/" : `/${rel}`;
		const module = segments.length > 1 ? segments[0] : null;
		routes.push({ url, type: classify(parent), module });
	});

	return routes.sort((a, b) => a.url.localeCompare(b.url));
}

// ---------------------------------------------------------------------------
// Template listing
// ---------------------------------------------------------------------------

export function list_all_ree_files(): Array<{ path: string; type: "route" | "component" | "layout"; }> {
	const files: Array<{ path: string; type: "route" | "component" | "layout"; }> = [];

	if (existsSync(COMPONENTS_DIR)) {
		const entries = readdirSync(COMPONENTS_DIR, { withFileTypes: true });
		for (const e of entries) {
			if (e.isFile() && e.name.endsWith(".ree")) {
				files.push({ path: `components/${e.name}`, type: "component" });
			}
		}
	}

	walk_dir(ROUTES_DIR, (full_path, entry) => {
		if (!entry.isFile() || !entry.name.endsWith(".ree")) return;
		const raw_rel = full_path.startsWith(ROUTES_DIR) ? full_path.slice(ROUTES_DIR.length + 1) : full_path;
		const rel = raw_rel.replace(/\\/g, "/");
		const type = rel === "layout.ree" || rel.endsWith("/layout.ree") ? "layout" : "route";
		files.push({ path: `routes/${rel}`, type });
	});

	return files.sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// Translation listing
// ---------------------------------------------------------------------------

export async function list_translation_namespaces(): Promise<Record<string, string[]>> {
	const ns_by_lang: Record<string, string[]> = {};

	try {
		const rows = await db`SELECT DISTINCT lang, namespace FROM translations ORDER BY lang, namespace` as { lang: string; namespace: string; }[];

		for (const row of rows) {
			const lang = row.lang;
			const ns = row.namespace || "root";
			if (!ns_by_lang[lang]) ns_by_lang[lang] = [];
			if (!ns_by_lang[lang].includes(ns)) { ns_by_lang[lang].push(ns); }
		}
	} catch {
		// translations table may not exist yet
	}

	return ns_by_lang;
}

// ---------------------------------------------------------------------------
// Config / project info
// ---------------------------------------------------------------------------

export async function get_project_config(): Promise<Record<string, any>> {
	const pkg = { name: "reepolee", version: pkg_json.version, description: "Reepolee Bun Apps" };

	const conventions = get_project_db_config().conventions;
	const languages = await list_translation_namespaces();
	const all_langs = Object.keys(languages).sort();

	return {
		project: pkg,
		database: {
			type: db_type,
			connection_string: Bun.env.CONNECTION_STRING ? "(set)" : "(not set)",
			time_zone: Bun.env.TIME_ZONE || "UTC",
			...conventions,
		},
		languages: {
			active: all_langs.filter((l) => l !== "root"),
			all: all_langs,
			default: all_langs.includes("sl") ? "sl" : all_langs[0] || "en",
			names: { en: "English", sl: "Slovenian" },
			locales: { en: "en-US", sl: "sl-SI" },
		},
		server: { port: Bun.env.MCP_SERVER_PORT || "2400", static_dir: join(PROJECT_ROOT, "static") },
		components: list_components().length,
		routes: list_route_paths().length,
		translation_keys: Object.values(languages).flat().length,
	};
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

export function list_generators(): Array<{ name: string; file: string; description: string; }> {
	return [
		{
			name: "resource",
			file: "generator/reeman/callers/resource_caller.ts",
			description: "Full pipeline: schema + CRUD generation for a single DB table (positional table, --prefix, --parent, --force, --translate)",
		},
		{
			name: "schema",
			file: "generator/schema.ts",
			description: "Introspect DB tables and generate schema/ folder with types and validation (positional table or 'all', --prefix, --parent)",
		},
		{
			name: "crud",
			file: "generator/crud/main.ts",
			description: "Read schema files and generate CRUD routes, templates, SQL (positional table, --prefix, --parent, --force, --translate)",
		},
		{
			name: "bulk",
			file: "generator/reeman/callers/resource_caller.ts",
			description: "Full pipeline for multiple tables at once (positional table names, shared --prefix, --translate)",
		},
		{
			name: "nested",
			file: "generator/reeman/callers/resource_caller.ts",
			description: "Nested CRUD for child tables under a parent (positional child tables, required --parent, --prefix)",
		},
		{
			name: "sync_translations",
			file: "generator/translate_namespace.ts",
			description: "Sync translation keys across all language namespaces, optionally translate via AI",
		},
		{
			name: "add_language",
			file: "generator/add_language.ts",
			description: "Add a new language to the project with AI translation (positional lang code, --translate)",
		},
		{
			name: "remove_language",
			file: "generator/remove_language.ts",
			description: "Remove a language and all its translations from the project (positional lang code, --force, --new-default)",
		},
		{
			name: "user",
			file: "generator/user_lib.ts",
			description: "Create a new user with hashed password (positional username, email, password, --modules)",
		},
		{
			name: "validation",
			file: "generator/validation_generator.ts",
			description: "Zod validation schema library module (not a runnable CLI command)",
		},
	];
}

// ---------------------------------------------------------------------------
// Read project files
// ---------------------------------------------------------------------------

export async function read_project_file(filePath: string): Promise<string | null> {
	const abs_path = join(PROJECT_ROOT, filePath);
	if (!existsSync(abs_path)) return null;
	return await file(abs_path).text();
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export function list_components(): string[] {
	if (!existsSync(COMPONENTS_DIR)) return [];
	const entries = readdirSync(COMPONENTS_DIR, { withFileTypes: true });
	return entries.filter((e) => e.isFile() && e.name.endsWith(".ree")).map((e) => e.name.replace(/\.ree$/, ""));
}

// ---------------------------------------------------------------------------
// Template analysis
// ---------------------------------------------------------------------------

export function analyze_template(tpl: string): Record<string, any> {
	const result: Record<string, any> = {
		layout: null,
		includes: [],
		components: [],
		variables: new Set(),
		conditionals: 0,
		loops: 0,
		hasElse: false,
	};

	const layout_match = tpl.match(/\{#layout\(['"]([^'"]+)['"]/);
	if (layout_match) result.layout = layout_match[1];

	const include_regex = /\{#include\(['"]([^'"]+)['"]/g;
	let m;
	while ((m = include_regex.exec(tpl)) !== null) {
		if (!m[1].startsWith("$components/")) { result.includes.push(m[1]); }
	}

	const comp_regex = /<([a-zA-Z][a-zA-Z0-9]*-[a-zA-Z0-9-]*)\b/g;
	while ((m = comp_regex.exec(tpl)) !== null) {
		result.components.push(m[1]);
	}

	const if_regex = /\{#if\s+/g;
	while (if_regex.exec(tpl) !== null) result.conditionals++;
	const else_regex = /\{:else\s*\}/g;
	while (else_regex.exec(tpl) !== null) result.hasElse = true;

	const each_regex = /\{#each\s+/g;
	while (each_regex.exec(tpl) !== null) result.loops++;

	const var_regex = /\{[=~]\s*([\w.]+(?:\.[\w]+)*)\s*\}/g;
	while ((m = var_regex.exec(tpl)) !== null) {
		const ref = m[1];
		if (!ref.includes("(")) {
			const parts = ref.split(".");
			if (parts[0] !== "helpers" && parts[0] !== "props") { result.variables.add(parts[0]); }
		}
	}

	const props_var_regex = /\bprops\.([\w]+)\b/g;
	while ((m = props_var_regex.exec(tpl)) !== null) {
		result.variables.add(`props.${m[1]}`);
	}

	result.variables = [...result.variables].sort();
	return result;
}

// ---------------------------------------------------------------------------
// Code search
// ---------------------------------------------------------------------------

export async function search_code(pattern: string, glob?: string, max_results = 50): Promise<{ matches: Array<{ file: string; line: number; content: string; }>; total: number; }> {
	const matches: Array<{ file: string; line: number; content: string; }> = [];
	let total = 0;

	const args = build_code_search_args(pattern, glob);
	const result = spawnSync(["rg", ...args]);

	if (result.exitCode !== 0 && result.exitCode !== 1) { throw new Error(`ripgrep exited with code ${result.exitCode}`); }

	const stdout = result.stdout.toString();
	const lines = stdout.split("\n").filter(Boolean);

	for (const line of lines) {
		if (total >= max_results) break;
		const sep_index = line.indexOf(":");
		if (sep_index < 0) continue;
		const file = line.slice(0, sep_index);
		const rest = line.slice(sep_index + 1);
		const line_sep_index = rest.indexOf(":");
		const line_num = parseInt(rest.slice(0, line_sep_index), 10);
		const content = rest.slice(line_sep_index + 1);
		if (!Number.isNaN(line_num)) {
			matches.push({ file: file.replace(`${PROJECT_ROOT}/`, ""), line: line_num, content });
			total++;
		}
	}

	return { matches, total: matches.length };
}

// ---------------------------------------------------------------------------
// Route detail
// ---------------------------------------------------------------------------

export async function get_route_detail(routeUrl: string): Promise<{ url: string; files: string[]; exists: boolean; }> {
	const dir_path = resolve_route_dir(routeUrl);
	const files: string[] = [];

	const patterns = [
		"index.ts",
		"index.ree",
		"form.ree",
		"sql.ts",
		"sql_view.ts",
		"schema/table.ts",
		"schema/validation_server.ts",
	];
	for (const p of patterns) {
		const full_path = join(dir_path, p);
		if (existsSync(full_path)) { files.push(p); }
	}

	return { url: routeUrl, files, exists: files.length > 0 };
}
