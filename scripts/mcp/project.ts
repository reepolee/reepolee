#!/usr/bin/env bun
/**
 * MCP Server - Project helpers
 *
 * Provides project-state introspection: routes, templates, translations,
 * generators, config, code search, and template analysis.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { file, spawnSync } from "bun";

import pkg_json from "../../package.json";

import { db } from "$config/db";
import { db_type } from "$lib/resolve_db_type";
import { list_translation_files } from "$lib/translation_files";
import { get_db_config as get_project_db_config } from "./db";
import { MAIN_APP_POSIX, PLATFORM_DIR } from "$config/paths";
import { build_code_search_args, COMPONENTS_DIR, PLATFORM_ROOT, PROJECT_ROOT, resolve_route_dir, ROUTES_DIR } from "./paths";

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
 * Scan the main app and the shared platform tree for folders containing an
 * index.ts and derive route metadata.
 *
 * Type is inferred from sibling files (same signals as get_route_detail):
 *   - crud     : has sql.ts + schema/ + form.ree
 *   - resource : has sql.ts (or schema/) but no form.ree
 *   - page     : plain index.ts route
 *
 * URL is derived from the folder path. The auth routes live under
 * platform/auth/* but every server mounts them at the root - that mount
 * remapping is not represented on disk, so their URL is reported as their
 * folder path with a note. The `home` folder maps to `/`.
 */
export function list_route_paths(): Array<{ url: string; type: string; module: string | null; }> {
	const routes: Array<{ url: string; type: string; module: string | null; }> = [];

	function classify(dir: string): string {
		const has_sql = existsSync(join(dir, "sql.ts"));
		const has_store = existsSync(join(dir, "store.ts"));
		const has_schema = existsSync(join(dir, "schema"));
		const has_form = existsSync(join(dir, "form.ree"));
		if (has_store && has_schema && has_form) return "bread";
		if ((has_sql || has_schema) && has_form) return "crud";
		if (has_sql || has_schema) return "resource";
		return "page";
	}

	for (const root of [ROUTES_DIR, PLATFORM_ROOT]) {
		walk_dir(root, (_full_path, entry, parent) => {
			if (!entry.isFile() || entry.name !== "index.ts") return;
			const rel = parent.slice(root.length + 1).replace(/\\/g, "/");
			const segments = rel.split("/").filter(Boolean);
			const url = rel === "home" ? "/" : `/${rel}`;
			const module = segments.length > 1 ? segments[0]! : null;
			routes.push({ url, type: classify(parent), module });
		});
	}

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

	for (const { root, prefix } of [{ root: ROUTES_DIR, prefix: MAIN_APP_POSIX }, { root: PLATFORM_ROOT, prefix: PLATFORM_DIR }]) {
		walk_dir(root, (full_path, entry) => {
			if (!entry.isFile() || !entry.name.endsWith(".ree")) return;
			const raw_rel = full_path.startsWith(root) ? full_path.slice(root.length + 1) : full_path;
			const rel = raw_rel.replace(/\\/g, "/");
			const type = rel === "layout.ree" || rel.endsWith("/layout.ree") ? "layout" : "route";
			files.push({ path: `${prefix}/${rel}`, type });
		});
	}

	return files.sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// Translation listing
// ---------------------------------------------------------------------------

export async function list_translation_namespaces(): Promise<Record<string, string[]>> {
	const ns_by_locale: Record<string, string[]> = {};
	const files = await list_translation_files();
	for (const item of files) {
		if (!ns_by_locale[item.locale]) ns_by_locale[item.locale] = [];
		const namespaces = ns_by_locale[item.locale]!;
		if (!namespaces.includes(item.namespace)) namespaces.push(item.namespace);
	}
	for (const namespaces of Object.values(ns_by_locale)) namespaces.sort();

	return ns_by_locale;
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
			connection_string: Bun.env.DEV_CONNECTION_STRING ? "(set)" : "(not set)",
			time_zone: Bun.env.TIME_ZONE || "UTC",
			...conventions,
		},
		languages: {
			active: all_langs.filter((l) => l !== "root"),
			all: all_langs,
			default: all_langs.includes("sl") ? "sl" : all_langs[0] || "en",
			names: { en: "English", sl: "Slovenian" },
			locales: { en: "en-us", sl: "sl-si" },
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
			name: "create_bread",
			file: "generator/crud/create_bread.ts",
			description: "Generate a single-content BREAD resource from a supplied synthetic schema for a non-DB data source - produces store.ts (Item/RESOURCE_NAME stub) instead of sql.ts (synthetic_schema object, --prefix, --route-name, --force)",
		},
		{
			name: "create_localized_bread",
			file: "generator/crud/create_bread.ts",
			description: "Same as create_bread, but the store.ts stub and form/index UI expect the resource's store to hold content per locale (synthetic_schema object, --prefix, --route-name, --force)",
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
			name: "install_locale",
			file: "generator/install_locale.ts",
			description: "Install an archived locale from locales-archive/ (curated translations, no AI) - positional lang code, --activate",
		},
		{
			name: "add_locale",
			file: "generator/add_locale.ts",
			description: "Add a new language to the project with AI translation (positional lang code, --translate)",
		},
		{
			name: "remove_locale",
			file: "generator/remove_locale.ts",
			description: "Remove a language and all its translations from the project (positional lang code, --force, --new-default)",
		},
		{
			name: "sync_locale_tables",
			file: "generator/reeman/sync_locale_tables.ts",
			description: "Reconcile the per-locale clone tables against their base tables and the configured locales (optional positional table, --dry-run). Idempotent - run after any schema change to a localized table",
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
		if (!m[1]!.startsWith("$components/")) { result.includes.push(m[1]!); }
	}

	const comp_regex = /<([a-zA-Z][a-zA-Z0-9]*-[a-zA-Z0-9-]*)\b/g;
	while ((m = comp_regex.exec(tpl)) !== null) {
		result.components.push(m[1]!);
	}

	const if_regex = /\{#if\s+/g;
	while (if_regex.exec(tpl) !== null) result.conditionals++;
	const else_regex = /\{:else\s*\}/g;
	while (else_regex.exec(tpl) !== null) result.hasElse = true;

	const each_regex = /\{#each\s+/g;
	while (each_regex.exec(tpl) !== null) result.loops++;

	const var_regex = /\{[=~]\s*([\w.]+(?:\.[\w]+)*)\s*\}/g;
	while ((m = var_regex.exec(tpl)) !== null) {
		const ref = m[1]!;
		if (!ref.includes("(")) {
			const parts = ref.split(".");
			if (parts[0] !== "helpers" && parts[0] !== "props") { result.variables.add(parts[0]!); }
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

export async function get_route_detail(routeUrl: string): Promise<{ url: string; files: string[]; exists: boolean; type: "page" | "resource" | "crud" | "bread"; storage: "none" | "sql" | "store"; data_path: string | null; }> {
	const dir_path = resolve_route_dir(routeUrl);
	const files: string[] = [];

	const patterns = [
		"index.ts",
		"index.ree",
		"form.ree",
		"sql.ts",
		"sql.custom.ts",
		"sql_view.ts",
		"store.ts",
		"store.custom.ts",
		"schema/table.generated.ts",
		"schema/table.ts",
		"schema/validation_server.ts",
	];
	for (const p of patterns) {
		const full_path = join(dir_path, p);
		if (existsSync(full_path)) { files.push(p); }
	}

	const has_store = files.includes("store.ts");
	const has_sql = files.includes("sql.ts");
	const has_schema = files.some((file_path) => file_path.startsWith("schema/"));
	const has_form = files.includes("form.ree");
	const type = has_store && has_schema && has_form ? "bread" : has_sql && has_form ? "crud" : has_sql || has_schema ? "resource" : "page";
	const storage = has_store ? "store" : has_sql ? "sql" : "none";
	let data_path: string | null = null;
	const store_path = join(dir_path, "store.ts");
	if (has_store) {
		const store_source = readFileSync(store_path, "utf8");
		const join_match = store_source.match(/const data_path = join\(import\.meta\.dir,\s*((?:"[^"]+"\s*,?\s*)+)\)/);
		const quoted_segments = join_match?.[1]?.match(/"([^"]+)"/g) ?? [];
		const segments = quoted_segments.map((segment) => segment.slice(1, -1));
		if (segments.length > 0) {
			const resolved_data_path = resolve(dir_path, ...segments);
			const relative_data_path = relative(PROJECT_ROOT, resolved_data_path);
			if (!relative_data_path.startsWith("..") && !isAbsolute(relative_data_path)) {
				data_path = relative_data_path.replaceAll("\\", "/");
			}
		}
	}

	return { url: routeUrl, files, exists: files.length > 0, type, storage, data_path };
}
