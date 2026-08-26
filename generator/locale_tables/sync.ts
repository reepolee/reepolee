/**
 * The locale-table syncer (D9).
 *
 * One idempotent operation owns "what a locale table looks like", so that
 * knowledge lives in executable code rather than spread across DDL emission,
 * migrations, and add-locale. Running it any number of times converges on the
 * same state - the same posture as refresh-crud: regenerate to correctness
 * rather than track migrations.
 */

import type { SQL } from "bun";

import { locale_hash_column, locale_source_column } from "../naming";
import type { SchemaObject } from "../schema/types";
import { add_column_ddl, create_table_ddl, drop_column_ddl, drop_table_ddl, type DbDialect } from "./ddl";
import { compare_locale_tables, type ActualTable, type Drift } from "./compare";
import { expected_locale_tables, type ExpectedTable } from "./expected_schema";

export interface SyncOptions {
	db: SQL;
	dialect: DbDialect;
	base_schema: SchemaObject;
	localized_field_names: readonly string[];
	locale_codes: readonly string[];
	default_locale_code: string;
	localized_tables: ReadonlySet<string>;
	/** Report what would change without touching the database. */
	dry_run?: boolean;
}

export interface SyncAction {
	kind: "create_table" | "drop_table" | "add_column" | "drop_column" | "backfill";
	table: string;
	column?: string;
	sql: string;
}

export interface SyncResult {
	base_table: string;
	actions: SyncAction[];
	drift_before: Drift[];
}

/** Physical locale tables that currently exist for this base table. */
async function read_actual_tables(db: SQL, dialect: DbDialect, expected: readonly ExpectedTable[]): Promise<Map<string, ActualTable>> {
	const actual = new Map<string, ActualTable>();

	for (const expected_table of expected) {
		const column_names = await read_column_names(db, dialect, expected_table.name);
		if (column_names === null) continue;
		actual.set(expected_table.name, { name: expected_table.name, column_names });
	}

	return actual;
}

/** Column names for a table, or null when the table does not exist. */
export async function read_column_names(db: SQL, dialect: DbDialect, table_name: string): Promise<string[] | null> {
	if (dialect === "sqlite") {
		const rows = (await db.unsafe(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [table_name])) as any[];
		if (rows.length === 0) return null;
		const columns = (await db.unsafe(`PRAGMA table_xinfo(${table_name})`)) as any[];
		return columns.map((column) => String(column.name));
	}

	const rows = (await db.unsafe(
		`SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
		[table_name],
	)) as any[];
	if (rows.length === 0) return null;
	return rows.map((row) => String(row.COLUMN_NAME ?? row.column_name));
}

/**
 * Generated columns are cloned by copying the base table's DDL for them: the
 * expression must be re-evaluated against the clone's own row, so `display`
 * on frameworks_sl_si computes from the Slovenian name, not the English one.
 */
async function generated_column_ddl(db: SQL, dialect: DbDialect, base_table: string): Promise<string[]> {
	if (dialect === "sqlite") {
		const rows = (await db.unsafe(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, [base_table])) as any[];
		const create_sql = String(rows[0]?.sql ?? "");
		if (!create_sql) return [];

		const lines = create_sql.split("\n");
		const generated_lines = lines.filter((line) => /GENERATED\s+ALWAYS/i.test(line));
		return generated_lines.map((line) => line.trim().replace(/,\s*$/, ""));
	}

	// MySQL keeps the expression in GENERATION_EXPRESSION rather than in a
	// CREATE TABLE string, so the column definition is rebuilt from the
	// catalogue. Without this a MySQL clone silently loses `display` and then
	// fails the display contract.
	const rows = (await db.unsafe(
		`SELECT COLUMN_NAME, COLUMN_TYPE, GENERATION_EXPRESSION, EXTRA
		 FROM information_schema.COLUMNS
		 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND GENERATION_EXPRESSION <> ''
		 ORDER BY ORDINAL_POSITION`,
		[base_table],
	)) as any[];

	return rows.map((row) => {
		const name = String(row.COLUMN_NAME ?? row.column_name);
		const type = String(row.COLUMN_TYPE ?? row.column_type);
		const expression = String(row.GENERATION_EXPRESSION ?? row.generation_expression);
		const extra = String(row.EXTRA ?? row.extra ?? "").toUpperCase();
		const storage = extra.includes("STORED") ? "STORED" : "VIRTUAL";
		return `\`${name}\` ${type} GENERATED ALWAYS AS (${expression}) ${storage}`;
	});
}

/**
 * Triggers defined on the base table, rewritten for a clone.
 *
 * Triggers live outside the column/constraint metadata the rest of the syncer
 * reads, so they are easy to miss - and missing them is silent: the base
 * table's `updated_at` refreshes on write while every clone's stays frozen at
 * whatever the fan-out inserted. A trigger can also carry arbitrary business
 * logic, which would then apply to the default locale only.
 */
async function trigger_ddl(db: SQL, dialect: DbDialect, base_table: string, clone_table: string): Promise<string[]> {
	if (dialect !== "sqlite") {
		// MySQL trigger bodies come back without a usable CREATE statement and
		// need DELIMITER handling to replay. Left unhandled deliberately rather
		// than half-done - see the MySQL caveat in the plan.
		return [];
	}

	const rows = (await db.unsafe(
		`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`,
		[base_table],
	)) as any[];

	const statements: string[] = [];
	for (const row of rows) {
		const trigger_name = String(row.name ?? "");
		const trigger_sql = String(row.sql ?? "");
		if (!trigger_name || !trigger_sql) continue;

		const clone_trigger = trigger_name.replace(base_table, clone_table);
		// Rewrite the trigger's own name and every reference to the base table.
		// \b keeps `frameworks` from matching inside `frameworks_sl_si` on a
		// re-run, and the trigger name is replaced first so it is not caught by
		// the table pass.
		let rewritten = trigger_sql.replace(new RegExp(`\\b${trigger_name}\\b`, "g"), clone_trigger);
		rewritten = rewritten.replace(new RegExp(`\\b${base_table}\\b(?!_)`, "g"), clone_table);

		statements.push(`DROP TRIGGER IF EXISTS "${clone_trigger}"`);
		statements.push(rewritten);
	}

	return statements;
}

/**
 * Column defaults, read from the base table's DDL.
 *
 * Introspection reads defaults from PRAGMA but drops them before they reach
 * ColumnDef, and widening that shared type for one consumer is not worth it.
 * A default matters here because a NOT NULL column fed by its default
 * (created_at) is never supplied by the write fan-out - without the default
 * the clone insert fails outright.
 */
async function column_defaults(db: SQL, dialect: DbDialect, base_table: string): Promise<Map<string, string>> {
	const defaults = new Map<string, string>();

	if (dialect === "sqlite") {
		const columns = (await db.unsafe(`PRAGMA table_xinfo(${base_table})`)) as any[];
		for (const column of columns) {
			if (column.dflt_value === null || column.dflt_value === undefined) continue;
			defaults.set(String(column.name), String(column.dflt_value));
		}
		return defaults;
	}

	const rows = (await db.unsafe(
		`SELECT COLUMN_NAME, COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
		[base_table],
	)) as any[];
	for (const row of rows) {
		const value = row.COLUMN_DEFAULT ?? row.column_default;
		if (value === null || value === undefined) continue;
		defaults.set(String(row.COLUMN_NAME ?? row.column_name), String(value));
	}
	return defaults;
}

/**
 * Build the CREATE TABLE for a clone, re-inserting the base table's generated
 * columns verbatim (create_table_ddl skips them - it has no access to the
 * expressions).
 */
async function build_create_table(db: SQL, dialect: DbDialect, table: ExpectedTable): Promise<string> {
	const [generated_lines, defaults] = await Promise.all([
		generated_column_ddl(db, dialect, table.base_table),
		column_defaults(db, dialect, table.base_table),
	]);

	const with_defaults: ExpectedTable = {
		...table,
		columns: table.columns.map((column) => {
			const default_value = defaults.get(column.name);
			if (default_value === undefined) return column;
			return { ...column, default_value };
		}),
	};

	return create_table_ddl(with_defaults, dialect, generated_lines);
}

/** Trigger names currently attached to a clone table. */
async function existing_trigger_names(db: SQL, dialect: DbDialect, clone_table: string): Promise<Set<string>> {
	if (dialect !== "sqlite") return new Set();
	const rows = (await db.unsafe(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`, [clone_table])) as any[];
	return new Set(rows.map((row) => String(row.name)));
}

/** Trigger names a clone should have, derived from the base table's. */
async function wanted_trigger_names(db: SQL, dialect: DbDialect, base_table: string, clone_table: string): Promise<string[]> {
	if (dialect !== "sqlite") return [];
	const rows = (await db.unsafe(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`, [base_table])) as any[];
	return rows.map((row) => String(row.name).replace(base_table, clone_table));
}

/**
 * Copy every base row into a freshly created clone. A clone always carries a
 * full row for every record (D3/D7) - untranslated locales just hold a copy
 * of the base content until edited, so there is no "missing translation" row
 * state to represent.
 */
function backfill_sql(table: ExpectedTable, dialect: DbDialect): string {
	const quote = dialect === "mysql" ? (name: string) => `\`${name}\`` : (name: string) => `"${name}"`;
	const copied = table.columns.filter((column) => !column.is_sidecar && !column.is_generated);
	const column_list = copied.map((column) => quote(column.name)).join(", ");
	return `INSERT INTO ${quote(table.name)} (${column_list}) SELECT ${column_list} FROM ${quote(table.base_table)}`;
}

/** Fill a newly added column on existing clone rows from the base table. */
function backfill_column_sql(table: ExpectedTable, column_name: string, dialect: DbDialect): string {
	const quote = dialect === "mysql" ? (name: string) => `\`${name}\`` : (name: string) => `"${name}"`;
	const target = quote(table.name);
	const base = quote(table.base_table);
	const column = quote(column_name);
	return `UPDATE ${target} SET ${column} = (SELECT ${base}.${column} FROM ${base} WHERE ${base}.${quote("id")} = ${target}.${quote("id")})`;
}

export async function sync_locale_tables(options: SyncOptions): Promise<SyncResult> {
	const { db, dialect, base_schema, localized_field_names, locale_codes, default_locale_code, localized_tables, dry_run = false } = options;

	const expected = expected_locale_tables({
		base_schema,
		localized_field_names,
		locale_codes,
		default_locale_code,
		localized_tables,
	});

	const actual = await read_actual_tables(db, dialect, expected);
	const stale = await find_stale_tables(db, dialect, base_schema.name, expected);
	for (const [name, table] of stale) actual.set(name, table);

	const drift_before = compare_locale_tables({ expected, actual, base_table: base_schema.name });
	const actions: SyncAction[] = [];
	const sidecar_names = new Set<string>();
	for (const field_name of localized_field_names) {
		sidecar_names.add(locale_source_column(field_name));
		sidecar_names.add(locale_hash_column(field_name));
	}

	for (const expected_table of expected) {
		const actual_table = actual.get(expected_table.name);

		if (!actual_table) {
			const create_sql = await build_create_table(db, dialect, expected_table);
			actions.push({ kind: "create_table", table: expected_table.name, sql: create_sql });
			actions.push({ kind: "backfill", table: expected_table.name, sql: backfill_sql(expected_table, dialect) });
			continue;
		}

		const actual_columns = new Set(actual_table.column_names);
		for (const column of expected_table.columns) {
			if (actual_columns.has(column.name)) continue;
			if (column.is_generated) continue;
			actions.push({ kind: "add_column", table: expected_table.name, column: column.name, sql: add_column_ddl(expected_table.name, column, dialect) });
			// Sidecars start NULL, which correctly reads as "authored here".
			// Content columns are copied from the base so the clone stays full.
			if (!column.is_sidecar) {
				actions.push({ kind: "backfill", table: expected_table.name, column: column.name, sql: backfill_column_sql(expected_table, column.name, dialect) });
			}
		}

		const expected_columns = new Set(expected_table.columns.map((column) => column.name));
		for (const column_name of actual_table.column_names) {
			if (expected_columns.has(column_name)) continue;
			actions.push({ kind: "drop_column", table: expected_table.name, column: column_name, sql: drop_column_ddl(expected_table.name, column_name, dialect) });
		}
	}

	// Tables for locales no longer configured, or for a table that stopped
	// being localized. Dropping is correct per "no backwards compatibility",
	// but the caller reports it - never silent.
	const expected_names = new Set(expected.map((table) => table.name));
	for (const [actual_name] of actual) {
		if (expected_names.has(actual_name)) continue;
		actions.push({ kind: "drop_table", table: actual_name, sql: drop_table_ddl(actual_name, dialect) });
	}

	// Triggers on the base table apply to that table only, so each clone needs
	// its own copy. Emitted only when missing, so a converged schema still
	// reports no actions.
	for (const expected_table of expected) {
		const statements = await trigger_ddl(db, dialect, base_schema.name, expected_table.name);
		if (statements.length === 0) continue;

		const existing = await existing_trigger_names(db, dialect, expected_table.name);
		const wanted = await wanted_trigger_names(db, dialect, base_schema.name, expected_table.name);
		const all_present = wanted.every((name) => existing.has(name));
		if (all_present) continue;

		for (const sql of statements) {
			actions.push({ kind: "create_table", table: expected_table.name, sql });
		}
	}

	// Per-locale views mirror per-locale tables: v_frameworks_sl_si is
	// v_frameworks with every reference to a localized table swapped for that
	// locale's clone. Rebuilt unconditionally - a view is cheap to drop and
	// recreate, and that keeps it correct after any base-view change.
	const view_actions = await build_view_actions(db, dialect, base_schema.name, expected, localized_tables);
	actions.push(...view_actions);

	if (!dry_run) {
		for (const action of actions) {
			await db.unsafe(action.sql);
		}
	}

	return { base_table: base_schema.name, actions, drift_before };
}

/**
 * Recreate each locale's view from the base view's definition, rewriting the
 * table names it reads. The base view already shapes columns for consumers,
 * so a locale view is the same shape over that locale's rows.
 */
async function build_view_actions(
	db: SQL,
	dialect: DbDialect,
	base_table: string,
	expected: readonly ExpectedTable[],
	localized_tables: ReadonlySet<string>,
): Promise<SyncAction[]> {
	if (dialect !== "sqlite") return [];

	const base_view = `v_${base_table}`;
	const expected_view_names = new Set(expected.map((table) => `${base_view}_${table.name.slice(base_table.length + 1)}`));

	const actions: SyncAction[] = [];

	// Drop per-locale views whose clone table is no longer expected - the
	// locale was removed or the table stopped being localized. find_stale_tables
	// drops the clone tables; their views must go too, or they become broken
	// views pointing at a table that no longer exists (introspection then logs
	// "no such table" on every page load).
	for (const view_name of await find_stale_views(db, base_view, expected_view_names)) {
		actions.push({ kind: "drop_table", table: view_name, sql: `DROP VIEW IF EXISTS "${view_name}"` });
	}

	if (expected.length === 0) return actions;

	const rows = (await db.unsafe(`SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?`, [base_view])) as any[];
	const base_sql = String(rows[0]?.sql ?? "");
	if (!base_sql) return actions;

	for (const expected_table of expected) {
		const suffix = expected_table.name.slice(base_table.length + 1);
		const view_name = `${base_view}_${suffix}`;
		let view_sql = base_sql.replace(new RegExp(`CREATE\\s+VIEW\\s+"?${base_view}"?`, "i"), `CREATE VIEW "${view_name}"`);

		// Point the view at this locale's tables. Longest names first so
		// `developers` does not partially rewrite inside `developers_sl_si`.
		const rewrite_targets = [base_table, ...localized_tables].filter((name, index, list) => list.indexOf(name) === index);
		rewrite_targets.sort((left, right) => right.length - left.length);

		for (const target of rewrite_targets) {
			view_sql = view_sql.replace(new RegExp(`\\b${target}\\b(?!_)`, "g"), `${target}_${suffix}`);
		}

		// Only rebuild when missing or stale, so a converged schema still
		// reports no actions and the syncer stays idempotent.
		const existing = (await db.unsafe(`SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?`, [view_name])) as any[];
		const current_sql = existing.length > 0 ? String(existing[0]?.sql ?? "") : "";
		if (current_sql === view_sql) continue;

		if (current_sql) actions.push({ kind: "drop_table", table: view_name, sql: `DROP VIEW IF EXISTS "${view_name}"` });
		actions.push({ kind: "create_table", table: view_name, sql: view_sql });
	}

	return actions;
}

/**
 * Per-locale views (`v_<base>_<suffix>`) that no longer correspond to an
 * expected clone table. Mirrors find_stale_tables so a removed locale's view
 * is dropped alongside its table; is_locale_suffixed guards against unrelated
 * same-prefix views such as `v_frameworks_summary`.
 */
async function find_stale_views(db: SQL, base_view: string, expected_view_names: ReadonlySet<string>): Promise<string[]> {
	const like_pattern = `${base_view}_%`;
	const candidates = (await db.unsafe(`SELECT name FROM sqlite_master WHERE type = 'view' AND name LIKE ?`, [like_pattern])) as any[];

	const stale: string[] = [];
	for (const candidate of candidates) {
		const name = String(candidate.name ?? candidate);
		if (expected_view_names.has(name)) continue;
		if (!is_locale_suffixed(name, base_view)) continue;
		stale.push(name);
	}
	return stale;
}

/**
 * Clone tables that exist for locales no longer configured. Found by probing
 * every configured locale's name plus scanning for the base table's suffix
 * pattern, so a removed locale's table is still discovered.
 */
async function find_stale_tables(
	db: SQL,
	dialect: DbDialect,
	base_table: string,
	expected: readonly ExpectedTable[],
): Promise<Map<string, ActualTable>> {
	const stale = new Map<string, ActualTable>();
	const expected_names = new Set(expected.map((table) => table.name));

	// `_` is a LIKE wildcard, but escaping it needs an ESCAPE clause that the
	// two dialects spell differently. The pattern is deliberately loose and
	// is_locale_suffixed() below does the real filtering, so an over-broad
	// match here costs one extra name to reject.
	const like_pattern = `${base_table}_%`;
	const candidates = dialect === "sqlite"
		? ((await db.unsafe(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ?`, [like_pattern])) as any[]).map((row) => String(row.name))
		: ((await db.unsafe(
			`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE ?`,
			[like_pattern],
		)) as any[]).map((row) => String(row.TABLE_NAME ?? row.table_name));

	for (const candidate of candidates) {
		if (expected_names.has(candidate)) continue;
		if (!is_locale_suffixed(candidate, base_table)) continue;
		const column_names = await read_column_names(db, dialect, candidate);
		if (column_names === null) continue;
		stale.set(candidate, { name: candidate, column_names });
	}

	return stale;
}

/**
 * Whether `candidate` looks like a locale clone of `base_table` rather than an
 * unrelated table that merely shares the prefix (e.g. `orders` vs
 * `orders_archive`). A locale segment is 2-3 alphanumeric groups joined by
 * underscores, which covers "sl_si", "de_at_1996" and "zh_hans_cn".
 */
function is_locale_suffixed(candidate: string, base_table: string): boolean {
	if (!candidate.startsWith(`${base_table}_`)) return false;
	const suffix = candidate.slice(base_table.length + 1);
	return /^[a-z]{2,3}(_[a-z0-9]{2,4}){1,2}$/.test(suffix);
}
