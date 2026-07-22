/**
 * scripts/domain_compliance/alter_sql.ts
 *
 * ALTER TABLE migration-script generation for the domain-compliance checker.
 * `generate_alter_sql` is a pure formatter; `generate_alter_sql_with_constraints`
 * introspects FK constraints, indexes, and defaults (MySQL only) to produce a
 * production-ready script; `write_alter_sql` persists it under sql/<dialect>/.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { db_type } from "$lib/resolve_db_type";
import { uuid_v7 } from "$lib/uuid";

import {
	type ColumnReport,
	type FKConstraint,
	get_column_defaults,
	get_expression_defaults,
	get_fk_constraints,
	get_table_indexes,
} from "./introspection";

// Escape backticks in a MySQL identifier.
function escape_backtick(name: string): string { return name.replace(/`/g, "``"); }

/**
 * Generate ALTER TABLE MODIFY COLUMN statements for all non-compliant columns.
 * This is a pure (synchronous) function - no DB queries, no FK/index handling.
 * Use {@link generate_alter_sql_with_constraints} for a production-ready script
 * that introspects FK constraints and indexes.
 *
 * For MySQL: produces ALTER TABLE statements using MODIFY COLUMN.
 * For SQLite: produces comments explaining that SQLite does not support
 * inline type changes and shows the target type for manual migration.
 *
 * @param reports - Array of non-compliant column reports (from last_non_compliant).
 * @returns Complete SQL script as a string.
 */
export function generate_alter_sql(reports: ColumnReport[]): string {
	const lines: string[] = [];
	const is_mysql = db_type === "mysql";

	lines.push(`-- Domain type compliance fix`);
	lines.push(`-- Generated: ${new Date().toISOString()}`);
	lines.push(`-- Database: ${db_type.toUpperCase()}`);
	lines.push(`-- Columns to fix: ${reports.length}`);
	lines.push(`--`);
	lines.push(`-- Review before executing against your production database!`);
	lines.push("");

	if (!is_mysql) {
		lines.push("-- =========================================================================");
		lines.push("-- SQLite does not support ALTER TABLE MODIFY COLUMN to change column types.");
		lines.push("-- To migrate these columns, you need to recreate each table using:");
		lines.push("--   1. CREATE TABLE new_table (... with corrected types ...)");
		lines.push("--   2. INSERT INTO new_table SELECT * FROM old_table");
		lines.push("--   3. DROP TABLE old_table");
		lines.push("--   4. ALTER TABLE new_table RENAME TO old_table");
		lines.push("-- =========================================================================");
		lines.push("-- Target types are listed below for reference when recreating tables.");
		lines.push("");
	}

	// Group by table so ALTER statements for the same table are batched
	const by_table = new Map<string, ColumnReport[]>();
	for (const r of reports) {
		const existing = by_table.get(r.table) ?? [];
		existing.push(r);
		by_table.set(r.table, existing);
	}

	for (const [table, cols] of by_table) {
		if (is_mysql) {
			lines.push(`-- ${table}: ${cols.length} column(s)`);
			for (const c of cols) {
				const esc_table = escape_backtick(table);
				const esc_col = escape_backtick(c.column);
				const nullable = c.nullable ? "NULL" : "NOT NULL";
				lines.push(`ALTER TABLE \`${esc_table}\` MODIFY COLUMN \`${esc_col}\` ${c.expected_sql} ${nullable};`);
			}
			lines.push("");
		} else {
			lines.push(`-- ${table}`);
			for (const c of cols) {
				lines.push(`--   ${c.column}: ${c.current_type} → ${c.expected_sql}  (domain: ${c.domain_type})`);
			}
			lines.push("");
		}
	}

	return lines.join("\n");
}

/**
 * Generate an ALTER TABLE migration script that wraps MODIFY COLUMN statements
 * with DROP/ADD FOREIGN KEY constraints and notes about indexes that will
 * be preserved by MySQL.
 *
 * For MySQL:
 * 1. Introspects FK constraints on each affected table
 * 2. Produces DROP FOREIGN KEY -> MODIFY COLUMN -> ADD FOREIGN KEY wrapping
 * 3. Documents non-PK indexes on modified columns (MySQL preserves them)
 *
 * For SQLite: falls through to the basic {@link generate_alter_sql} output.
 *
 * @param reports - Array of non-compliant column reports (from last_non_compliant).
 * @returns Complete SQL script as a string with FK/index preservation.
 */
export async function generate_alter_sql_with_constraints(reports: ColumnReport[]): Promise<string> {
	if (db_type !== "mysql" || reports.length === 0) { return generate_alter_sql(reports); }

	const lines: string[] = [];
	const _is_mysql = true;

	lines.push(`-- Domain type compliance fix`);
	lines.push(`-- Generated: ${new Date().toISOString()}`);
	lines.push(`-- Database: ${db_type.toUpperCase()}`);
	lines.push(`-- Columns to fix: ${reports.length}`);
	lines.push(`--`);
	lines.push(`-- FK constraints are dropped before MODIFY and re-added after.`);
	lines.push(`-- The entire script is wrapped in SET FOREIGN_KEY_CHECKS = 0/1 to also`);
	lines.push(`-- handle FKs that reference this table from other tables.`);
	lines.push(`-- Indexes on modified columns are expected to be preserved by MySQL.`);
	lines.push(`-- Column defaults are preserved, including expression defaults (DEFAULT_GENERATED).`);
	lines.push(`-- Review before executing against your production database!`);
	lines.push("");

	// Wrap in FK check disable/re-enable for cross-table FK safety
	lines.push("-- =========================================================================");
	lines.push("-- Temporarily disable FK checks so MODIFY COLUMN works even when");
	lines.push("-- other tables reference the columns being changed.");
	lines.push("-- =========================================================================");
	lines.push("SET FOREIGN_KEY_CHECKS = 0;");
	lines.push("");

	// Group by table
	const by_table = new Map<string, ColumnReport[]>();
	for (const r of reports) {
		const existing = by_table.get(r.table) ?? [];
		existing.push(r);
		by_table.set(r.table, existing);
	}

	// Collect all column names per table so we can batch FK/index queries
	for (const [table, cols] of by_table) {
		const affected_columns = cols.map((c) => c.column);

		// 1. Introspect FK constraints on this table
		const all_fks = await get_fk_constraints(table);
		const relevant_fks = all_fks.filter((fk) => affected_columns.includes(fk.column));

		// Group FKs by constraint_name (for composite FKs)
		const fk_by_name = new Map<string, FKConstraint[]>();
		for (const fk of relevant_fks) {
			const existing = fk_by_name.get(fk.constraint_name) ?? [];
			existing.push(fk);
			fk_by_name.set(fk.constraint_name, existing);
		}

		// Determine which constraint names to drop (those with at least one affected column)
		const drop_fk_names = new Set([...fk_by_name.entries()].filter(([_, parts]) => parts.some((p) => affected_columns.includes(p.column))).map(([name]) => name));

		// Auto-generated FK indexes share the constraint name - exclude them
		const auto_index_names = new Set(drop_fk_names);

		// 2. Introspect indexes on this table
		const all_indexes = await get_table_indexes(table);
		const relevant_indexes = all_indexes.filter((idx) => affected_columns.includes(idx.column) && !auto_index_names.has(idx.index_name));

		// --- Generate SQL for this table ---

		lines.push(`-- ${table}: ${cols.length} column(s)`);

		const esc_table = escape_backtick(table);

		if (drop_fk_names.size > 0) {
			lines.push(`-- FK constraints: drop before modify, re-add after`);
			for (const name of drop_fk_names) {
				const esc_name = escape_backtick(name);
				lines.push(`ALTER TABLE \`${esc_table}\` DROP FOREIGN KEY \`${esc_name}\`;`);
			}
		}

		// 3. Introspect column default values (literal and expression)
		const defaults = await get_column_defaults(table);
		const expr_defaults = await get_expression_defaults(table, affected_columns);

		// MODIFY COLUMNs
		for (const c of cols) {
			const esc_col = escape_backtick(c.column);
			const nullable = c.nullable ? "NULL" : "NOT NULL";

			// Expression defaults take precedence over literal defaults
			const expr_default = expr_defaults.get(c.column);
			const literal_default = defaults.get(c.column);
			const default_clause = expr_default !== undefined ? ` DEFAULT (${expr_default})` : literal_default !== null && literal_default !== undefined ? ` DEFAULT ${literal_default}` : "";

			lines.push(`ALTER TABLE \`${esc_table}\` MODIFY COLUMN \`${esc_col}\` ${c.expected_sql} ${nullable}${default_clause};`);
		}

		// Re-add FKs
		if (drop_fk_names.size > 0) {
			for (const name of drop_fk_names) {
				const parts = fk_by_name.get(name)!;
				const col_definitions = parts.map((p) => "`" + escape_backtick(p.column) + "`").join(", ");
				const ref_cols = parts.map((p) => "`" + escape_backtick(p.referenced_column) + "`").join(", ");
				const ref_table = escape_backtick(parts[0].referenced_table);
				const esc_name = escape_backtick(name);
				lines.push(`ALTER TABLE \`${esc_table}\` ADD CONSTRAINT \`${esc_name}\` FOREIGN KEY (${col_definitions}) REFERENCES \`${ref_table}\` (${ref_cols});`);
			}
		}

		// Index notes
		if (relevant_indexes.length > 0) {
			// Group indexes by name for composite indexes
			const idx_by_name = new Map<string, string[]>();
			for (const idx of relevant_indexes) {
				const existing = idx_by_name.get(idx.index_name) ?? [];
				existing.push(idx.column);
				idx_by_name.set(idx.index_name, existing);
			}
			lines.push(`-- Indexed columns (expected to be preserved by MySQL during MODIFY COLUMN):`);
			for (const [name, idx_cols] of idx_by_name) {
				const _unique_tag = idx_cols.length > 1 ? "" : "";
				const col_list = idx_cols.map((c) => "`" + escape_backtick(c) + "`").join(", ");
				lines.push("--   Index `" + escape_backtick(name) + "` on (" + col_list + ")");
			}
		}

		lines.push("");
	}

	// Re-enable FK checks
	lines.push("-- =========================================================================");
	lines.push("-- Re-enable FK checks and verify integrity");
	lines.push("-- =========================================================================");
	lines.push("SET FOREIGN_KEY_CHECKS = 1;");
	lines.push("");
	lines.push("-- Verify FK integrity after migration:");
	lines.push("-- SELECT CONCAT('ALTER TABLE ', TABLE_NAME, ' VALIDATE CONSTRAINT ', CONSTRAINT_NAME) AS validation_query");
	lines.push("-- FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS");
	lines.push("-- WHERE CONSTRAINT_TYPE = 'FOREIGN KEY' AND TABLE_SCHEMA = DATABASE();");

	return lines.join("\n");
}

/**
 * Write a SQL script to a UUIDv7-named file in the appropriate sql/ subdirectory.
 *
 * @param sql - The SQL script content.
 * @returns The absolute path to the written file.
 */
export async function write_alter_sql(sql: string): Promise<string> {
	const sql_dir = join(process.cwd(), "sql", db_type);
	if (!existsSync(sql_dir)) { mkdirSync(sql_dir, { recursive: true }); }

	const filename = `${uuid_v7()}.sql`;
	const filepath = join(sql_dir, filename);

	await Bun.write(filepath, sql);
	return filepath;
}
