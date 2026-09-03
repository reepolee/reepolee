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

import { ARCHIVE_TIMESTAMP_FIELD } from "$config/db_structure";
import { db_cli } from "$config/db_cli";
import { normalize_prefix } from "$lib/route";
import { notify_server_reload } from "$lib/server_notify";

import { inject_scopes_translations } from "../schema";
import { sync_single_namespace } from "../translate_namespace";
import { entry_fields } from "../validation_generator";
import { seed_archive_scopes } from "./archive_scopes";
import { create_safe_writer, ensure_dir, format_dirs, format_file } from "./file_writer";
import { generate_form_ree } from "./form_ree";
import { determine_search_field, field_interface_prop, has_archive_column, log_step, preserve_marker_section, route_dir_to_namespace } from "./helpers";
import { archive_row_restore, generate_index_ree } from "./index_ree";
import { generate_index_ts } from "./index_ts";
import { integrate_nested_child } from "./nested_integration";
import { refresh_fields } from "./refresh_fields";
import { stamp_generated_ree_hashes } from "./ree_hash";
import { update_routes_ts } from "./route_registrar";
import { load_table_schema } from "./schema_reader";
import type { TableMeta } from "./schema_reader";
import { get_view_dependencies } from "./sql_introspector";
import { generate_sql_ts } from "./sql_ts";
import { apply_template } from "./template_substitutor";
import { select_templates } from "./template_selector";
import { sync_crud_translations, sync_nav_prefix_title, sync_nav_translations, sync_validation_translations } from "./translation_sync";
import { MAIN_APP, MAIN_APP_POSIX } from "$config/paths";

// ---------------------------------------------------------------------------
// Exported API - callable from other modules
// ---------------------------------------------------------------------------

export interface CrudOptions {
	force?: boolean;
	/** Allow an overwrite prompt to block on stdin (CLI only). Web/MCP callers pass false. */
	interactive?: boolean;
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
			column_names: meta.column_names,
			foreign_keys: meta.foreign_keys,
			route_prefix,
			route_param_value: meta.route_param_value,
			is_nested: meta.is_nested,
			parent_info: meta.parent_info,
			route_name: meta.route_name,
			localization_enabled: meta.localization_enabled,
			localized_fields: meta.localized_fields,
			template_tags: meta.template_tags,
			form_hints: meta.form_hints,
			form_details: meta.form_details,
			readonly_fields: readonly_field_names(meta.columns),
		}));

		log_step(`Generating index.ree for ${table_name}`);
		const { index_html, rows_html } = await generate_index_ree({
			table_name,
			singular: meta.singular,
			fields: meta.fields,
			v_fields: meta.v_fields,
			column_names: meta.column_names,
			columns_override: meta.columns,
			route_prefix,
			route_param_value: meta.route_param_value,
			pagination_strategy: meta.pagination_strategy,
			render_strategy: meta.render_strategy,
			route_name: meta.route_name,
		});
		const index_ree_path = join(meta.route_dir, "index.ree");
		let final_index_html = index_html;
		if (await Bun.file(index_ree_path).exists()) {
			const existing = await Bun.file(index_ree_path).text();
			final_index_html = preserve_marker_section(index_html, existing, "CUSTOM:ROW_PREFIX");
		}
		await safe_writer(index_ree_path, final_index_html);

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
				// The streamed rows partial carries the same per-row restore
				// button as index.ree - the dialog it opens lives in the shell.
				"archive.row_restore": archive_row_restore(has_archive_column(meta.column_names), meta.route_param_value),
			});
			const rows_path = join(meta.route_dir, "index_rows.ree");
			let final_rows_content = rows_content;
			if (await Bun.file(rows_path).exists()) {
				const existing_rows = await Bun.file(rows_path).text();
				final_rows_content = preserve_marker_section(rows_content, existing_rows, "CUSTOM:ROW_PREFIX");
			}
			await safe_writer(rows_path, final_rows_content);
		}
	}

	log_step(`Generating index.ts for ${table_name}`);
	await safe_writer(join(meta.route_dir, "index.ts"), await generate_index_ts({
		localization_enabled: meta.localization_enabled,
		localized_fields: meta.localized_fields,
		readonly_fields: readonly_field_names(meta.columns),
		table_name,
		fields: meta.fields,
		column_names: meta.column_names,
		view_column_names: meta.view_column_names,
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
		readonly_fields: readonly_field_names(meta.columns),
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

/** Columns whose config.ts `columns` entry carries `readonly: true`. */
function readonly_field_names(columns: Record<string, { readonly?: boolean; }> | null): Set<string> {
	const names = new Set<string>();
	for (const [name, column] of Object.entries(columns ?? {})) {
		if (column?.readonly === true) names.add(name);
	}
	return names;
}

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

		const safe_write = create_safe_writer(force, options.interactive);

		// --- Refresh fields only (no full regeneration) ---
		if (refresh_fields_flag) {
			return await refresh_fields({
				table_name,
				route_dir: meta.route_dir,
				relative_dir: meta.relative_dir,
				fields: meta.fields,
				v_fields: meta.v_fields,
				columns: meta.columns,
				column_names: meta.column_names,
				foreign_keys: meta.foreign_keys,
				route_prefix,
				is_nested: meta.is_nested,
				parent_info: meta.parent_info,
				translate_in_args,
				template_tags: meta.template_tags,
				localized_fields: meta.localized_fields,
				form_details: meta.form_details,
			});
		}

		// Phase 2: Generate files
		ensure_dir(meta.route_dir);
		await generate_crud_files(meta, safe_write);

		// Phase 2b: Seed the declared global scope rows. Always for archivable
		// top-level routes - the declaration in config.ts is the source of
		// truth, and existing rows are never overwritten, so an admin's edits
		// survive regeneration. Nested child grids never call search_records,
		// so a scope row there would reach nothing.
		if (!meta.is_nested && has_archive_column(meta.column_names) && meta.global_scopes.length > 0) {
			await seed_archive_scopes(
				{
					table_name,
					feature_name: meta.route_name || table_name,
					module_code: clean_prefix,
				},
				meta.global_scopes
			);
			// Inject scopes.<key> translations right after seeding so the first
			// run is complete - the schema-stage injection only sees rows that
			// already existed.
			await inject_scopes_translations(db_cli, meta.route_dir, table_name);
		}

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
		const routes_path = join(process.cwd(), MAIN_APP, "routes.ts");

		// Phase 4: Sync translations to DB
		await sync_nav_translations(table_name, clean_prefix, meta.is_nested, meta.route_name);
		await sync_nav_prefix_title(clean_prefix, meta.is_nested);
		if (!meta.is_nested && clean_prefix) { meta.changed_dirs.add(`${MAIN_APP_POSIX}/${clean_prefix}`); }
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
				column_names: meta.column_names,
				columns: meta.columns,
				foreign_keys: meta.foreign_keys,
				route_prefix,
				route_dir: meta.route_dir,
				localized_fields: meta.localized_fields,
			});

			const parent_routes_rel = meta.parent_dir.replace(`${join(process.cwd())}/`, "");
			meta.changed_dirs.add(parent_routes_rel);
		}

		// Phase 6: Format generated files
		log_step(`Formatting generated files for ${table_name}`);
		await format_dirs(meta.changed_dirs);
		await stamp_generated_ree_hashes(meta.route_dir);
		if (meta.is_nested && meta.parent_dir) await stamp_generated_ree_hashes(meta.parent_dir);

		// Phase 7: Create every configured locale file from the completed
		// default-locale structure. AI translation is an optional second mode of
		// this same sync, selected by the Translate with AI checkbox.
		const namespaces_to_sync = new Set<string>([route_dir_to_namespace(meta.route_dir)]);
		if (!meta.is_nested && clean_prefix) { namespaces_to_sync.add(clean_prefix); }

		const sync_mode = translate_in_args ? "with AI" : "structure only";
		log_step(`Syncing translations (${sync_mode}) for namespace(s): ${[...namespaces_to_sync].join(", ")}...`);
		try {
			for (const namespace of namespaces_to_sync) {
				await sync_single_namespace(namespace, translate_in_args);
			}
		} catch (err) {
			console.error("Error syncing translations:", err instanceof Error ? err.message : err);
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
			const { format_sync_actions, run_locale_table_sync } = await import("../locale_tables/run");
			const { results } = await run_locale_table_sync({ table: table_name });
			const result = results.find((entry) => entry.base_table === table_name);
			if (!result) throw new Error(`Locale table sync did not process localized table "${table_name}"`);
			for (const description of format_sync_actions(result.actions)) console.log(`  ${description}`);
		}

		// Reload the main app's in-memory translations (locales) alongside the
		// template/route reload below. The restart stamp only re-reads files from
		// disk under `bun --hot` (dev); when AI translation is deferred to the
		// queue worker the locale files land after that restart, and the worker
		// calls this same endpoint again once it finishes - but this generator
		// must target the main app explicitly across the two-app split.
		await notify_server_reload(false, Bun.env.MAIN_APP_URL);
		await notify_server_reload(true, Bun.env.MAIN_APP_URL);
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

	// A view is archive-aware only if it selects `archived_at` through from its
	// base table. Views that omit the column simply generate as before.
	const view_has_archive = has_archive_column(meta.view_column_names);
	const view_archive_helper = view_has_archive ? `
export type ArchiveFilter = "live" | "archived" | "all";

/** WHERE fragment selecting archive state. Empty string means no restriction. */
function archive_clause(archive_filter: ArchiveFilter): string {
\tif (archive_filter === "all") return "";
\tif (archive_filter === "archived") return "${ARCHIVE_TIMESTAMP_FIELD} IS NOT NULL";
\treturn "${ARCHIVE_TIMESTAMP_FIELD} IS NULL";
}
` : "";
	const view_archive_param = view_has_archive ? ", archive_filter: ArchiveFilter = \"live\"" : "";
	const view_archive_arg = view_has_archive ? ", archive_filter" : "";
	const view_archive_cache_key = view_has_archive ? ", archive_filter" : "";
	const view_archive_push = view_has_archive ? `const archive_where = archive_clause(archive_filter);
\t\t\t\t\tif (archive_where) {
\t\t\t\t\t\twhere_clauses.push(archive_where);
\t\t\t\t\t}
` : "";
	const view_archive_count_push = view_has_archive ? `const count_archive_where = archive_clause(archive_filter);
\t\t\t\t\t\tif (count_archive_where) {
\t\t\t\t\t\t\tcount_where_clauses.push(count_archive_where);
\t\t\t\t\t\t}
` : "";
	const view_archive_search_push = view_has_archive ? `const search_archive_clause = archive_clause(archive_filter);
\t\t\t\t\t\tif (search_archive_clause) {
\t\t\t\t\t\t\tsearch_where.push(search_archive_clause);
\t\t\t\t\t\t}
` : "";
	const view_count_archive_setup = view_has_archive
		? `\t\tconst search_archive_where = archive_clause(archive_filter);\n\t\tconst search_archive_and = search_archive_where ? \` AND \${search_archive_where}\` : "";\n`
		: "";
	const view_count_archive_and = view_has_archive ? "${search_archive_and}" : "";

	const view_search_block = is_view_search_text ? `if (search) {\n\t\tconst search_term = search;\n\t\twhere_clauses.push(get_fulltext_clause());\n\t\tparams.push(get_fulltext_param(search_term));\n\t}` : `if (search) {\n\t\tconst search_term = '%' + search + '%';\n\t\twhere_clauses.push('${view_search} LIKE ?');\n\t\tparams.push(search_term);\n\t}`;

	const view_search_count_block = is_view_search_text ? `if (search) {\n\t\tconst count_params: any[] = [get_fulltext_param(search)];\n${view_count_archive_setup}\t\tconst count_query = \`SELECT COUNT(*) as count FROM \${view_source} WHERE \${get_fulltext_clause()}${view_count_archive_and}\`;\n\t\tconst count_result = await db.unsafe(count_query, count_params);\n\t\ttotal = (count_result[0] as any)?.count || 0;\n\t}` : `if (search) {\n\t\tconst count_params: any[] = ['%' + search + '%'];\n${view_count_archive_setup}\t\tconst count_query = \`SELECT COUNT(*) as count FROM \${view_source} WHERE ${view_search} LIKE ?${view_count_archive_and}\`;\n\t\tconst count_result = await db.unsafe(count_query, count_params);\n\t\ttotal = (count_result[0] as any)?.count || 0;\n\t}`;

	const view_interface = ["\tid: number;", ...(meta.v_fields ?? []).map((f) => field_interface_prop(f))].join("\n");

	const view_deps = await get_view_dependencies(table_name);
	const view_deps_json = JSON.stringify(view_deps);
	const view_route_path = meta.route_prefix ? `/${meta.route_prefix}/${meta.route_name || table_name}` : `/${meta.route_name || table_name}`;

	// The base view defines record existence and shared state. A locale view is
	// joined only to overlay the columns explicitly marked localized.
	const view_localized = !!meta.localization_enabled && !meta.is_nested;
	const view_locale_param = view_localized ? ", locale_code: string = \"\"" : "";
	const view_locale_arg = view_localized ? ", locale_code" : "";
	const view_locale_cache_key = view_localized ? ", locale_code" : "";
	const view_locale_where = "";
	const view_locale_filter_param = "";
	const view_locale_search_where = "";
	const view_locale_search_param = "";
	const view_columns = [...new Set(meta.view_column_names.length > 0 ? meta.view_column_names : ["id", ...(meta.v_fields ?? []).map((field) => field.name)])];
	const view_localized_column_names = new Set(meta.localized_fields.map((field) => field.field_name));
	const view_select_list = view_columns.map((column_name) => {
		const source = view_localized_column_names.has(column_name) ? `COALESCE(localized.${column_name}, canonical.${column_name})` : `canonical.${column_name}`;
		return `${source} AS ${column_name}`;
	}).join(", ");
	const view_source = view_localized ? "resolve_view(locale_code)" : `"v_${table_name}"`;
	const view_resolver = view_localized
		? `import { all_locale_tables, locale_table } from "$lib/locale_tables";\n\n/** Base view rows are authoritative; the locale view supplies translated columns only. */\nfunction resolve_view(locale_code: string): string {\n\tconst localized_view = locale_table("v_${table_name}", locale_code);\n\tif (localized_view === "v_${table_name}") return "v_${table_name}";\n\treturn \`(SELECT ${view_select_list} FROM v_${table_name} AS canonical LEFT JOIN \${localized_view} AS localized ON localized.id = canonical.id) AS localized_records\`;\n}\n`
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
		"sql.archive_helper": view_archive_helper,
		"sql.archive_param": view_archive_param,
		"sql.archive_arg": view_archive_arg,
		"sql.archive_cache_key": view_archive_cache_key,
		"sql.archive_push": view_archive_push,
		"sql.archive_count_push": view_archive_count_push,
		"sql.archive_search_push": view_archive_search_push,
	});

	await safe_write(`${meta.route_dir}/sql_view.ts`, view_content);
	log_step(`sql_view.ts written`);
}
