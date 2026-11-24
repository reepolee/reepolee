/**
 * Turning an ExpectedTable into dialect DDL.
 *
 * Kept apart from the syncer so the "what should exist" computation
 * (expected_schema.ts) stays free of SQL string building, and so adding a
 * dialect means touching one file.
 */

import type { ExpectedColumn, ExpectedTable } from "./expected_schema";

export type DbDialect = "mysql" | "sqlite";

function quote_identifier(name: string, dialect: DbDialect): string {
	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`);
	return dialect === "mysql" ? `\`${name}\`` : `"${name}"`;
}

/**
 * A clone's id is supplied by the caller, never minted locally (D3), so the
 * PK is declared without AUTO_INCREMENT/AUTOINCREMENT on both dialects.
 * SQLite's "INTEGER PRIMARY KEY" is a rowid alias and still accepts an
 * explicit id, which is exactly what the fan-out writes.
 */
function column_ddl(column: ExpectedColumn, dialect: DbDialect): string {
	const parts = [quote_identifier(column.name, dialect), column.type_string];

	if (column.is_primary_key) parts.push("PRIMARY KEY");
	else if (!column.is_nullable) parts.push("NOT NULL");

	// The default is carried verbatim from the base table. A NOT NULL column
	// fed by its default (created_at) is never supplied by the write fan-out,
	// so without it the clone insert fails.
	if (!column.is_primary_key && column.default_value !== undefined && column.default_value !== null) {
		parts.push(`DEFAULT ${column.default_value}`);
	}

	return parts.join(" ");
}

/**
 * Generated columns cannot be cloned as plain columns - the base table
 * computes `display` from its own row, and the clone must do the same from
 * ITS row (its localized name, not the base name). The expression is not
 * available from introspection metadata alone, so generated columns are
 * skipped here and re-added by the caller from the base table's DDL.
 */
/**
 * `generated_column_lines` carries the base table's GENERATED ALWAYS clauses
 * verbatim (the expressions are not available from introspection metadata).
 * They must land with the other columns, before any table-level constraint -
 * a column definition after a FOREIGN KEY clause is a syntax error.
 */
export function create_table_ddl(table: ExpectedTable, dialect: DbDialect, generated_column_lines: readonly string[] = []): string {
	const concrete_columns = table.columns.filter((column) => !column.is_generated);
	const column_lines = concrete_columns.map((column) => `\t${column_ddl(column, dialect)}`);
	const generated_lines = generated_column_lines.map((line) => `\t${line}`);

	// Locale sidecars deliberately do not emit foreign keys. Keep this generic
	// for callers that may provide them, but expected locale tables provide none.
	const fk_lines = table.foreign_keys.map((fk) => {
		const column = quote_identifier(fk.column_name, dialect);
		const target_table = quote_identifier(fk.referenced_table, dialect);
		const target_column = quote_identifier(fk.referenced_column, dialect);
		return `\tFOREIGN KEY (${column}) REFERENCES ${target_table}(${target_column})`;
	});

	const body = [...column_lines, ...generated_lines, ...fk_lines].join(",\n");
	const table_name = quote_identifier(table.name, dialect);
	return `CREATE TABLE ${table_name} (\n${body}\n)`;
}

export function drop_table_ddl(table_name: string, dialect: DbDialect): string {
	return `DROP TABLE IF EXISTS ${quote_identifier(table_name, dialect)}`;
}

export function add_column_ddl(table_name: string, column: ExpectedColumn, dialect: DbDialect): string {
	const table = quote_identifier(table_name, dialect);
	// An added column must be nullable regardless of the base table's
	// constraint: existing rows have no value for it and a NOT NULL add would
	// be rejected. The backfill supplies values immediately afterward.
	const nullable_column: ExpectedColumn = { ...column, is_nullable: true, is_primary_key: false };
	return `ALTER TABLE ${table} ADD COLUMN ${column_ddl(nullable_column, dialect)}`;
}

export function drop_column_ddl(table_name: string, column_name: string, dialect: DbDialect): string {
	const table = quote_identifier(table_name, dialect);
	const column = quote_identifier(column_name, dialect);
	return `ALTER TABLE ${table} DROP COLUMN ${column}`;
}
