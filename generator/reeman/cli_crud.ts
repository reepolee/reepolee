/**
 * Shared flag parsing and helpers for the reeman CLI's CRUD generator
 * subcommands (schema/crud/bulk/refresh-crud). Split out of cli.ts so the
 * dispatcher only routes subcommands.
 */

import { join, relative } from "node:path";
import { parseArgs } from "node:util";

import { MAIN_APP } from "$config/paths";
import type { GridColumnDefinition } from "../schema/types";

import { sync_all_namespaces } from "../translate_namespace";
import { run_full_pipeline } from "./callers/resource_caller";

// ---------------------------------------------------------------------------
// Shared flag parsing for the CRUD generator commands (schema/crud/full/all)
// ---------------------------------------------------------------------------

export function parse_crud_flags(argv: string[]) {
	const { values, positionals } = parseArgs({
		args: argv,
		options: {
			force: { type: "boolean", default: false },
			translate: { type: "boolean", default: false },
			prefix: { type: "string", default: "" },
			parent: { type: "string", default: "" },
			"route-name": { type: "string", default: "" },
			pagination: { type: "string" },
			"render-strategy": { type: "string" },
			"template-tags": { type: "string" },
			"grid-columns": { type: "string" },
			"grid-column-definitions": { type: "string" },
		},
		allowPositionals: true,
		strict: false,
	});

	const raw_pagination = values.pagination;
	const pagination_method: "cursor" | "offset" | undefined = raw_pagination === "cursor" || raw_pagination === "offset" ? raw_pagination : undefined;

	const raw_render = values["render-strategy"];
	const render_strategy: "stream" | "load" | undefined = raw_render === "stream" || raw_render === "load" ? raw_render : undefined;

	const raw_template_tags = values["template-tags"];
	const template_tags: "flat" | "tags" | undefined = raw_template_tags === "flat" || raw_template_tags === "tags" ? raw_template_tags : undefined;

	// Comma-separated index-grid column selection. Anything outside the list is
	// written with grid: false. Omitted entirely means "apply the default cap".
	const raw_grid_columns = values["grid-columns"];
	const parsed_grid_columns = raw_grid_columns ? String(raw_grid_columns).split(",").map((c) => c.trim()).filter(Boolean) : [];
	const grid_columns = parsed_grid_columns.length > 0 ? parsed_grid_columns : undefined;
	const raw_grid_column_definitions = values["grid-column-definitions"];
	const grid_column_definitions = raw_grid_column_definitions
		? parse_grid_column_definitions(decodeURIComponent(String(raw_grid_column_definitions)))
		: undefined;

	return {
		table: positionals[0] !== undefined ? String(positionals[0]) : undefined,
		positionals: positionals.map((value) => String(value)),
		force: Boolean(values.force),
		translate: Boolean(values.translate),
		prefix: String(values.prefix ?? ""),
		parent: String(values.parent ?? ""),
		route_name: String(values["route-name"] ?? ""),
		pagination_method,
		render_strategy,
		template_tags,
		grid_columns,
		grid_column_definitions,
	};
}

function parse_grid_column_definitions(raw: string): GridColumnDefinition[] {
	const parsed: unknown = JSON.parse(raw);
	if (!Array.isArray(parsed)) throw new Error("--grid-column-definitions must be a JSON array.");

	const definitions: GridColumnDefinition[] = [];
	const names = new Set<string>();
	for (const item of parsed) {
		if (typeof item !== "object" || item === null) throw new Error("Each grid column definition must be an object.");
		const candidate = item as Record<string, unknown>;
		if (typeof candidate.name !== "string" || !candidate.name.trim()) throw new Error("Each grid column definition requires a name.");
		if (typeof candidate.width !== "string" || !candidate.width.trim()) throw new Error(`Grid column "${candidate.name}" requires a width.`);
		if (typeof candidate.class_name !== "string") throw new Error(`Grid column "${candidate.name}" requires a class string.`);
		if (typeof candidate.filter !== "boolean") throw new Error(`Grid column "${candidate.name}" requires a boolean filter value.`);
		if (names.has(candidate.name)) throw new Error(`Duplicate grid column definition: ${candidate.name}.`);
		names.add(candidate.name);
		definitions.push({
			name: candidate.name,
			width: candidate.width,
			class_name: candidate.class_name,
			filter: candidate.filter,
			readonly: candidate.readonly === true,
		});
	}
	return definitions;
}

// ---------------------------------------------------------------------------
// Namespace resolution for sync-translations - accepts either a route path
// (e.g. "apps/main/system/users") or a dotted namespace (e.g. "system.users"),
// matching sync_translations.ts's original dir_to_namespace().
// ---------------------------------------------------------------------------

export function resolve_sync_namespace(arg: string): string {
	const routes_root = join(process.cwd(), MAIN_APP);
	const full_path = join(process.cwd(), arg);
	const rel = relative(routes_root, full_path).replaceAll("\\", "/");
	if (rel === "." || rel === "" || rel.startsWith("..")) { return arg; }
	return rel.split("/").join(".");
}

/**
 * Load the DDL cache for a generator subcommand, always re-introspecting first.
 *
 * Schema changes are normally made outside reeman (direct mysql/sqlite3 calls,
 * migration tools), and those leave the on-disk cache valid for its 24h TTL.
 * Reading it would generate against a schema that no longer exists, so the CLI
 * refreshes unconditionally - same as the interactive menu's startup
 * (reeman/index.ts). Introspection is one pass over the DB, paid once per command.
 */
export async function load_fresh_ddl_cache(): Promise<void> {
	const { invalidate_cache, load_ddl_cache } = await import("../ddl_cache");
	invalidate_cache();
	await load_ddl_cache({ force_refresh: true });
}

export async function run_all_tables(flags: ReturnType<typeof parse_crud_flags>): Promise<boolean> {
	const { get_available_tables } = await import("./db");
	const tables = await get_available_tables();
	let success = true;
	for (const table of tables) {
		const ok = await run_full_pipeline(table, {
			prefix: flags.prefix,
			force: flags.force,
			translate: false,
			pagination_method: flags.pagination_method,
			render_strategy: flags.render_strategy,
			template_tags: flags.template_tags,
		});
		if (!ok) success = false;
	}
	// Translate all namespaces at the end - avoids AI translation blocking
	// subsequent tables when generating many tables at once.
	if (flags.translate) {
		await sync_all_namespaces();
		const { notify_server_reload } = await import("$lib/server_notify");
		await notify_server_reload();
	}
	return success;
}
