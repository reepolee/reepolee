/**
 * Schema Reader - Phase 1 of CRUD generation pipeline.
 *
 * Loads a table schema module and extracts all metadata needed
 * for file generation: fields, foreign keys, search/sort settings,
 * pagination strategy, and nested parent info.
 */

import { join } from "node:path";

import { LOCALIZATION_SYSTEM_FIELDS } from "$config/db_structure";
import { singularize } from "../naming";
import { entry_fields } from "../validation_generator";
import { determine_search_field, extract_foreign_keys, generate_sort_options, log_step } from "./helpers";
import type { ScopeSeed } from "./archive_scopes";
import type { ColumnDef, FieldDef, ForeignKeyMap, LocalizedFieldMeta, ParentInfo } from "./types";
import { MAIN_APP, MAIN_APP_POSIX } from "$config/paths";
import { load_table_module_fresh } from "$generator/schema/table_module_loader";

export interface TableMeta {
	table_name: string;
	route_name: string;
	fields: FieldDef[];
	v_fields: FieldDef[] | null;
	columns: Record<string, ColumnDef> | null;
	localization_enabled: boolean;
	localized_fields: LocalizedFieldMeta[];
	// Every physical column on the table, in DB order - not the same as `fields`,
	// which omits the auto-increment PK, maintenance columns, and other UI-level
	// exclusions. Only populated (and only required) when localization_enabled,
	// to build the SELECT list for the locale-aware derived-table query.
	column_names: string[];
	// The view's physical columns, when `v_<table>` exists. A view only exposes
	// `archived_at` if its SELECT list carries it through, so archive filtering
	// on the view read has to be decided from this list, not the table's.
	view_column_names: string[];
	// Declared global scopes from schema/table.ts, in declaration order. The
	// generator seeds these as global_scopes rows for archivable routes.
	global_scopes: ScopeSeed[];
	generated_fields: Record<string, any> | null;
	indexed_columns: string[] | undefined;
	foreign_keys: ForeignKeyMap;
	list_fields: FieldDef[];
	search_field: string;
	sort_options: string;
	singular: string;
	first_field: string;
	crud_name: string;
	pagination_strategy: "cursor" | "offset";
	render_strategy: "stream" | "load";
	template_tags: "flat" | "tags";
	grid_filler: string;
	route_param: string | undefined;
	id_type: string;
	id_type_interface: string;
	is_auto_increment_pk: boolean;
	route_param_value: string;
	is_nested: boolean;
	parent_info: ParentInfo | undefined;
	parent_dir: string | null;
	route_dir: string;
	relative_dir: string;
	clean_prefix: string;
	route_prefix: string;
	changed_dirs: Set<string>;
}

/**
 * Compute route directory and relative path for a table.
 * When route_name is specified, it replaces table_name in the path.
 */
export function compute_route_dirs(table_name: string, clean_prefix: string, parent_cli_table: string, route_name: string = ""): { route_dir: string; relative_dir: string; } {
	const dir_name = route_name || table_name;
	const parts = [...(clean_prefix ? [clean_prefix] : []), ...(parent_cli_table ? [parent_cli_table] : []), dir_name];
	const route_dir = join(process.cwd(), MAIN_APP, ...parts);
	const relative_dir = `${MAIN_APP_POSIX}/${parts.join("/")}`;
	return { route_dir, relative_dir };
}

/**
 * Normalize the `global_scopes` const of a schema/table.ts into an ordered
 * array of seeds. Accepts the record form the generator writes
 * (`{ "__live": { display_name, where_clause?, sort_order?, is_default? } }`);
 * anything else yields an empty array, meaning nothing to seed.
 */
function normalize_declared_scopes(declared: unknown): ScopeSeed[] {
	if (!declared || typeof declared !== "object") return [];
	return Object.entries(declared as Record<string, Record<string, unknown>>).map(([scope_key, def], index) => {
		const d = def ?? {};
		return {
			scope_key,
			display_name: typeof d.display_name === "string" ? d.display_name : scope_key,
			where_clause: typeof d.where_clause === "string" ? d.where_clause : undefined,
			sort_order: typeof d.sort_order === "number" ? d.sort_order : index,
			is_default: d.is_default === true || d.is_default === 1,
		};
	});
}

export async function load_table_schema(table_name: string, options: {
	clean_prefix: string;
	route_prefix: string;
	parent_cli_table: string;
	route_name?: string;
	pagination_strategy?: "cursor" | "offset";
	template_tags?: "flat" | "tags";
	skip_cache?: boolean;
}): Promise<TableMeta> {
	const { clean_prefix, route_prefix, parent_cli_table, route_name: raw_route_name, pagination_strategy: cli_pagination, template_tags: cli_template_tags, skip_cache = false } = options;
	const effective_route_name = raw_route_name || table_name;
	const { route_dir, relative_dir } = compute_route_dirs(table_name, clean_prefix, parent_cli_table, effective_route_name);

	const table_module_path = join(route_dir, "schema", "table.ts");
	log_step(`Importing table module: ${table_module_path}`);
	let table_module: any;
	try {
		table_module = await load_table_module_fresh<any>(table_module_path);
	} catch {
		let hint = `Run 'bun reeman crud ${table_name}' to generate the schema first.`;
		try {
			// In-memory snapshot the caller already introspected - there is no
			// on-disk cache to fall back on.
			const { load_ddl_cache, get_cached_tables } = await import("../ddl_cache");
			const cache = await load_ddl_cache();
			const tables: string[] = get_cached_tables(cache);
			if (tables.length > 0) {
				const close = tables.find((t) => levenshtein(t, table_name) <= 2);
				if (close) hint += `\nDid you mean: ${close}?`;
				hint += `\nAvailable tables: ${tables.join(", ")}`;
			}
		} catch {}
		throw new Error(`Table schema not found: ${table_module_path}\n${hint}`);
	}
	log_step(`Table module imported: ${Object.keys(table_module.fields || {}).length} fields`);

	const parent_info = table_module.parent ?? undefined;
	const is_nested = !!parent_info;

	let parent_dir: string | null = null;
	if (is_nested) {
		parent_dir = join(process.cwd(), MAIN_APP, parent_info.table);
		const exists_root = await Bun.file(join(parent_dir, "index.ts")).exists();
		if (!exists_root && clean_prefix) {
			const prefixed = join(process.cwd(), MAIN_APP, clean_prefix, parent_info.table);
			const exists_prefixed = await Bun.file(join(prefixed, "index.ts")).exists();
			if (exists_prefixed) { parent_dir = prefixed; }
		}
	}
	if (is_nested) { log_step(`Nested CRUD detected: parent="${parent_info.table}", fk="${parent_info.fk_column}"`); }

	const fields = table_module.fields ? Object.values(table_module.fields) as FieldDef[] : [];
	const v_fields: FieldDef[] | null = table_module.v_fields ? Object.values(table_module.v_fields) as FieldDef[] : null;
	const columns = table_module.columns ?? null;
	// Declared global scopes from schema/table.ts - the generator seeds these as
	// global_scopes rows. Record keyed by scope_key, converted to an ordered
	// array; absent or empty means there is nothing to seed.
	const global_scopes: ScopeSeed[] = normalize_declared_scopes(table_module.global_scopes);

	if (fields.length === 0) throw new Error("Fields not found in table.ts");

	let generated_fields: Record<string, any> | null = null;
	let indexed_columns: string[] | undefined = table_module.indexed_columns;
	try {
		const gen_path = table_module_path.replace(/\.ts$/, ".generated.ts");
		const gen_module = await load_table_module_fresh<any>(gen_path);
		generated_fields = gen_module.fields || null;
		if (!indexed_columns) indexed_columns = gen_module.indexed_columns || undefined;
	} catch {
		// table.generated.ts may not exist yet
	}

	const foreign_keys = extract_foreign_keys(fields, generated_fields);

	// Cross-reference with DB cache - the cache may have detected additional FKs
	// (e.g. from view JOINs or improved naming convention logic) that aren't yet
	// in the generated files. This ensures CRUD generation picks up cache changes
	// even without re-running schema generation first.
	// Priority: cache FK overrides file FK when the referenced table differs.
	let column_names: string[] = [];
	let view_column_names: string[] = [];
	let cached_primary_key_is_auto_increment: boolean | undefined;
	if (!skip_cache) try {
		const { load_ddl_cache, get_cached_foreign_keys, get_cached_table } = await import("../ddl_cache");
		const cache = await load_ddl_cache();
		const cached_fks = get_cached_foreign_keys(cache, table_name);
		for (const cfk of cached_fks) {
			const existing = foreign_keys.get(cfk.column_name);
			if (!existing || existing.table !== cfk.referenced_table) {
				foreign_keys.set(cfk.column_name, {
					table: cfk.referenced_table,
					column: cfk.referenced_column,
					label: undefined,
				});
				if (existing) {
					log_step(`FK overridden from cache: ${cfk.column_name} → ${existing.table}.${existing.column} → ${cfk.referenced_table}.${cfk.referenced_column}`);
				} else {
					log_step(`FK added from cache: ${cfk.column_name} → ${cfk.referenced_table}.${cfk.referenced_column}`);
				}
			}
		}
		const cached_table = get_cached_table(cache, table_name);
		column_names = cached_table?.columns.map((c) => c.name) ?? [];
		view_column_names = cached_table?.view_columns?.map((c) => c.name) ?? [];
		cached_primary_key_is_auto_increment = cached_table?.primary_key?.is_auto_increment;
	} catch (err) {
		log_step(`Cache cross-reference failed for ${table_name}: ${err instanceof Error ? err.message : String(err)} - proceeding with file-based FKs`);
	}

	const list_fields = v_fields || fields;
	const search_field = determine_search_field(list_fields);
	const sort_options = generate_sort_options(list_fields, indexed_columns);
	const singular = singularize(table_name);
	const first_field = entry_fields(fields, false)[0]?.name ?? "id";
	// Sanitize route_name for JS identifiers (replace hyphens/special chars with underscores)
	const js_safe_route_name = effective_route_name.replace(/[^a-zA-Z0-9_]/g, "_");
	const crud_name = clean_prefix ? `${clean_prefix}_${js_safe_route_name}_crud` : `${js_safe_route_name}_crud`;

	const pagination_strategy: "cursor" | "offset" = cli_pagination || table_module.pagination_strategy || "offset";
	const render_strategy: "stream" | "load" = table_module.render_strategy || "load";
	const template_tags: "flat" | "tags" = cli_template_tags || table_module.template_tags || "flat";
	// Trailing grid filler track. Absent in table.ts files scaffolded before it existed.
	const grid_filler: string = table_module.grid_filler || "1fr";

	// Backfill grid_filler into table.ts files scaffolded before the const existed.
	// The generated index.ts imports it by name, so a missing export would resolve to
	// undefined and put the literal "undefined" into grid-template-columns.
	if (table_module.grid_filler === undefined) {
		const backfilled = backfill_grid_filler(await Bun.file(table_module_path).text(), grid_filler);
		if (backfilled) {
			await Bun.write(table_module_path, backfilled);
			console.log(`  ${Bun.color("green", "ansi")}Added grid_filler = "${grid_filler}" to schema`);
		}
	}

	// Persist pagination strategy to schema file if CLI explicitly overrode it
	if (cli_pagination && cli_pagination !== table_module.pagination_strategy) {
		try {
			let schema_content = await Bun.file(table_module_path).text();
			const old_pattern = `const pagination_strategy: "cursor" | "offset" = "`;
			const old_start = schema_content.indexOf(old_pattern);
			if (old_start >= 0) {
				const line_end = schema_content.indexOf("\n", old_start);
				schema_content = `${schema_content.slice(0, old_start)}const pagination_strategy: "cursor" | "offset" = "${pagination_strategy}";${schema_content.slice(line_end)}`;
				await Bun.write(table_module_path, schema_content);
				console.log(`  ${Bun.color("green", "ansi")}Updated schema pagination to "${pagination_strategy}"`);
			}
		} catch {}
	}

	// Persist template_tags to schema file if CLI explicitly overrode it
	if (cli_template_tags && cli_template_tags !== table_module.template_tags) {
		try {
			let schema_content = await Bun.file(table_module_path).text();
			const old_pattern = `const template_tags: "flat" | "tags" = "`;
			const old_start = schema_content.indexOf(old_pattern);
			if (old_start >= 0) {
				const line_end = schema_content.indexOf("\n", old_start);
				schema_content = `${schema_content.slice(0, old_start)}const template_tags: "flat" | "tags" = "${template_tags}";${schema_content.slice(line_end)}`;
				await Bun.write(table_module_path, schema_content);
				console.log(`  ${Bun.color("green", "ansi")}Updated schema template_tags to "${template_tags}"`);
			}
		} catch {}
	}

	const route_param = table_module.route_param || undefined;
	// The DDL cache's primary-key info is authoritative (it knows a TEXT key
	// like `meta_key` is not auto-increment, which "is there an id field"
	// cannot see). Fall back to the field heuristic when the cache was skipped
	// or the table is absent from it.
	const id_in_fields = fields.some((f) => f.name === "id");
	const is_auto_increment_pk = cached_primary_key_is_auto_increment ?? !id_in_fields;
	// No column_names guard: it existed for build_localized_sql_source, which
	// needed the full column list to build a COALESCE overlay. Locale-suffixed
	// tables query one physical table directly, so the list is not needed.
	const { localization_enabled, localized_fields } = read_localization(table_name, columns, fields, is_auto_increment_pk);
	const id_type = is_auto_increment_pk ? "number" : "number | string";
	const id_type_interface = is_auto_increment_pk ? "number" : "string";
	let route_param_value = route_param || "id";

	// Nested child routes embed both the parent's and the child's own route param
	// in the same URL (e.g. /recipes/:id/ingredients/:id/edit). Both default to
	// "id" and collide, and Bun refuses to register the route. Bump the child's
	// own param to "child_id" whenever it matches the parent's route param.
	if (is_nested && parent_info && route_param_value === parent_info.route_param) {
		route_param_value = "child_id";
	}

	const changed_dirs = new Set([relative_dir]);

	return {
		table_name,
		route_name: effective_route_name,
		fields,
		v_fields,
		columns,
		localization_enabled,
		localized_fields,
		column_names,
		view_column_names,
		global_scopes,
		generated_fields,
		indexed_columns,
		foreign_keys,
		list_fields,
		search_field,
		sort_options,
		singular,
		first_field,
		crud_name,
		pagination_strategy,
		render_strategy,
		template_tags,
		grid_filler,
		route_param,
		id_type,
		id_type_interface,
		is_auto_increment_pk,
		route_param_value,
		is_nested,
		parent_info,
		parent_dir,
		route_dir,
		relative_dir,
		clean_prefix,
		route_prefix,
		changed_dirs,
	};
}

/**
 * Insert a `grid_filler` const and add it to the export list of a table.ts that
 * predates the const. Returns null when either anchor is missing, so a partial
 * patch (const without export, or vice versa) is never written - the generated
 * index.ts imports the name and would break on a half-applied edit.
 */
function backfill_grid_filler(schema_content: string, grid_filler: string): string | null {
	if (schema_content.includes("const grid_filler")) return null;

	const const_anchor = "const enable_archive = ";
	const const_start = schema_content.indexOf(const_anchor);
	if (const_start < 0) return null;
	const const_line_end = schema_content.indexOf("\n", const_start);
	if (const_line_end < 0) return null;

	const export_anchor = "export { columns, route_param, enable_archive,";
	if (!schema_content.includes(export_anchor)) return null;

	const const_block = `\n\n// Trailing filler track appended to the index grid's column widths.\n// "1fr" - filler absorbs the leftover row width, so the widths above are respected.\n// "0px" - no filler width, so columns stretch to fill the row instead.\nconst grid_filler = "${grid_filler}";`;
	const with_const = schema_content.slice(0, const_line_end) + const_block + schema_content.slice(const_line_end);
	return with_const.replace(export_anchor, "export { columns, route_param, enable_archive, grid_filler,");
}

const UNLOCALIZABLE_TYPES = ["autocomplete", "tags", "file", "password"];

/**
 * Which columns declare `localized: true`. This is the only localization
 * decision made at generation time - the set of locales is config and is
 * resolved per request, so adding a locale never requires regeneration.
 */
function read_localization(
	table_name: string,
	columns: Record<string, ColumnDef> | null,
	fields: FieldDef[],
	is_auto_increment_pk: boolean,
): { localization_enabled: boolean; localized_fields: LocalizedFieldMeta[]; } {
	const fields_by_name = new Map(fields.map((field) => [field.name, field]));
	const localized_fields: LocalizedFieldMeta[] = [];

	for (const [field_name, column] of Object.entries(columns || {})) {
		const localized = column?.localized;
		if (localized === undefined || localized === false) continue;
		if (localized !== true) throw new Error(`Invalid localized flag for ${table_name}.${field_name}: expected true, got ${String(localized)}`);

		// System fields are checked first: they are deliberately absent from
		// `fields`, so the generic "not a base-table field" error would
		// otherwise mask the real reason.
		if ((LOCALIZATION_SYSTEM_FIELDS as readonly string[]).includes(field_name)) throw new Error(`System field ${table_name}.${field_name} cannot be localized`);
		const field = fields_by_name.get(field_name);
		if (!field) throw new Error(`Localized field ${table_name}.${field_name} must be a base-table field`);
		if (UNLOCALIZABLE_TYPES.includes(field.type)) throw new Error(`Field type ${field.type} is not supported for localized field ${table_name}.${field_name}`);

		localized_fields.push({
			field_name,
			label: field.label || field_name,
			input_type: localized_input_type(field),
			upload_folder: field.type === "image" ? table_name : undefined,
		});
	}

	const localization_enabled = localized_fields.length > 0;
	if (localization_enabled && !is_auto_increment_pk) {
		throw new Error(`${table_name} cannot be localized: locale clone rows are keyed by the base row integer id`);
	}
	return { localization_enabled, localized_fields };
}

/** Control the localized-panel component should render for this field. */
function localized_input_type(field: FieldDef): string {
	if (field.type === "checkbox") return "boolean";
	if (field.type === "date") return "date";
	if (field.type === "datetime" || field.type === "timestamp") return "datetime";
	if (field.type === "markdown") return "markdown";
	if (field.type === "textarea") return "textarea";
	if (field.type === "image") return "image";
	return "text";
}

function levenshtein(a: string, b: string): number {
	if (Math.abs(a.length - b.length) > 2) return 3;
	const dp: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let prev = dp[0]!;
		dp[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = dp[j]!;
			dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j]!, dp[j - 1]!);
			prev = tmp;
		}
	}
	return dp[b.length]!;
}
