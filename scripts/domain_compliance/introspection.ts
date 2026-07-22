/**
 * scripts/domain_compliance/introspection.ts
 *
 * Report data types and live-DB introspection for the domain-compliance
 * checker. FK/index/default queries are MySQL-only (they return empty on
 * SQLite). Consumed by scripts/check_domain_compliance.ts (the runner) and
 * ./alter_sql.ts (the migration-script generator).
 */

import { db } from "$config/db";
import { db_type } from "$lib/resolve_db_type";

export interface ColumnReport {
	table: string;
	column: string;
	current_type: string;
	domain_type: string | null;
	expected_sql: string | null;
	compliant: boolean;
	comment: string;
	nullable: boolean;
}

// FK constraint info for ALTER TABLE wrapping.
export interface FKConstraint {
	constraint_name: string;
	column: string;
	referenced_table: string;
	referenced_column: string;
}

// Index info for documentation comments.
export interface IndexOnColumn {
	index_name: string;
	column: string;
	is_unique: boolean;
}

/**
 * Query all FK constraints on a MySQL table, grouped as individual column mappings.
 * Composite FKs are returned as multiple rows with the same constraint_name.
 */
export async function get_fk_constraints(table: string): Promise<FKConstraint[]> {
	if (db_type !== "mysql") return [];

	const rows = (await db`
		SELECT
			kcu.CONSTRAINT_NAME AS constraint_name,
			kcu.COLUMN_NAME AS column_name,
			kcu.REFERENCED_TABLE_NAME AS referenced_table,
			kcu.REFERENCED_COLUMN_NAME AS referenced_column
		FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
		JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
			ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
			AND kcu.TABLE_SCHEMA = tc.TABLE_SCHEMA
		WHERE kcu.TABLE_SCHEMA = DATABASE()
			AND kcu.TABLE_NAME = ${table}
			AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
		ORDER BY kcu.ORDINAL_POSITION
	`) as any[];

	return rows.map((r) => ({
		constraint_name: r.constraint_name as string,
		column: r.column_name as string,
		referenced_table: r.referenced_table as string,
		referenced_column: r.referenced_column as string,
	}));
}

/**
 * Query all non-PK indexes on a MySQL table.
 * Returns one entry per (index_name, column_name) pair - composite indexes
 * produce multiple rows with the same index_name.
 */
export async function get_table_indexes(table: string): Promise<IndexOnColumn[]> {
	if (db_type !== "mysql") return [];

	const rows = (await db`
		SELECT
			INDEX_NAME AS index_name,
			COLUMN_NAME AS column_name,
			NON_UNIQUE AS non_unique
		FROM INFORMATION_SCHEMA.STATISTICS
		WHERE TABLE_SCHEMA = DATABASE()
			AND TABLE_NAME = ${table}
			AND INDEX_NAME <> 'PRIMARY'
		ORDER BY INDEX_NAME, SEQ_IN_INDEX
	`) as any[];

	return rows.map((r) => ({
		index_name: r.index_name as string,
		column: r.column_name as string,
		is_unique: (r.non_unique as number) === 0,
	}));
}

/**
 * Query column default values for specific columns in a MySQL table.
 * Returns a map of column_name -> COLUMN_DEFAULT (raw string from information_schema).
 *
 * MySQL stores defaults in `information_schema.COLUMNS.COLUMN_DEFAULT`:
 * - `'text'` (with quotes) for string defaults
 * - `0`, `1` for numeric defaults
 * - `CURRENT_TIMESTAMP` for function defaults
 * - SQL NULL when there is no explicit default (including expression defaults)
 *
 * The returned value can be appended directly to `DEFAULT <value>` since
 * information_schema already formats it correctly for SQL.
 */
export async function get_column_defaults(table: string): Promise<Map<string, string | null>> {
	if (db_type !== "mysql") return new Map();

	const rows = (await db`
		SELECT COLUMN_NAME, COLUMN_DEFAULT
		FROM INFORMATION_SCHEMA.COLUMNS
		WHERE TABLE_SCHEMA = DATABASE()
			AND TABLE_NAME = ${table}
	`) as any[];

	const result = new Map<string, string | null>();
	for (const r of rows) {
		// COLUMN_DEFAULT is SQL NULL (JavaScript null) when no default is set
		result.set(r.COLUMN_NAME as string, r.COLUMN_DEFAULT as string | null);
	}
	return result;
}

/**
 * Detect expression defaults (DEFAULT_GENERATED) for columns in a table.
 *
 * In MySQL 8.0.13+, expression defaults like `DEFAULT (uuid_v7())` store
 * COLUMN_DEFAULT as SQL NULL with EXTRA containing 'DEFAULT_GENERATED'.
 * The actual expression is only available via SHOW CREATE TABLE.
 *
 * Returns a map of column_name -> expression string (e.g. "uuid_v7()").
 * The caller should format it as `DEFAULT (expression)` in the ALTER output.
 */
export async function get_expression_defaults(table: string, columns: string[]): Promise<Map<string, string>> {
	if (db_type !== "mysql" || columns.length === 0) return new Map();

	// 1. Find columns where COLUMN_DEFAULT is NULL but EXTRA has DEFAULT_GENERATED
	const rows = (await db`
		SELECT COLUMN_NAME, EXTRA
		FROM INFORMATION_SCHEMA.COLUMNS
		WHERE TABLE_SCHEMA = DATABASE()
			AND TABLE_NAME = ${table}
	`) as any[];

	const expr_columns: string[] = [];
	const column_set = new Set(columns);

	for (const r of rows) {
		const col_name = r.COLUMN_NAME as string;
		const extra = (r.EXTRA as string) ?? "";
		if (column_set.has(col_name) && extra.includes("DEFAULT_GENERATED")) { expr_columns.push(col_name); }
	}

	if (expr_columns.length === 0) return new Map();

	// 2. Parse SHOW CREATE TABLE to extract the expressions
	const create_sql = await get_create_table_sql(table);
	if (!create_sql) return new Map();

	const result = new Map<string, string>();
	for (const col of expr_columns) {
		const expr = extract_expr_default(create_sql, col);
		if (expr) { result.set(col, expr); }
	}
	return result;
}

/**
 * Run SHOW CREATE TABLE and return the CREATE TABLE SQL string.
 * Returns null if the query fails (e.g. permission denied).
 */
async function get_create_table_sql(table: string): Promise<string | null> {
	try {
		const rows = (await db`SHOW CREATE TABLE ${db.unsafe("`" + table.replace(/`/g, "``") + "`")}`) as any[];
		if (rows.length > 0 && rows[0]["Create Table"]) { return rows[0]["Create Table"] as string; }
		return null;
	} catch {
		return null;
	}
}

/**
 * Extract an expression default from a CREATE TABLE SQL statement.
 * Looks for `column_name` ... DEFAULT (expression) and returns the expression.
 *
 * @param create_sql - The full CREATE TABLE SQL string.
 * @param column - The column name to find.
 * @returns The expression inside DEFAULT(...) or null.
 */
function extract_expr_default(create_sql: string, column: string): string | null {
	const esc = column.replace(/`/g, "``");
	// Match: `column_name` whitespace ... DEFAULT ( expression )
	const pattern = new RegExp("`" + esc + "`" + "\\s+.*?DEFAULT\\s*\\(", "is");
	const match = create_sql.match(pattern);
	return match ? match[1].trim() : null;
}
