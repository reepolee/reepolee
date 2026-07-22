/**
 * DDL Cache Types - type definitions for the database structure cache.
 *
 * The cache is generated once when reeman/CLI starts and reused during the session
 * to avoid repeated DB introspection. It captures all tables, columns, views,
 * and foreign key relationships (native DDL, implicit *_id naming, and view joins).
 */

// ---------------------------------------------------------------------------
// Column info
// ---------------------------------------------------------------------------

export interface DdlCachedColumn {
	name: string;
	type_string: string;
	comment: string;
	is_nullable: boolean;
	is_primary_key: boolean;
	is_auto_increment: boolean;
	is_generated: boolean;
}

// ---------------------------------------------------------------------------
// Foreign key info - tracks the detection source
// ---------------------------------------------------------------------------

export interface DdlCachedForeignKey {
	column_name: string;
	referenced_table: string;
	referenced_column: string;
	source: "native" | "inferred_naming" | "view_join";
	view_name?: string;
	confidence: "exact" | "high" | "medium";
}

// ---------------------------------------------------------------------------
// Table info
// ---------------------------------------------------------------------------

export interface DdlCachedTable {
	name: string;
	comment: string;
	columns: DdlCachedColumn[];
	indexed_columns: string[];
	foreign_keys: DdlCachedForeignKey[];
	inferred_foreign_keys: DdlCachedForeignKey[];
	view_foreign_keys: DdlCachedForeignKey[];
	has_view: boolean;
	view_name: string | null;
	view_columns: DdlCachedColumn[] | null;
	view_definition: string | null;
}

// ---------------------------------------------------------------------------
// Top-level cache
// ---------------------------------------------------------------------------

export interface DdlCacheData {
	generated_at: string;
	db_type: "mysql" | "sqlite";
	tables: DdlCachedTable[];
}

// ---------------------------------------------------------------------------
// Convenience: all FK types aggregated
// ---------------------------------------------------------------------------

// Convenience: all foreign keys for a table (native + inferred + view).
export function all_foreign_keys_for_table(table: DdlCachedTable): DdlCachedForeignKey[] {
	return [...table.foreign_keys, ...table.inferred_foreign_keys, ...table.view_foreign_keys];
}
