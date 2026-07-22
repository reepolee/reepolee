/**
 * Schema Reader - Phase 1 of CRUD generation pipeline.
 *
 * Loads a table schema module and extracts all metadata needed
 * for file generation: fields, foreign keys, search/sort settings,
 * pagination strategy, and nested parent info.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { singularize } from "../naming";
import { entry_fields } from "../validation_generator";
import { determine_search_field, extract_foreign_keys, generate_sort_options, log_step } from "./helpers";
import type { FieldDef, ForeignKeyMap, ParentInfo } from "./types";

export interface TableMeta {
	table_name: string;
	route_name: string;
	fields: FieldDef[];
	v_fields: FieldDef[] | null;
	columns: Record<string, any> | null;
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
	const route_dir = join(process.cwd(), "routes", ...parts);
	const relative_dir = `routes/${parts.join("/")}`;
	return { route_dir, relative_dir };
}

export async function load_table_schema(table_name: string, options: {
	clean_prefix: string;
	route_prefix: string;
	parent_cli_table: string;
	route_name?: string;
	pagination_strategy?: "cursor" | "offset";
}): Promise<TableMeta> {
	const { clean_prefix, route_prefix, parent_cli_table, route_name: raw_route_name, pagination_strategy: cli_pagination } = options;
	const effective_route_name = raw_route_name || table_name;
	const { route_dir, relative_dir } = compute_route_dirs(table_name, clean_prefix, parent_cli_table, effective_route_name);

	const table_module_path = join(route_dir, "schema", "table.ts");
	log_step(`Importing table module: ${table_module_path}`);
	let table_module: any;
	try {
		table_module = await import(`file://${table_module_path}`);
	} catch {
		let hint = `Run 'bun generator/resource.ts ${table_name}' to generate the schema first.`;
		try {
			const cache = JSON.parse(readFileSync(join(process.cwd(), ".reepolee", "ddl_cache.json"), "utf-8"));
			const tables: string[] = (cache.tables ?? []).map((t: any) => t.name);
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
		parent_dir = join(process.cwd(), "routes", parent_info.table);
		const exists_root = await Bun.file(join(parent_dir, "index.ts")).exists();
		if (!exists_root && clean_prefix) {
			const prefixed = join(process.cwd(), "routes", clean_prefix, parent_info.table);
			const exists_prefixed = await Bun.file(join(prefixed, "index.ts")).exists();
			if (exists_prefixed) { parent_dir = prefixed; }
		}
	}
	if (is_nested) { log_step(`Nested CRUD detected: parent="${parent_info.table}", fk="${parent_info.fk_column}"`); }

	const fields = table_module.fields ? Object.values(table_module.fields) : [];
	const v_fields: FieldDef[] | null = table_module.v_fields ? Object.values(table_module.v_fields) as FieldDef[] : null;
	const columns = table_module.columns ?? null;

	if (fields.length === 0) throw new Error("Fields not found in table.ts");

	let generated_fields: Record<string, any> | null = null;
	let indexed_columns: string[] | undefined = table_module.indexed_columns;
	try {
		const gen_path = table_module_path.replace(/\.ts$/, ".generated.ts");
		const gen_module = await import(`file://${gen_path}`);
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
	try {
		const { load_ddl_cache, get_cached_foreign_keys } = await import("../ddl_cache");
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

	const route_param = table_module.route_param || undefined;
	const id_in_fields = fields.some((f) => f.name === "id");
	const is_auto_increment_pk = !id_in_fields;
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

function levenshtein(a: string, b: string): number {
	if (Math.abs(a.length - b.length) > 2) return 3;
	const dp: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let prev = dp[0];
		dp[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = dp[j];
			dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
			prev = tmp;
		}
	}
	return dp[b.length];
}
