import { DB_CONNECTION_STRING } from "$config/db";
import { SQL } from "bun";
import {
	BOOLEAN_PREFIXES,
	CURRENCY_FIELD,
	DATE_SUFIXES,
	DATETIME_SUFIXES,
	IGNORE_INDEX_FIELDS,
	IGNORE_ORDER_FIELDS,
	IGNORE_TABLES,
	INTERNAL_TABLE_PREFIX,
	MAINTENANCE_FIELDS,
	PERCENT_FIELD,
} from "$config/db_structure";
import { db_type } from "$lib/resolve_db_type";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TableInfo {
	name: string;
	type: "table" | "view";
	column_count: number;
}

export interface ColumnInfo {
	name: string;
	type: string;
	nullable: boolean;
	primary_key: boolean;
	auto_increment: boolean;
	default: string | null;
	foreign_key: { table: string; column: string; } | null;
}

let inspection_db: SQL | null = null;

function sqlite_read_only_url(connection_string: string): string {
	if (/^(?:sqlite:\/\/|file:)?(?::memory:)?(?:\?.*)?$/i.test(connection_string)) {
		throw new Error("MCP inspection requires a file-backed SQLite database");
	}

	const [base, query = ""] = connection_string.split("?", 2);
	const params = new URLSearchParams(query);
	params.set("mode", "ro");
	return `${base}?${params.toString()}`;
}

function get_inspection_db(): SQL {
	if (inspection_db) { return inspection_db; }
	if (db_type !== "sqlite") {
		const read_only_connection = Bun.env.MCP_READONLY_CONNECTION_STRING;
		if (!read_only_connection) {
			throw new Error("MCP inspection with MySQL requires MCP_READONLY_CONNECTION_STRING for a SELECT-only database user");
		}
		inspection_db = new SQL(read_only_connection);
		return inspection_db;
	}

	inspection_db = new SQL(sqlite_read_only_url(DB_CONNECTION_STRING));
	return inspection_db;
}

function normalize_query_limit(limit: number): number {
	return Math.max(1, Math.min(Math.floor(limit) || 100, 1000));
}

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

// ---------------------------------------------------------------------------
// DB introspection
// ---------------------------------------------------------------------------

export async function list_db_tables(): Promise<TableInfo[]> {
	const inspection = get_inspection_db();
	if (db_type === "sqlite") {
		const tables = (await inspection`
			SELECT name, type FROM sqlite_master
			WHERE type IN ('table','view')
			AND name NOT LIKE 'sqlite_%'
			ORDER BY name
		`) as any[];

		const result: TableInfo[] = [];
		for (const t of tables) {
			const cols = (await inspection.unsafe(`PRAGMA table_info(${t.name})`)) as any[];
			result.push({
				name: t.name,
				type: t.type === "view" ? "view" : "table",
				column_count: cols.length,
			});
		}
		return result;
	}

	// MySQL
	const tables = (await inspection`
		SELECT TABLE_NAME AS name, TABLE_TYPE AS type
		FROM INFORMATION_SCHEMA.TABLES
		WHERE TABLE_SCHEMA = DATABASE()
		ORDER BY TABLE_NAME
	`) as any[];

	const result: TableInfo[] = [];
	for (const t of tables) {
		const cols = (await inspection`
			SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.COLUMNS
			WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${t.name}
		`) as any[];
		result.push({
			name: t.name,
			type: t.type === "VIEW" ? "view" : "table",
			column_count: Number(cols[0]?.cnt || 0),
		});
	}
	return result;
}

export async function get_table_structure(tableName: string): Promise<{ table: string; columns: ColumnInfo[]; }> {
	const inspection = get_inspection_db();
	if (db_type === "sqlite") {
		const exists = (await inspection`
			SELECT name FROM sqlite_master
			WHERE type IN ('table','view') AND name = ${tableName}
		`) as any[];
		if (exists.length === 0) throw new Error(`Table/view "${tableName}" not found`);

		const raw_cols = (await inspection.unsafe(`PRAGMA table_info(${tableName})`)) as any[];
		const raw_fks = (await inspection.unsafe(`PRAGMA foreign_key_list(${tableName})`)) as any[];

		const fkMap = new Map();
		for (const fk of raw_fks) {
			fkMap.set(fk.from, { table: fk.table, column: fk.to });
		}

		const columns: ColumnInfo[] = raw_cols.map((col) => ({
			name: col.name,
			type: col.type,
			nullable: col.notnull === 0,
			primary_key: col.pk > 0,
			auto_increment: col.pk > 0,
			default: col.dflt_value,
			foreign_key: fkMap.get(col.name) || null,
		}));

		return { table: tableName, columns };
	}

	// MySQL
	const exists = (await inspection`
		SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
		WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${tableName}
	`) as any[];
	if (exists.length === 0) throw new Error(`Table/view "${tableName}" not found`);

	const raw_cols = (await inspection`
		SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, EXTRA, COLUMN_DEFAULT
		FROM INFORMATION_SCHEMA.COLUMNS
		WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${tableName}
		ORDER BY ORDINAL_POSITION
	`) as any[];

	const raw_fks = (await inspection`
		SELECT kcu.COLUMN_NAME, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME
		FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
		JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
			ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
			AND kcu.TABLE_SCHEMA = tc.TABLE_SCHEMA
		WHERE kcu.TABLE_SCHEMA = DATABASE()
			AND kcu.TABLE_NAME = ${tableName}
			AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
	`) as any[];

	const fkMap = new Map();
	for (const fk of raw_fks) {
		fkMap.set(fk.COLUMN_NAME, { table: fk.REFERENCED_TABLE_NAME, column: fk.REFERENCED_COLUMN_NAME });
	}

	const columns: ColumnInfo[] = raw_cols.map((col) => ({
		name: col.COLUMN_NAME,
		type: col.COLUMN_TYPE,
		nullable: col.IS_NULLABLE === "YES",
		primary_key: col.COLUMN_KEY === "PRI",
		auto_increment: col.EXTRA?.includes("auto_increment") || false,
		default: col.COLUMN_DEFAULT,
		foreign_key: fkMap.get(col.COLUMN_NAME) || null,
	}));

	return { table: tableName, columns };
}

export async function run_read_only_query(query: string, limit = 100): Promise<{ columns: string[]; rows: any[]; row_count: number; truncated: boolean; }> {
	const safe_limit = normalize_query_limit(limit);
	const final_query = prepare_read_only_query(query, safe_limit);
	const raw = (await get_inspection_db().unsafe(final_query)) as any[];
	const rows = raw || [];
	const truncated = rows.length > safe_limit;
	const resultRows = rows.slice(0, safe_limit);
	const columns = resultRows.length > 0 ? Object.keys(resultRows[0]) : [];

	return { columns, rows: resultRows, row_count: resultRows.length, truncated };
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/** Naming/structure conventions sourced directly from config/db_structure.ts. */
function read_db_structure_conventions(): Record<string, any> {
	return {
		ignored_tables: [...IGNORE_TABLES],
		maintenance_fields: [...MAINTENANCE_FIELDS],
		date_suffixes: [...DATE_SUFIXES],
		datetime_suffixes: [...DATETIME_SUFIXES],
		boolean_prefixes: [...BOOLEAN_PREFIXES],
		ignore_index_fields: [...IGNORE_INDEX_FIELDS],
		ignore_order_fields: [...IGNORE_ORDER_FIELDS],
		currency_field: CURRENCY_FIELD,
		percent_field: PERCENT_FIELD,
		internal_table_prefix: INTERNAL_TABLE_PREFIX,
	};
}

export function get_db_config(): Record<string, any> {
	const conn_status = Bun.env.CONNECTION_STRING ? "(set)" : "(not set)";
	const conventions = read_db_structure_conventions();

	return {
		type: db_type,
		connection_string: conn_status,
		time_zone: Bun.env.TIME_ZONE || "UTC",
		conventions,
	};
}
