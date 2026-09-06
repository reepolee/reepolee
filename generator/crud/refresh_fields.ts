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
import { generate_form_ree } from "./form_ree";
import { find_v_field, log_step, replace_between_markers, route_dir_to_namespace } from "./helpers";
import { integrate_nested_child } from "./nested_integration";
import { render_field_cell } from "./render_field_cell";
import { inspect_form_fields_hash_content, stamp_generated_ree_hashes } from "./ree_hash";
import { sync_crud_translations, sync_validation_translations } from "./translation_sync";
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
	column_names: string[];
	foreign_keys: ForeignKeyMap;
	route_prefix: string;
	is_nested: boolean;
	parent_info: ParentInfo | undefined;
	translate_in_args: boolean;
	template_tags: "flat" | "tags";
	localized_fields: LocalizedFieldMeta[];
	form_hints: boolean;
	form_details: boolean;
}

// ---------------------------------------------------------------------------
// Refresh fields only (no full regeneration)
// ---------------------------------------------------------------------------

export async function refresh_fields(config: RefreshFieldsConfig): Promise<boolean> {
	const { table_name, route_dir, relative_dir, fields, v_fields, columns, column_names, foreign_keys, route_prefix, is_nested, parent_info, translate_in_args, template_tags, localized_fields, form_details } = config;
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
			refreshed_v_fields,
			columns,
			foreign_keys,
			route_prefix,
			is_nested,
			parent_info,
			template_tags,
			localized_fields,
			config.form_hints,
			form_details,
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

		await integrate_nested_child({
			table_name,
			parent_info,
			parent_dir: resolved_parent_dir,
			fields,
			v_fields: refreshed_v_fields,
			column_names,
			columns,
			foreign_keys,
			route_prefix,
			route_dir,
			localized_fields,
		});

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

	// Fields refresh skips the full CRUD pipeline, but its locale sync still
	// rebuilds each target locale from the default-locale tree. Seed that tree
	// first so target-only CRUD translations are not pruned then reintroduced as
	// ::missing:: values on a later full regeneration.
	await sync_crud_translations(table_name, route_dir, fields, is_nested, parent_info, refreshed_v_fields);
	await sync_validation_translations(table_name, route_dir, fields, foreign_keys);

	const namespace = route_dir_to_namespace(route_dir);
	const sync_mode = translate_in_args ? "with AI" : "structure only";
	log_step(`Syncing translations (${sync_mode}) for namespace "${namespace}"...`);
	try {
		await sync_single_namespace(namespace, translate_in_args);
	} catch (err) {
		console.error("Error syncing translations:", err instanceof Error ? err.message : err);
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
	v_fields: FieldDef[] | null,
	columns: Record<string, ColumnDef> | null,
	foreign_keys: ForeignKeyMap,
	route_prefix: string,
	is_nested: boolean,
	parent_info: ParentInfo | undefined,
	template_tags: "flat" | "tags",
	localized_fields: LocalizedFieldMeta[],
	form_hints: boolean,
	form_details: boolean,
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

	const old_section_match = form_content.match(/<!-- GEN:FIELDS:START(?::sha256:[a-f0-9]{64})? -->([\s\S]*?)<!-- GEN:FIELDS:END -->/);
	if (!old_section_match) { throw new Error("Markers not found in form.ree. Run with --force first to initialize."); }
	const old_section = old_section_match[1]!;

	const readonly_names = new Set<string>();
	for (const [name, column] of Object.entries(columns ?? {})) {
		if (column?.readonly === true) readonly_names.add(name);
	}
	const fresh_form = await generate_form_ree({
		table_name,
		fields,
		v_fields,
		foreign_keys,
		route_prefix,
		is_nested,
		parent_info: parent_info ?? null,
		localized_fields,
		template_tags,
		form_hints,
		form_details,
		readonly_fields: readonly_names,
		form_columns: columns,
	});
	const fresh_section = extract_form_fields_section(fresh_form);
	if (fresh_section === null) throw new Error("Generated form.ree is missing field markers.");

	const preserve_manual_fields = inspect_form_fields_hash_content(form_content) === "modified";
	const refreshed_section = preserve_manual_fields
		? form_fields_previous_comment(old_section, fresh_section)
		: fresh_section.trim();
	const form_without_previous_fields = remove_form_fields_previous(form_content);
	form_content = replace_between_markers(form_without_previous_fields, "FIELDS", refreshed_section);
	if (preserve_manual_fields) {
		console.log("⚠ Replaced form fields with the current generator output and commented changed previous fields");
	}
	form_content = sync_details_container(form_content, form_details);

	await Bun.write(form_path, form_content);
	if (!preserve_manual_fields) console.log("✓ Refreshed form.ree fields");
}

const FORM_FIELDS_SECTION = /<!-- GEN:FIELDS:START(?::sha256:[a-f0-9]{64})? -->([\s\S]*?)<!-- GEN:FIELDS:END -->/;
const FORM_FIELD_BLOCK = /<localized-field-tabs\b[^>]*\bfield="([^"]*)"[^>]*>[\s\S]*?<\/localized-field-tabs>|<field-wrapper\b[^>]*\bdata-field="([^"]*)"[^>]*>[\s\S]*?<\/field-wrapper>|<[a-z][\w]*-[\w-]+\b(?=[^>]*(?:\bname|\bfield-name)="[^"]*")[^>]*>[\s\S]*?<\/[a-z][\w]*-[\w-]+>/g;
const FORM_FIELDS_PREVIOUS = /\n*<!-- GEN:FIELDS:PREVIOUS(?::[^\s>]+)?:START -->[\s\S]*?<!-- GEN:FIELDS:PREVIOUS(?::[^\s>]+)?:END -->\n*/g;

function extract_form_fields_section(content: string): string | null {
	const section = content.match(FORM_FIELDS_SECTION);
	return section?.[1] ?? null;
}

function field_name_from_block(block: string): string | undefined {
	return /(?:\bdata-field|\bfield-name|\bfield|\bname)="([^"]*)"/.exec(block)?.[1];
}

function extract_form_field_blocks(section: string): Map<string, string> {
	const field_blocks = new Map<string, string>();
	let match: RegExpExecArray | null;
	while ((match = FORM_FIELD_BLOCK.exec(section)) !== null) {
		const field_name = match[1] ?? match[2] ?? field_name_from_block(match[0]);
		if (field_name) field_blocks.set(field_name, match[0]);
	}
	FORM_FIELD_BLOCK.lastIndex = 0;
	return field_blocks;
}

function remove_form_fields_previous(content: string): string {
	return content.replace(FORM_FIELDS_PREVIOUS, "");
}

function previous_field_comment(field_name: string, previous_block: string, removed: boolean = false): string {
	const label = removed ? `Removed field from the previous rendering: ${field_name}` : `Previous rendering for ${field_name}`;
	const commented_lines = previous_block.trim().split("\n").map((line) => `<!-- ${line.replaceAll("--", "- -")} -->`).join("\n");
	return `\n<!-- GEN:FIELDS:PREVIOUS:${field_name}:START -->\n<!-- ${label} -->\n${commented_lines}\n<!-- GEN:FIELDS:PREVIOUS:${field_name}:END -->`;
}

/**
 * Preserve the previous field layout while replacing every matching field with
 * its fresh rendering. Changed fields retain their prior markup in comments.
 * Fields removed from the schema have no replacement anchor, so they are kept
 * as comments at the end of the generated section.
 */
export function form_fields_previous_comment(current: string, generated: string): string {
	const current_without_previous = remove_form_fields_previous(current);
	const previous_fields = extract_form_field_blocks(current_without_previous);
	const generated_fields = extract_form_field_blocks(generated);
	if (previous_fields.size === 0) return generated.trim();

	const removed_fields: Array<[string, string]> = [];
	for (const [field_name, previous_block] of previous_fields) {
		const generated_block = generated_fields.get(field_name);
		if (!generated_block) {
			removed_fields.push([field_name, previous_block]);
		}
	}

	let preserved_layout = current_without_previous.replace(FORM_FIELD_BLOCK, (previous_block) => {
		const field_name = field_name_from_block(previous_block);
		const generated_block = field_name ? generated_fields.get(field_name) : undefined;
		if (!field_name || !generated_block) return "";
		if (previous_block.trim() === generated_block.trim()) return generated_block;
		return `${generated_block}${previous_field_comment(field_name, previous_block)}`;
	});

	const appended_fields: string[] = [];
	for (const [field_name, generated_block] of generated_fields) {
		if (!previous_fields.has(field_name)) appended_fields.push(generated_block);
	}
	if (appended_fields.length > 0) preserved_layout = `${preserved_layout.trimEnd()}\n\n${appended_fields.join("\n\n")}`;
	if (removed_fields.length === 0) return preserved_layout.trim();

	const removed_comments = removed_fields.map(([field_name, previous_block]) => previous_field_comment(field_name, previous_block, true)).join("\n\n");
	return `${preserved_layout.trim()}\n\n${removed_comments}`;
}

/** Preserve a manually edited field section as comments during full CRUD regeneration. */
export function preserve_previous_form_fields(fresh_form: string, existing_form: string): string {
	if (inspect_form_fields_hash_content(existing_form) !== "modified") return fresh_form;
	const previous_section = extract_form_fields_section(existing_form);
	const fresh_section = extract_form_fields_section(fresh_form);
	if (previous_section === null || fresh_section === null) return fresh_form;
	const refreshed_section = form_fields_previous_comment(previous_section, fresh_section);
	return replace_between_markers(fresh_form, "FIELDS", refreshed_section);
}

/** Keep the generated details slot aligned with the persisted form setting. */
export function sync_details_container(form_content: string, form_details: boolean): string {
	const details_classes = form_details
		? "col-span-full gap-4 grid empty:hidden lg:col-start-3 lg:self-start"
		: "col-span-full gap-4 hidden";
	const generated_details = /<aside class="col-span-full gap-4 (?:hidden|grid empty:hidden lg:col-start-3 lg:self-start)" data-form-details>/;
	return form_content.replace(generated_details, `<aside class="${details_classes}" data-form-details>`);
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
