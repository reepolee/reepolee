/**
 * SQL runner over bun:sql's `unsafe()`.
 *
 * Runs SQL against the app's current DB config - the shared `db` connection
 * from `$config/db` - and normalizes the driver-shaped result into a
 * JSON-friendly `{ meta, records }` object. `JSON.stringify(result)`
 * round-trips cleanly.
 *
 * Two entry points:
 *   - `run_sql`            unguarded DEV HELPER: arbitrary SQL (SELECT, writes,
 *     DDL), no SELECT-only check, no result cap. Call it from dev tooling
 *     (MCP, scripts, agents) and never from user-facing request handlers.
 *   - `run_sql_read_only`  guarded: rejects anything but a single SELECT and
 *     caps returned records - the same guard as the MCP inspection query.
 *
 * The Bun SQL driver returns a different shape per engine and statement:
 *   - SELECT (either engine)          -> array of row objects
 *   - SQLite write/DDL                -> empty array + { count, command, lastInsertRowid, affectedRows }
 *   - MySQL write                     -> { meta, rows, lastInsertId, changes }
 * `normalize_sql_result` folds all three into one shape.
 */

import { SQL } from "bun";

import { db } from "$config/db";

export interface SqlRunnerMeta {
	/** Column names in result order, when the statement returned records. */
	columns: string[];
	/** Number of records returned by the statement. */
	record_count: number;
	/** Rows affected by a write statement (INSERT/UPDATE/DELETE), or null. */
	affected_rows: number | null;
	/** Last auto-increment id inserted, when the driver reports one, else null. */
	last_insert_id: number | null;
	/** Driver-reported statement kind, e.g. "SELECT" / "INSERT". */
	command: string | null;
}

export interface SqlRunnerResult {
	meta: SqlRunnerMeta;
	records: Record<string, unknown>[];
}

export interface ReadOnlySqlRunnerResult extends SqlRunnerResult {
	/** True when more records exist beyond the applied cap. */
	truncated: boolean;
}

/**
 * Run arbitrary SQL through `unsafe()` on the current DB connection and return
 * `{ meta, records }`. Pass a different `connection` (e.g. an in-memory SQLite
 * in tests) to target something other than the app DB. Unguarded - see the
 * module docs; use `run_sql_read_only` when writes must be impossible.
 */
export async function run_sql(sql: string, connection: SQL = db): Promise<SqlRunnerResult> {
	return normalize_sql_result(await connection.unsafe(sql));
}

/**
 * Guarded variant of `run_sql`: only a single SELECT statement is allowed, and
 * returned records are capped at `limit` (default 100, max 1000). Writes,
 * multi-statement input, and SELECT file operations are rejected up front, and
 * the query is wrapped so the cap applies inside the database - the same guard
 * as the MCP inspection query. `truncated` reports whether more records exist.
 */
export async function run_sql_read_only(sql: string, connection: SQL = db, limit = 100): Promise<ReadOnlySqlRunnerResult> {
	const result = normalize_sql_result(await connection.unsafe(prepare_read_only_query(sql, limit)));
	const safe_limit = normalize_query_limit(limit);
	const records = result.records.slice(0, safe_limit);
	const truncated = result.records.length > safe_limit;
	return { meta: { ...result.meta, record_count: records.length }, records, truncated };
}

// ---------------------------------------------------------------------------
// Read-only query guard (shared with the MCP inspection query)
// ---------------------------------------------------------------------------

/** Clamp a requested result cap into the accepted 1..1000 range. */
export function normalize_query_limit(limit: number): number {
	return Math.max(1, Math.min(Math.floor(limit) || 100, 1000));
}

/**
 * Validate that `query` is a single read-only SELECT and wrap it so at most
 * `limit + 1` records are fetched (the +1 marks truncation). Throws on writes,
 * multi-statement input, and SELECT file operations.
 */
export function prepare_read_only_query(query: string, limit = 100): string {
	const trimmed = query.trim();
	if (!/^SELECT\b/i.test(trimmed)) {
		throw new Error("Only a single SELECT query is allowed");
	}
	if (query.includes(";")) {
		throw new Error("Multi-statement queries are not allowed");
	}
	if (/\b(?:LOAD_FILE|INTO\s+(?:OUTFILE|DUMPFILE))\b/i.test(query)) {
		throw new Error("SELECT file operations are not allowed");
	}

	const safe_limit = normalize_query_limit(limit);
	return `SELECT * FROM (${trimmed}) AS mcp_query LIMIT ${safe_limit + 1}`;
}

/**
 * Split SQL text into individual statements for execution, preserving
 * SQLite `CREATE TRIGGER ... BEGIN ... END` bodies (whose internal semicolons
 * would otherwise split mid-body). Uses the same splitter as the generator's
 * SQL-file runner. MySQL statements may not contain top-level semicolons in
 * trigger bodies, so the simple `;` split is used there.
 *
 * A trailing statement without a terminating `;` is still captured (grep-style
 * input like `echo "select * from users"` should work without one).
 */
export function split_sql_statements(sql: string, dialect: "mysql" | "sqlite" = "sqlite"): string[] {
	const sql_no_comments = sql.split("\n")
		.map((line) => line.trimStart())
		.filter((line) => !line.startsWith("--"))
		.join("\n");

	const pattern = dialect === "mysql"
		? /[^;]+;|[^;]+$/gi
		: /\s*CREATE\s+TRIGGER[\s\S]*?END\s*;|[^;]+;|[^;]+$/gi;

	return (sql_no_comments.match(pattern) || [])
		.map((statement) => statement.replace(/;\s*$/, "").trim())
		.filter((statement) => statement.length > 0 && !statement.match(
			/^\s*--/
		));
}

function normalize_sql_result(raw: unknown): SqlRunnerResult {
	const result = (raw ?? {}) as Record<string, unknown>;

	// Records: a bare row array (SELECT), or `rows` on MySQL write results.
	const records = (Array.isArray(result) ? result : Array.isArray(result.rows) ? (result.rows as unknown[]) : []) as Record<string, unknown>[];

	// MySQL reports column metadata as an array of { name, type } on some results.
	const raw_meta = result.meta;
	const meta_columns = Array.isArray(raw_meta)
		? raw_meta
				.map((column) => (column as { name?: unknown } | undefined)?.name)
				.filter((name): name is string => typeof name === "string")
		: [];
	const columns = meta_columns.length > 0 ? meta_columns : Object.keys(records[0] ?? {});
	const meta_obj = Array.isArray(raw_meta) ? {} : ((raw_meta ?? {}) as Record<string, unknown>);

	const command = first_string(result.command, meta_obj.command);
	// SQLite reports affected rows as `count` on write statements and leaves
	// `affectedRows` null; MySQL reports them as `changes`.
	const is_write = command !== null && ["INSERT", "UPDATE", "DELETE", "REPLACE"].includes(command.toUpperCase());

	return {
		meta: {
			columns,
			record_count: records.length,
			affected_rows: first_number(result.affectedRows, result.changes, meta_obj.changes, is_write ? result.count : null),
			last_insert_id: first_number(result.lastInsertRowid, result.lastInsertId, meta_obj.lastInsertId),
			command,
		},
		records,
	};
}

function first_number(...values: unknown[]): number | null {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return null;
}

function first_string(...values: unknown[]): string | null {
	for (const value of values) {
		if (typeof value === "string" && value.length > 0) return value;
	}
	return null;
}
