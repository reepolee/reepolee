import { join } from "node:path";

import { IGNORE_INDEX_FIELDS } from "$config/db_structure";
import { normalize_prefix } from "$lib/route";
import { db_type } from "$lib/resolve_db_type";
import { spawnSync } from "bun";

import { build_table_column_map, generate_fields_object } from "../schema/field_generator";
import { write_table_generated_file } from "../schema/file_writer";
import { MySQLTypeMapper } from "../schema/mysql/mysql_type_mapper";
import { SQLiteTypeMapper } from "../schema/sqlite/sqlite_type_mapper";
import type { SchemaObject } from "../schema/types";
import { sync_single_namespace } from "../translate_namespace";
import { entry_fields } from "../validation_generator";
import { generate_field_block } from "./form_ree";
import { find_v_field, log_step, replace_between_markers, route_dir_to_namespace, smart_merge_fields } from "./helpers";
import { refresh_child_section_in_parent } from "./nested_integration";
import { render_field_cell } from "./render_field_cell";
import { stamp_generated_ree_hashes } from "./ree_hash";
import type { ColumnDef, FieldDef, ForeignKeyMap, LocalizedFieldMeta, ParentInfo } from "./types";
import { MAIN_APP } from "$config/paths";

// ---------------------------------------------------------------------------
// Config interface
// ---------------------------------------------------------------------------

export interface RefreshFieldsConfig {
	table_name: string;
	route_dir: string;
	relative_dir: string;
	fields: FieldDef[];
	v_fields: FieldDef[] | null;
	columns: Record<string, ColumnDef> | null;
	foreign_keys: ForeignKeyMap;
	route_prefix: string;
	is_nested: boolean;
	parent_info: ParentInfo | undefined;
	translate_in_args: boolean;
	template_tags: "flat" | "tags";
	localized_fields: LocalizedFieldMeta[];
}

// ---------------------------------------------------------------------------
// Refresh fields only (no full regeneration)
// ---------------------------------------------------------------------------

export async function refresh_fields(config: RefreshFieldsConfig): Promise<boolean> {
	const { table_name, route_dir, relative_dir, fields, v_fields, columns, foreign_keys, route_prefix, is_nested, parent_info, translate_in_args, template_tags, localized_fields } = config;
	log_step(`Refreshing fields only for ${table_name}`);

	// Load schema from DB structure cache instead of re-introspecting
	log_step(`Loading database schema from cache for ${table_name}`);
	let refreshed_v_fields = v_fields;
	try {
		const { load_ddl_cache, ddl_cache_to_schema_objects } = await import("../ddl_cache");
		const cache = await load_ddl_cache();
		const { all_schemas, all_indexes } = ddl_cache_to_schema_objects(cache);
		const type_mapper = db_type === "mysql" ? new MySQLTypeMapper() : new SQLiteTypeMapper();
		const table_column_map = build_table_column_map(all_schemas);

		const schema_obj = all_schemas.find((s: SchemaObject) => s.name === table_name);
		if (schema_obj) {
			log_step(`Regenerating schema.generated.ts for ${table_name}`);
			await write_table_generated_file(
				route_dir,
				schema_obj,
				type_mapper,
				table_column_map,
				all_indexes
			);

			if (schema_obj.view_columns && schema_obj.view_columns.length > 0) {
				const fresh_v_fields_obj = generate_fields_object({
					type: "view",
					name: schema_obj.name,
					columns: schema_obj.view_columns,
					foreign_keys: [],
					has_view: false,
				}, type_mapper, table_column_map, all_indexes);
				const fresh_fields = Object.values(fresh_v_fields_obj);
				if (fresh_fields.length > 0) {
					log_step(`Fresh v_fields loaded: ${Object.keys(fresh_v_fields_obj).join(", ")}`);
					refreshed_v_fields = fresh_fields;
				}
			}
		} else {
			log_step(`Schema object not found for ${table_name} - skipping re-introspection`);
		}
	} catch (error) {
		log_step(`Schema re-introspection failed for ${table_name}: ${error instanceof Error ? error.message : error} - proceeding with cached schema`);
	}

	if (!is_nested) {
		await refresh_form_ree(
			table_name,
			route_dir,
			fields,
			columns,
			foreign_keys,
			route_prefix,
			is_nested,
			parent_info,
			template_tags,
			localized_fields
		);
		await refresh_index_ree(table_name, route_dir, fields, refreshed_v_fields, columns);
	}

	log_step(`Formatting refreshed files for ${table_name}`);
	console.log(`  Running: reettier ${relative_dir}`);
	try {
		const reettier_result = spawnSync({
			cmd: ["reettier", relative_dir],
			stdio: ["inherit", "inherit", "inherit"],
		});
		if (reettier_result.exitCode !== 0) { console.error("reettier exited with code", reettier_result.exitCode); }
	} catch (err) {
		console.error("Error formatting refreshed files:", err instanceof Error ? err.message : err);
	}
	await stamp_generated_ree_hashes(route_dir);

	if (translate_in_args) {
		const namespace = route_dir_to_namespace(route_dir);
		log_step(`Syncing translations for namespace "${namespace}"...`);
		try {
			await sync_single_namespace(namespace, true);
		} catch (err) {
			console.error("Error syncing translations:", err instanceof Error ? err.message : err);
		}
	}

	// Refresh child section in parent form.ree if nested
	if (is_nested && parent_info) {
		const parent_dir = join(process.cwd(), MAIN_APP, parent_info.table);
		const exists_root = await Bun.file(join(parent_dir, "index.ts")).exists();
		let resolved_parent_dir = parent_dir;
		if (!exists_root) {
			const clean_prefix = normalize_prefix(route_prefix).clean;
			if (clean_prefix) {
				const prefixed = join(process.cwd(), MAIN_APP, clean_prefix, parent_info.table);
				if (await Bun.file(join(prefixed, "index.ts")).exists()) { resolved_parent_dir = prefixed; }
			}
		}

		await refresh_child_section_in_parent(
			table_name,
			parent_info,
			resolved_parent_dir,
			fields,
			refreshed_v_fields,
			columns,
			foreign_keys,
			route_prefix,
			route_dir
		);

		if (translate_in_args) {
			const namespace = route_dir_to_namespace(route_dir);
			log_step(`Syncing translations for namespace "${namespace}"...`);
			try {
				await sync_single_namespace(namespace, true);
			} catch (err) {
				console.error("Error syncing translations:", err instanceof Error ? err.message : err);
			}
		}

		const parent_routes_rel = resolved_parent_dir.replace(`${join(process.cwd())}/`, "");
		log_step(`Formatting parent directory: ${parent_routes_rel}`);
		try {
			const reettier_result = spawnSync({
				cmd: ["reettier", parent_routes_rel],
				stdio: ["inherit", "inherit", "inherit"],
			});
			if (reettier_result.exitCode !== 0) { console.error("reettier exited with code", reettier_result.exitCode); }
		} catch (err) {
			console.error("Error formatting parent directory:", err instanceof Error ? err.message : err);
		}
		await stamp_generated_ree_hashes(resolved_parent_dir);
	}

	log_step(`Field refresh finished for ${table_name}`);
	return true;
}

// ---------------------------------------------------------------------------
// Refresh form.ree fields
// ---------------------------------------------------------------------------

async function refresh_form_ree(
	table_name: string,
	route_dir: string,
	fields: FieldDef[],
	columns: Record<string, ColumnDef> | null,
	foreign_keys: ForeignKeyMap,
	route_prefix: string,
	is_nested: boolean,
	parent_info: ParentInfo | undefined,
	template_tags: "flat" | "tags",
	localized_fields: LocalizedFieldMeta[],
): Promise<void> {
	const form_path = join(route_dir, "form.ree");
	const form_exists = await Bun.file(form_path).exists();

	if (!form_exists) {
		const index_path = join(route_dir, "index.ree");
		const index_exists = await Bun.file(index_path).exists();
		if (!index_exists) { throw new Error(`No form.ree or index.ree found at ${route_dir}. Run with --force first to generate.`); }
		return;
	}

	log_step(`Refreshing form.ree fields`);
	let form_content = await Bun.file(form_path).text();

	const old_section_match = form_content.match(/<!-- GEN:FIELDS:START -->([\s\S]*?)<!-- GEN:FIELDS:END -->/);
	if (!old_section_match) { throw new Error("Markers not found in form.ree. Run with --force first to initialize."); }
	const old_section = old_section_match[1]!;

	const localized_names = new Set(localized_fields.map((field) => field.field_name));
	const readonly_names = new Set<string>();
	for (const [name, column] of Object.entries(columns ?? {})) {
		if (column?.readonly === true) readonly_names.add(name);
	}
	const filtered = entry_fields(fields, false);
	const input_fields_promises = filtered.map((f) => generate_field_block(
		f,
		foreign_keys,
		table_name,
		route_prefix,
		is_nested,
		parent_info ?? null,
		template_tags,
		localized_names,
		readonly_names
	));
	const new_field_blocks = await Promise.all(input_fields_promises);

	const merged = smart_merge_fields(old_section, new_field_blocks, template_tags);
	form_content = replace_between_markers(form_content, "FIELDS", merged.trim());

	await Bun.write(form_path, form_content);
	console.log("✓ Refreshed form.ree fields (smart merge)");
}

// ---------------------------------------------------------------------------
// Refresh index.ree fields
// ---------------------------------------------------------------------------

async function refresh_index_ree(
	table_name: string,
	route_dir: string,
	fields: FieldDef[],
	v_fields: FieldDef[] | null,
	columns: Record<string, ColumnDef> | null,
): Promise<void> {
	const index_path = join(route_dir, "index.ree");
	const index_exists = await Bun.file(index_path).exists();
	if (!index_exists) return;

	log_step(`Refreshing index.ree fields`);
	let index_content = await Bun.file(index_path).text();

	const display_fields = v_fields || fields;
	let index_filtered: FieldDef[];
	let commented_index_fields: FieldDef[] = [];

	// The column-configured template helper (from the config.ts columns map), if any.
	const helper_for = (name: string): string => (columns?.[name]?.helper ? String(columns[name]!.helper) : "");

	if (columns) {
		const col_keys = Object.keys(columns);
		const field_keys = col_keys.filter((k) => k !== "checkbox" && k !== "id" && columns[k]?.grid !== false);
		index_filtered = field_keys.map((k) => {
			let found = v_fields?.find((f) => f.name === k);
			if (!found) found = fields.find((f) => f.name === k);
			return found;
		}).filter((f): f is FieldDef => !!f);
	} else {
		const all_index_fields = display_fields.filter((f) => !f.attributes?.omit && !(IGNORE_INDEX_FIELDS as readonly string[]).includes(f.name));
		index_filtered = all_index_fields.filter((f) => f.attributes?.omit_index !== true);
		commented_index_fields = all_index_fields.filter((f) => f.attributes?.omit_index === true);
	}

	const id_header = `\t\t\t\t<div>ID</div>`;
	const field_headers = index_filtered.map((f) => {
		// Headers are wrapped with {#with props} in the template -> bare names
		if (find_v_field(f.name, v_fields)) { return `\t\t\t\t<div class="{= columns.${f.name}.class }">{_ v_labels.${f.name} }</div>`; }
		return `\t\t\t\t<div class="{= columns.${f.name}.class }">{_ labels.${f.name} }</div>`;
	}).join("\n");
	let headers = `${id_header}\n${field_headers}`;

	let cells = index_filtered.map((f) => render_field_cell(f, "record", "default", "\t\t\t\t", "columns", helper_for(f.name))).join("\n");

	if (commented_index_fields.length > 0) {
		headers += `\n\t\t\t\t<!-- CU fields - uncomment to show in index -->\n${commented_index_fields.map((f) => {
			const class_attr = ` class="{= columns.${f.name}.class }"`;
			const label = find_v_field(f.name, v_fields) ? `{_ v_labels.${f.name} }` : `{_ labels.${f.name} }`;
			return `\t\t\t\t<!-- <div${class_attr}>${label}</div> -->`;
		}).join("\n")}`;
		cells += `\n\t\t\t\t<!-- CU fields -- uncomment to show in index -->\n${commented_index_fields.map((f) => render_field_cell(f, "record", "default", "\t\t\t\t", "columns", helper_for(f.name))).map((line) => `\t\t\t\t<!-- ${line.trimStart()} -->`).join(
			"\n"
		)}`;
	}

	index_content = replace_between_markers(index_content, "FIELDS:HEADERS", headers);
	index_content = replace_between_markers(index_content, "FIELDS:CELLS", cells);

	// Grid cols are dynamic via props.grid_cols at runtime - no template update needed.

	await Bun.write(index_path, index_content);
	console.log("✓ Refreshed index.ree fields");
}
