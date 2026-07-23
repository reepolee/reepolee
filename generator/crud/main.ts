/**
 * CRUD Generator - Pipeline Orchestrator.
 *
 * Coordinates the CRUD generation pipeline phases:
 * 1. Schema Reader - loads table schema and metadata
 * 2. File Generator - generates form.ree, index.ree, index.ts, sql.ts
 * 3. Route Registrar - updates routes.ts
 * 4. Translation Syncer - syncs nav/crud translations to DB
 * 5. Child Integrator - for nested CRUD, injects into parent
 * 6. Formatter - runs reettier on generated files
 */

import { join } from "node:path";
import { parseArgs } from "node:util";

import { normalize_prefix } from "$lib/route";
import { notify_server_reload } from "$lib/server_notify";

import { sync_single_namespace } from "../translate_namespace";
import { entry_fields } from "../validation_generator";
import { create_safe_writer, ensure_dir, format_dirs, format_file } from "./file_writer";
import { generate_form_ree } from "./form_ree";
import { determine_search_field, log_step, route_dir_to_namespace } from "./helpers";
import { generate_index_ree } from "./index_ree";
import { generate_index_ts } from "./index_ts";
import { integrate_nested_child } from "./nested_integration";
import { refresh_fields } from "./refresh_fields";
import { update_routes_ts } from "./route_registrar";
import { load_table_schema } from "./schema_reader";
import type { TableMeta } from "./schema_reader";
import { get_view_dependencies } from "./sql_introspector";
import { generate_sql_ts } from "./sql_ts";
import { apply_template } from "./template_substitutor";
import { select_templates } from "./template_selector";
import { sync_crud_translations, sync_nav_prefix_title, sync_nav_translations, sync_validation_translations } from "./translation_sync";

// ---------------------------------------------------------------------------
// Exported API - callable from other modules
// ---------------------------------------------------------------------------

export interface CrudOptions {
	force?: boolean;
	refresh_fields?: boolean;
	translate?: boolean;
	prefix?: string;
	parent_table?: string;
	route_name?: string;
	pagination_strategy?: "cursor" | "offset";
	render_strategy?: "stream" | "load";
}

/**
 * Phase 1: Load table schema from the database into CrudMeta.
 * Callable independently for schema inspection or field refresh.
 */
export { load_table_schema } from "./schema_reader";

export { refresh_fields } from "./refresh_fields";

/**
 * Phase 2: Generate all CRUD files for a loaded schema.
 * Callable independently for re-generation without re-loading schema.
 */
export async function generate_crud_files(meta: TableMeta, safe_writer: (path: string, content: string) => Promise<void>): Promise<void> {
	const table_name = meta.table_name;
	const route_prefix = meta.route_prefix;

	if (!meta.is_nested) {
		log_step(`Generating form.ree for ${table_name}`);
		await safe_writer(join(meta.route_dir, "form.ree"), await generate_form_ree({
			table_name,
			fields: meta.fields,
			foreign_keys: meta.foreign_keys,
			route_prefix,
			route_param_value: meta.route_param_value,
			is_nested: meta.is_nested,
			parent_info: meta.parent_info,
			route_name: meta.route_name,
		}));

		log_step(`Generating index.ree for ${table_name}`);
		const { index_html, rows_html } = await generate_index_ree({
			table_name,
			singular: meta.singular,
			fields: meta.fields,
			v_fields: meta.v_fields,
			columns_override: meta.columns,
			route_prefix,
			route_param_value: meta.route_param_value,
			pagination_strategy: meta.pagination_strategy,
			render_strategy: meta.render_strategy,
			route_name: meta.route_name,
		});
		await safe_writer(join(meta.route_dir, "index.ree"), index_html);

		if (rows_html) {
			log_step(`Generating index_rows.ree for ${table_name} (streaming)`);
			const rows_template = await Bun.file(join(
				process.cwd(),
				"generator",
				"templates",
				"index",
				"index_rows.ree"
			)).text();
			const rows_content = apply_template(rows_template, {
				"table.exact": meta.route_name || table_name,
				route_prefix,
				route_param: meta.route_param_value,
				"table.cells": rows_html,
			});
			await safe_writer(join(meta.route_dir, "index_rows.ree"), rows_content);
		}
	}

	log_step(`Generating index.ts for ${table_name}`);
	await safe_writer(join(meta.route_dir, "index.ts"), await generate_index_ts({
		table_name,
		fields: meta.fields,
		sort_options: meta.sort_options,
		view_name: `v_${table_name}`,
		has_view: !!meta.v_fields,
		first_field: meta.first_field,
		foreign_keys: meta.foreign_keys,
		columns: meta.columns,
		route_prefix,
		crud_name: meta.crud_name,
		route_param_value: meta.route_param_value,
		is_nested: meta.is_nested,
		parent_info: meta.parent_info,
		pagination_strategy: meta.pagination_strategy,
		render_strategy: meta.render_strategy,
		route_name: meta.route_name,
	}));

	const tags_fields = entry_fields(meta.fields, false).filter((f) => f.type === "tags" && f.attributes?.tags?.table);
	log_step(`Generating sql.ts for ${table_name} (tags: ${tags_fields.length}, fks: ${meta.foreign_keys.size})`);
	await safe_writer(join(meta.route_dir, "sql.ts"), await generate_sql_ts({
		table_name,
		fields: meta.fields,
		search_field: meta.search_field,
		tags_fields,
		foreign_keys: meta.foreign_keys,
		id_type: meta.id_type,
		id_type_interface: meta.id_type_interface,
		is_auto_increment_pk: meta.is_auto_increment_pk,
		route_param_value: meta.route_param_value,
		is_nested: meta.is_nested,
		parent_info: meta.parent_info,
		route_prefix,
		pagination_strategy: meta.pagination_strategy,
		route_name: meta.route_name,
	}));

	// sql.custom.ts: extension point for custom queries - never regenerated
	const custom_sql_path = join(meta.route_dir, "sql.custom.ts");
	if (!(await Bun.file(custom_sql_path).exists())) {
		await Bun.write(
			custom_sql_path,
			`import { db } from "$config/db";\n\n// Add custom queries here. This file is never overwritten by the generator.\n`
		);
		console.log(`✓ Generated ${custom_sql_path}`);
	}

	if (meta.v_fields) { await generate_view_sql(table_name, meta, safe_writer); }
}

/**
 * Phase 3: Update routes.ts for the generated CRUD.
 * Returns deferred routes content (null if no update needed).
 */
export { update_routes_ts } from "./route_registrar";

/**
 * Phase 4: Sync translations for the generated CRUD.
 */
export { sync_crud_translations, sync_nav_prefix_title, sync_nav_translations, sync_validation_translations } from "./translation_sync";

/**
 * Phase 5: Integrate nested child into parent route.
 */
export { integrate_nested_child } from "./nested_integration";

/**
 * Phase 6: Format generated files and optionally sync AI translations.
 */
export { format_dirs, format_file } from "./file_writer";

/**
 * Generate CRUD files for a given database table.
 *
 * Orchestrates the full pipeline:
 * 1. Load schema -> extract metadata
 * 2. Generate files (form.ree, index.ree, index.ts, sql.ts, sql_view.ts)
 * 3. Update routes.ts (deferred until after translation sync)
 * 4. Sync translations to DB
 * 5. Integrate nested child (if applicable)
 * 6. Format generated files
 * 7. Write routes.ts (post-translations)
 * 8. Notify server reload
 */
export async function generate_crud(table_name: string, options: CrudOptions = {}): Promise<boolean> {
	const force = options.force ?? false;
	const refresh_fields_flag = options.refresh_fields ?? false;
	const translate_in_args = options.translate ?? false;
	const raw_prefix = options.prefix ?? "";
	const { clean: clean_prefix, route: route_prefix } = normalize_prefix(raw_prefix);
	const parent_cli_table = options.parent_table ?? "";
	const route_name = options.route_name ?? "";

	try {
		log_step(`Starting CRUD generation for table: ${table_name}, prefix: "${clean_prefix || "(none)"}"`);

		// Phase 1: Load schema
		const meta = await load_table_schema(table_name, {
			clean_prefix,
			route_prefix,
			parent_cli_table,
			route_name,
			pagination_strategy: options.pagination_strategy,
		});

		// Apply option override (CLI / reeman takes precedence over schema file)
		if (options.render_strategy) { meta.render_strategy = options.render_strategy; }

		const safe_write = create_safe_writer(force);

		// --- Refresh fields only (no full regeneration) ---
		if (refresh_fields_flag) {
			return await refresh_fields({
				table_name,
				route_dir: meta.route_dir,
				relative_dir: meta.relative_dir,
				fields: meta.fields,
				v_fields: meta.v_fields,
				columns: meta.columns,
				foreign_keys: meta.foreign_keys,
				route_prefix,
				is_nested: meta.is_nested,
				parent_info: meta.parent_info,
				translate_in_args,
			});
		}

		// Phase 2: Generate files
		ensure_dir(meta.route_dir);
		await generate_crud_files(meta, safe_write);

		// Phase 3: Update routes.ts
		const route_result = await update_routes_ts({
			table_name,
			crud_name: meta.crud_name,
			clean_prefix,
			route_prefix,
			parent_cli_table,
			is_nested: meta.is_nested,
			route_name: meta.route_name,
		});
		const deferred_routes_content = route_result.routes_content;
		const routes_path = join(process.cwd(), "routes", "routes.ts");

		// Phase 4: Sync translations to DB
		await sync_nav_translations(table_name, clean_prefix, meta.is_nested, meta.route_name);
		await sync_nav_prefix_title(clean_prefix, meta.is_nested);
		if (!meta.is_nested && clean_prefix) { meta.changed_dirs.add(`routes/${clean_prefix}`); }
		await sync_crud_translations(
			table_name,
			meta.route_dir,
			meta.fields,
			meta.is_nested,
			meta.parent_info
		);
		await sync_validation_translations(
			table_name,
			meta.route_dir,
			meta.fields,
			meta.foreign_keys
		);

		// Phase 5: Parent file integration (for nested CRUD)
		if (meta.is_nested && meta.parent_dir) {
			await integrate_nested_child({
				table_name,
				parent_info: meta.parent_info,
				parent_dir: meta.parent_dir,
				fields: meta.fields,
				v_fields: meta.v_fields,
				columns: meta.columns,
				foreign_keys: meta.foreign_keys,
				route_prefix,
				route_dir: meta.route_dir,
			});

			const parent_routes_rel = meta.parent_dir.replace(`${join(process.cwd())}/`, "");
			meta.changed_dirs.add(parent_routes_rel);
		}

		// Phase 6: Format generated files
		log_step(`Formatting generated files for ${table_name}`);
		await format_dirs(meta.changed_dirs);

		// Phase 7: Sync translations (AI translate) - scoped to the namespace(s) this CRUD touched
		if (translate_in_args) {
			const namespaces_to_sync = new Set<string>([route_dir_to_namespace(meta.route_dir)]);
			if (!meta.is_nested && clean_prefix) { namespaces_to_sync.add(clean_prefix); }

			log_step(`Syncing translations for namespace(s): ${[...namespaces_to_sync].join(", ")}...`);
			try {
				for (const namespace of namespaces_to_sync) {
					await sync_single_namespace(namespace, true);
				}
			} catch (err) {
				console.error("Error syncing translations:", err instanceof Error ? err.message : err);
			}
		}

		// Phase 8: Write routes.ts - deferred to AFTER translations
		if (deferred_routes_content) {
			log_step(`Writing routes.ts after translation sync`);
			await Bun.write(routes_path, deferred_routes_content);
			console.log(`✓ Updated routes.ts`);
			await format_file(routes_path);
		}

		await notify_server_reload();
		log_step(`CRUD generation finished for ${table_name}`);
		return true;
	} catch (error) {
		console.error("Error:", error instanceof Error ? error.message : error);
		log_step(`CRUD generation FAILED for ${table_name}`);
		return false;
	}
}

/**
 * Generate the sql_view.ts file for tables with a view.
 */
async function generate_view_sql(table_name: string, meta: TableMeta, safe_write: (path: string, content: string) => Promise<void>): Promise<void> {
	log_step(`Generating sql_view.ts for v_${table_name}`);
	const view_search = determine_search_field(meta.v_fields);
	const is_view_search_text = view_search === "search_text";

	const view_search_block = is_view_search_text ? `if (search) {\n\t\tconst search_term = search;\n\t\twhere_clauses.push(get_fulltext_clause());\n\t\tparams.push(get_fulltext_param(search_term));\n\t}` : `if (search) {\n\t\tconst search_term = '%' + search + '%';\n\t\twhere_clauses.push('${view_search} LIKE ?');\n\t\tparams.push(search_term);\n\t}`;

	const view_search_count_block = is_view_search_text ? `if (search) {\n\t\tconst count_params: any[] = [get_fulltext_param(search)];\n\t\tconst count_query = \`SELECT COUNT(*) as count FROM v_${table_name} WHERE \${get_fulltext_clause()}\`;\n\t\tconst count_result = await db.unsafe(count_query, count_params);\n\t\ttotal = (count_result[0] as any)?.count || 0;\n\t}` : `if (search) {\n\t\tconst count_params: any[] = ['%' + search + '%'];\n\t\tconst count_query = \`SELECT COUNT(*) as count FROM v_${table_name} WHERE ${view_search} LIKE ?\`;\n\t\tconst count_result = await db.unsafe(count_query, count_params);\n\t\ttotal = (count_result[0] as any)?.count || 0;\n\t}`;

	const view_interface = ["\tid: number;", ...(meta.v_fields ?? []).map((f) => `\t${f.name}: ${f.type === "number" ? "number" : "string"};`)].join("\n");

	const view_deps = await get_view_dependencies(table_name);
	const view_deps_json = JSON.stringify(view_deps);
	const view_route_path = meta.route_prefix ? `/${meta.route_prefix}/${meta.route_name || table_name}` : `/${meta.route_name || table_name}`;

	const { sql_view: pagination_mode } = select_templates({
		pagination_strategy: meta.pagination_strategy,
		render_strategy: meta.render_strategy,
		is_nested: meta.is_nested,
		has_view: true,
	});
	const view_template_path = join(process.cwd(), "generator", "templates", pagination_mode);
	const view_content = apply_template(await Bun.file(view_template_path).text(), {
		"view.name": `v_${table_name}`,
		"search.field": view_search,
		"search.block": view_search_block,
		"search.count_block": view_search_count_block,
		"interface.fields": view_interface,
		"table.exact": table_name,
		"sql.view_dependencies": view_deps_json,
		"sql.route": view_route_path,
	});

	await safe_write(`${meta.route_dir}/sql_view.ts`, view_content);
	log_step(`sql_view.ts written`);
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

export async function main() {
	// Load DB structure cache at startup
	const { load_ddl_cache } = await import("../ddl_cache");
	await load_ddl_cache();

	const { values, positionals } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			force: { type: "boolean", default: false },
			"refresh-fields": { type: "boolean", default: false },
			translate: { type: "boolean", default: false },
			prefix: { type: "string", default: "" },
			parent: { type: "string", default: "" },
			"route-name": { type: "string", default: "" },
			pagination: { type: "string" },
			"render-strategy": { type: "string" },
		},
		allowPositionals: true,
		strict: false,
	});

	const table_name = positionals[0];
	if (!table_name) {
		console.error("Error: Provide table name");
		console.error(
			"Usage: bun generator/crud.ts <table> [--force] [--prefix <dir>] [--parent <table>] [--refresh-fields] [--translate] [--pagination cursor|offset] [--render-strategy stream|load]"
		);
		process.exit(1);
	}

	const raw_pagination = values.pagination;
	const pagination_strategy: "cursor" | "offset" | undefined = raw_pagination === "cursor" || raw_pagination === "offset" ? raw_pagination : undefined;

	const raw_render = values["render-strategy"];
	const render_strategy: "stream" | "load" | undefined = raw_render === "stream" || raw_render === "load" ? raw_render : undefined;

	const success = await generate_crud(String(table_name), {
		force: Boolean(values.force),
		refresh_fields: Boolean(values["refresh-fields"]),
		translate: Boolean(values.translate),
		prefix: String(values.prefix ?? ""),
		parent_table: String(values.parent ?? ""),
		route_name: String(values["route-name"] ?? ""),
		pagination_strategy,
		render_strategy,
	});

	process.exit(success ? 0 : 1);
}
