/**
 * Studio - display contract validation via the generator's own validators.
 *
 * The generator is the authority on the display contract: `validate_schema_display_contract`
 * and `validate_ddl_cache_display_contract` in `generator/schema/display_contract.ts` are
 * what the DDL cache runs, and what produces the "Display contract violation" errors seen
 * in reeman. This module points those same functions at a throwaway sandbox database so
 * the studio's answer cannot drift from the generator's.
 *
 * Deliberate cross-folder import: duplicating the rules here is what caused the studio to
 * report a schema clean that the generator then rejected. There is exactly one definition
 * of the contract, and it lives in the generator.
 *
 * The cache entry is assembled the same way `introspect_database()` does it in
 * `generator/ddl_cache.ts` - that function cannot be reused directly because it is
 * hardwired to `DEV_CONNECTION_STRING` and the module-level `db_type`, while validation runs
 * against a sandbox holding the candidate schema.
 */

import { detect_implicit_foreign_keys, detect_view_foreign_keys } from "$generator/ddl_cache";
import type { DdlCacheData, DdlCachedColumn, DdlCachedTable } from "$generator/ddl_cache_types";
import { validate_ddl_cache_display_contract, validate_schema_display_contract } from "$generator/schema/display_contract";
import { MySQLIntrospector } from "$generator/schema/mysql/mysql_introspector";
import { SQLiteIntrospector } from "$generator/schema/sqlite/sqlite_introspector";
import type { ColumnDef, SchemaObject } from "$generator/schema/types";
import type { SQL } from "bun";

/** Same exclusions the DDL cache applies. */
const INTERNAL_PREFIXES = ["_", "sqlite_"];

export interface ContractViolation {
	object_name: string;
	message: string;
}

/**
 * Introspect a sandbox database and run the generator's display-contract validators.
 * Returns the violation the generator would raise, or null when the schema is clean.
 */
export async function check_display_contract(db: SQL, db_type: "sqlite" | "mysql"): Promise<ContractViolation | null> {
	const introspector = db_type === "mysql" ? new MySQLIntrospector(db) : new SQLiteIntrospector(db);
	const all_schemas = await introspector.get_database_schema();

	try {
		validate_schema_display_contract(all_schemas);
	} catch (error) {
		return to_violation(error);
	}

	const cache = await build_cache_data(db, db_type, all_schemas);
	try {
		validate_ddl_cache_display_contract(cache);
	} catch (error) {
		return to_violation(error);
	}
	return null;
}

/** Assemble a DdlCacheData for the sandbox, mirroring `introspect_database()`. */
async function build_cache_data(db: SQL, db_type: "sqlite" | "mysql", all_schemas: SchemaObject[]): Promise<DdlCacheData> {
	const table_column_map = new Map<string, string[]>();
	for (const schema of all_schemas) {
		if (schema.type !== "table") continue;
		const column_names = schema.columns.map((column) => column.name.toLowerCase());
		table_column_map.set(schema.name, column_names);
	}

	const view_names = all_schemas.filter((schema) => schema.type === "view").map((schema) => schema.name);
	const view_definitions = await read_view_definitions(db, db_type, view_names);

	const tables: DdlCachedTable[] = [];
	for (const schema of all_schemas) {
		if (schema.type !== "table") continue;
		if (INTERNAL_PREFIXES.some((prefix) => schema.name.toLowerCase().startsWith(prefix))) continue;

		const view_name = schema.has_view ? `v_${schema.name}` : null;
		const view_sql = view_name ? view_definitions.get(view_name.toLowerCase()) ?? null : null;

		const native_fks = schema.foreign_keys.map((foreign_key) => ({
			column_name: foreign_key.column_name,
			referenced_table: foreign_key.referenced_table_name,
			referenced_column: foreign_key.referenced_column_name,
			source: "native" as const,
			confidence: "exact" as const,
		}));
		const inferred_fks = detect_implicit_foreign_keys(schema, table_column_map);
		const view_fks = view_sql ? detect_view_foreign_keys(schema.name, view_sql, all_schemas) : [];
		const view_columns = schema.view_columns ? schema.view_columns.map(map_column) : null;

		tables.push({
			name: schema.name,
			comment: schema.comment ?? "",
			columns: schema.columns.map(map_column),
			indexed_columns: [],
			foreign_keys: native_fks,
			inferred_foreign_keys: inferred_fks,
			view_foreign_keys: view_fks,
			has_view: schema.has_view,
			view_name,
			view_columns,
			view_definition: view_sql,
		});
	}

	return { generated_at: new Date().toISOString(), db_type, tables, broken_views: [] };
}

/** View SQL keyed by lowercased view name, used for view-join FK detection. */
async function read_view_definitions(db: SQL, db_type: "sqlite" | "mysql", view_names: string[]): Promise<Map<string, string>> {
	const view_map = new Map<string, string>();

	for (const view_name of view_names) {
		try {
			if (db_type === "mysql") {
				const rows = await db.unsafe(`SHOW CREATE VIEW \`${view_name}\``) as Record<string, string>[];
				const row = rows[0];
				if (!row) continue;
				const create_def = row["Create View"] ?? row["create view"] ?? row["Create_View"] ?? row.create_view ?? "";
				if (create_def) view_map.set(view_name.toLowerCase(), create_def);
				continue;
			}
			const rows = await db.unsafe("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?", [view_name]) as { sql: string; }[];
			const create_def = rows[0]?.sql;
			if (create_def) view_map.set(view_name.toLowerCase(), create_def);
		} catch {
			// A view whose definition cannot be read simply contributes no join-derived FKs.
		}
	}

	return view_map;
}

function map_column(column: ColumnDef): DdlCachedColumn {
	return {
		name: column.name,
		type_string: column.type_string,
		comment: column.comment,
		is_nullable: column.is_nullable,
		is_primary_key: column.is_primary_key,
		is_auto_increment: column.is_auto_increment,
		is_generated: column.is_generated ?? false,
	};
}

/** Pull the offending object name out of the generator's message so it can be reported per-object. */
function to_violation(error: unknown): ContractViolation {
	const message = error instanceof Error ? error.message : String(error);
	const quoted = /Display contract violation: "([^"]+)"/.exec(message);
	const object_name = quoted ? quoted[1]!.split(".")[0]! : "";
	return { object_name, message };
}
