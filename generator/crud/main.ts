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

import { normalize_prefix } from "$lib/route";
import { notify_server_reload } from "$lib/server_notify";

import { sync_single_namespace } from "../translate_namespace";
import { entry_fields } from "../validation_generator";
import { create_safe_writer, ensure_dir, format_dirs, format_file } from "./file_writer";
import { generate_form_ree } from "./form_ree";
import { determine_search_field, field_interface_prop, log_step, route_dir_to_namespace } from "./helpers";
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
	template_tags?: "flat" | "tags";
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
			localization_enabled: meta.localization_enabled,
			localized_fields: meta.localized_fields,
			template_tags: meta.template_tags,
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
		localization_enabled: meta.localization_enabled,
		localized_fields: meta.localized_fields,
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
		is_auto_increment_pk: meta.is_auto_increment_pk,
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
		column_names: meta.column_names,
		localization_enabled: meta.localization_enabled,
		localized_fields: meta.localized_fields,
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
			template_tags: options.template_tags,
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
				template_tags: meta.template_tags,
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
			meta.parent_info,
			meta.v_fields
		);
		await sync_validation_translations(
			table_name,
			meta.route_dir,
			meta.fields,
			meta.foreign_keys
		);

		// Phase 5: Parent file integration (for nested CRUD)
		if (meta.is_nested && meta.parent_dir && meta.parent_info) {
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

		// Phase 9: Sync this table's locale clones. A table that just gained (or
		// lost) a `localized: true` column needs its clone tables created,
		// altered, or dropped to match - idempotent, so a non-localized table
		// costs one no-op call.
		if (meta.localization_enabled) {
			log_step(`Syncing locale tables for ${table_name}`);
			try {
				const { format_sync_actions, run_locale_table_sync } = await import("../locale_tables/run");
				const { results } = await run_locale_table_sync({ table: table_name });
				for (const result of results) {
					for (const description of format_sync_actions(result.actions)) console.log(`  ${description}`);
				}
			} catch (error) {
				console.error("Error syncing locale tables:", error instanceof Error ? error.message : error);
			}
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
	const view_search = determine_search_field(meta.v_fields ?? []);
	const is_view_search_text = view_search === "search_text";

	const view_search_block = is_view_search_text ? `if (search) {\n\t\tconst search_term = search;\n\t\twhere_clauses.push(get_fulltext_clause());\n\t\tparams.push(get_fulltext_param(search_term));\n\t}` : `if (search) {\n\t\tconst search_term = '%' + search + '%';\n\t\twhere_clauses.push('${view_search} LIKE ?');\n\t\tparams.push(search_term);\n\t}`;

	const view_search_count_block = is_view_search_text ? `if (search) {\n\t\tconst count_params: any[] = [get_fulltext_param(search)];\n\t\tconst count_query = \`SELECT COUNT(*) as count FROM v_${table_name} WHERE \${get_fulltext_clause()}\`;\n\t\tconst count_result = await db.unsafe(count_query, count_params);\n\t\ttotal = (count_result[0] as any)?.count || 0;\n\t}` : `if (search) {\n\t\tconst count_params: any[] = ['%' + search + '%'];\n\t\tconst count_query = \`SELECT COUNT(*) as count FROM v_${table_name} WHERE ${view_search} LIKE ?\`;\n\t\tconst count_result = await db.unsafe(count_query, count_params);\n\t\ttotal = (count_result[0] as any)?.count || 0;\n\t}`;

	const view_interface = ["\tid: number;", ...(meta.v_fields ?? []).map((f) => field_interface_prop(f))].join("\n");

	const view_deps = await get_view_dependencies(table_name);
	const view_deps_json = JSON.stringify(view_deps);
	const view_route_path = meta.route_prefix ? `/${meta.route_prefix}/${meta.route_name || table_name}` : `/${meta.route_name || table_name}`;

	// A localized table's view is resolved per locale (v_frameworks vs
	// v_frameworks_sl_si), the same way the base table is - no locale column,
	// no CROSS JOIN, no locale predicate threaded into the SQL.
	const view_localized = !!meta.localization_enabled && !meta.is_nested;
	const view_locale_param = view_localized ? ", locale_code: string = \"\"" : "";
	const view_locale_arg = view_localized ? ", locale_code" : "";
	const view_locale_cache_key = view_localized ? ", locale_code" : "";
	const view_locale_where = "";
	const view_locale_filter_param = "";
	const view_locale_search_where = "";
	const view_locale_search_param = "";
	const view_source = view_localized ? "resolve_view(locale_code)" : `"v_${table_name}"`;
	const view_resolver = view_localized
		? `import { all_locale_tables, locale_table } from "$lib/locale_tables";\n\n/** Physical view for this locale - base view for the default locale. */\nfunction resolve_view(locale_code: string): string {\n\treturn locale_table("v_${table_name}", locale_code);\n}\n`
		: "";
	const view_cache_dependencies = view_localized ? `all_locale_tables("${table_name}")` : view_deps_json;
	const view_cache_import = "";

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
		"sql.view_locale_param": view_locale_param,
		"sql.locale_arg": view_locale_arg,
		"sql.view_locale_cache_key": view_locale_cache_key,
		"sql.view_locale_where": view_locale_where,
		"sql.view_locale_filter_param": view_locale_filter_param,
		"sql.view_locale_search_where": view_locale_search_where,
		"sql.view_locale_search_param": view_locale_search_param,
		"view.resolver": `${view_cache_import}${view_resolver}`,
		"view.source": view_source,
		"sql.view_cache_dependencies": view_cache_dependencies,
	});

	await safe_write(`${meta.route_dir}/sql_view.ts`, view_content);
	log_step(`sql_view.ts written`);
}
