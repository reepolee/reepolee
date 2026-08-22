/**
 * Generic table sync primitive.
 *
 * Upserts rows from any source into any Reepolee table, keyed on a unique
 * column (e.g. `external_id`). The source, the reshape mapping, and the
 * dedupe policy are caller-supplied, so the same primitive drives a CF D1
 * import, a CSV load, or a vendor API sync without change.
 *
 * The caller owns the `SQL` connection's lifecycle (open/close) and passes it
 * in. Table and column names come from the schema (trusted identifiers, never
 * interpolated user input).
 */
import type { SQL } from "bun";

export interface TableSyncOptions {
	/** Target table name (unquoted, from the schema). */
	table: string;
	/** Unique column the upsert matches on (e.g. "external_id"). */
	key_column: string;
	/** Columns written on insert/update, key_column excluded. */
	columns: readonly string[];
	/** Open bun:sql connection - the caller owns open/close. */
	db: SQL;
	/** Fetch raw rows from the source (file, HTTP API, anything). */
	fetch_rows: () => Promise<Record<string, unknown>[]>;
	/** Map a raw row to target column values. Must include `key_column`. */
	reshape: (raw: Record<string, unknown>) => Record<string, unknown>;
	/** Optional post-reshape collapse (e.g. keep latest resubmission). */
	dedupe?: (rows: Record<string, unknown>[]) => Record<string, unknown>[];
	/** Optional progress logger (defaults to silent). */
	log?: (message: string) => void;
}

export interface TableSyncResult {
	inserted: number;
	updated: number;
}

export async function sync_table(options: TableSyncOptions): Promise<TableSyncResult> {
	const { table, key_column, columns, db, fetch_rows, reshape, dedupe, log } = options;

	const raw_rows = await fetch_rows();
	log?.(`[table-sync] fetched ${raw_rows.length} raw row(s) from source`);

	let rows = raw_rows.map(reshape);
	if (dedupe) {
		const before = rows.length;
		rows = dedupe(rows);
		const collapsed = before - rows.length;
		if (collapsed > 0) log?.(`[table-sync] ${collapsed} duplicate(s) collapsed by dedupe`);
	}

	// Load existing keys so the upsert is a plain INSERT-or-UPDATE, not a
	// per-row existence probe.
	const existing = new Set<string>();
	const existing_rows = (await db.unsafe(`SELECT ${key_column} FROM ${table} WHERE ${key_column} IS NOT NULL`)) as { [k: string]: unknown }[];
	for (const row of existing_rows) existing.add(String(row[key_column]));

	const column_list = columns.join(", ");
	const placeholders = columns.map(() => "?").join(", ");
	const update_assignments = columns.map((column) => `${column} = ?`).join(", ");

	let inserted = 0;
	let updated = 0;
	for (const row of rows) {
		const key = String(row[key_column] ?? "");
		const values = columns.map((column) => row[column] ?? null);
		if (existing.has(key)) {
			await db.unsafe(`UPDATE ${table} SET ${update_assignments} WHERE ${key_column} = ?`, [...values, key]);
			updated++;
		} else {
			await db.unsafe(`INSERT INTO ${table} (${key_column}, ${column_list}) VALUES (?, ${placeholders})`, [key, ...values]);
			inserted++;
		}
	}

	return { inserted, updated };
}
