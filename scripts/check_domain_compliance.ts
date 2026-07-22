/**
 * scripts/check_domain_compliance.ts
 *
 * Introspects the live database and reports all columns whose SQL type
 * doesn't match the canonical DOMAIN_TYPES taxonomy, plus columns that
 * couldn't be matched to any domain type at all.
 *
 * Usage:
 * bun scripts/check_domain_compliance.ts
 * bun scripts/check_domain_compliance.ts --verbose   # show compliant columns too
 *
 * Export:
 * run_check() - callable from reeman and other modules, returns exit code (0 = ok, 1 = issues found)
 *
 * The DB introspection queries live in ./domain_compliance/introspection.ts and
 * the ALTER TABLE script generation in ./domain_compliance/alter_sql.ts (the
 * latter re-exported here for the reeman). Output matches the Migration Gap
 * Inventory format from CONTEXT.md.
 */

import { db } from "$config/db";
import { IGNORE_TABLES, INTERNAL_TABLE_PREFIX, MAINTENANCE_FIELDS } from "$config/db_structure";
import { DOMAIN_TYPES as MYSQL_DT } from "$config/domain_types/mysql";
import { DOMAIN_TYPES as SQLITE_DT } from "$config/domain_types/sqlite";
import { db_type } from "$lib/resolve_db_type";
import { resolve_domain_type } from "$generator/schema/field_generator";
import { MySQLIntrospector } from "$generator/schema/mysql/mysql_introspector";
import { SQLiteIntrospector } from "$generator/schema/sqlite/sqlite_introspector";

import { type ColumnReport } from "./domain_compliance/introspection";

export { generate_alter_sql, generate_alter_sql_with_constraints, write_alter_sql } from "./domain_compliance/alter_sql";
export type { ColumnReport, FKConstraint, IndexOnColumn } from "./domain_compliance/introspection";

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

const RED = "\u001b[31m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const _CYAN = "\u001b[36m";
const BOLD = "\u001b[1m";
const RESET = "\u001b[0m";
const DIM = "\u001b[2m";

// Last non-compliant reports, set by run_check() for downstream use.
export let last_non_compliant: ColumnReport[] = [];
export let last_unknown: ColumnReport[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pad(s: string, n: number): string { return s + " ".repeat(Math.max(0, n - s.length)); }

// Get the canonical SQL for a domain type (current dialect).
function canonical_sql(domain: string): string | null {
	const map = db_type === "mysql" ? MYSQL_DT : SQLITE_DT;
	return (map as Record<string, string>)[domain] ?? null;
}

// ---------------------------------------------------------------------------
// Main check logic - exported for reuse from reeman and other modules
// ---------------------------------------------------------------------------

/**
 * Run the compliance check and print results to stdout.
 * @returns 0 if all columns are compliant, 1 if issues found.
 */
export async function run_check(): Promise<number> {
	const verbose = Bun.argv.includes("--verbose");

	console.log(`\n  ${BOLD}Domain Type Compliance Checker${RESET}  (${db_type.toUpperCase()})\n`);

	// --- Introspect ---

	const Introspector = db_type === "mysql" ? MySQLIntrospector : SQLiteIntrospector;
	const introspector = new Introspector(db);

	const all_schemas = await introspector.get_database_schema();

	// --- Analyse each column ---

	const reports: ColumnReport[] = [];
	let total_tables = 0;

	for (const schema of all_schemas) {
		if (schema.type !== "table") continue;
		if (schema.name.startsWith(INTERNAL_TABLE_PREFIX)) continue;
		if (IGNORE_TABLES.includes(schema.name as (typeof IGNORE_TABLES)[number])) continue;

		total_tables++;

		for (const col of schema.columns) {
			if (col.is_generated) continue;
			if (MAINTENANCE_FIELDS.includes(col.name.toLowerCase())) continue;

			const { domain, compliant } = resolve_domain_type(col.name, col.type_string);
			const expected = domain ? canonical_sql(domain) : null;

			let comment = "";
			if (domain && !compliant) { comment = `expected ${expected}`; }

			reports.push({
				table: schema.name,
				column: col.name,
				current_type: col.type_string,
				domain_type: domain,
				expected_sql: expected,
				compliant,
				comment,
				nullable: col.is_nullable,
			});
		}
	}

	// --- Categorise, store for downstream use ---

	last_non_compliant = reports.filter((r) => r.domain_type !== null && !r.compliant);
	last_unknown = reports.filter((r) => r.domain_type === null);
	const non_compliant = last_non_compliant;
	const unknown = last_unknown;
	const compliant = reports.filter((r) => r.domain_type !== null && r.compliant);

	// --- Print results ---

	if (non_compliant.length > 0) {
		print_section(`${RED}${BOLD}Non-compliant columns${RESET}`, `Name matches a domain type but SQL doesn't match the canonical type`, non_compliant);
	}

	if (unknown.length > 0) { print_section(`${YELLOW}${BOLD}Unknown columns${RESET}`, "No matching domain type found (not in taxonomy)", unknown); }

	if (verbose && compliant.length > 0) { print_section(`${GREEN}${BOLD}Compliant columns${RESET}`, "SQL matches the canonical domain type", compliant); }

	// --- Summary line ---

	const ok = compliant.length;
	const warn = non_compliant.length + unknown.length;
	const status = warn === 0 ? `${GREEN}✓` : `${RED}✗`;
	const status_msg = warn === 0 ? `${GREEN}All ${ok} columns match the canonical domain types.${RESET}` : `${RED}${warn} column(s) need attention.${RESET}`;

	console.log(`\n  ${status} ${BOLD}Summary:${RESET} ${total_tables} tables, ${reports.length} columns${RESET}`);
	console.log(`    ${GREEN}✓ ${pad(String(ok), 4)} compliant${RESET}${non_compliant.length > 0 ? `\n    ${RED}✗ ${pad(String(non_compliant.length), 4)} non-compliant${RESET}` : ""}${unknown.length > 0 ? `\n    ${YELLOW}? ${pad(String(
		unknown.length
	), 4)} unknown${RESET}` : ""}`);
	console.log(`  ${status_msg}\n`);

	if (warn > 0 && !verbose) { console.log(`  ${DIM}Pass --verbose to also see compliant columns.${RESET}\n`); }

	return warn > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Section printer
// ---------------------------------------------------------------------------

function print_section(header: string, subtitle: string, items: ColumnReport[]): void {
	console.log(`  ${header}`);
	console.log(`  ${DIM}${subtitle}${RESET}\n`);

	// Column widths
	const w_table = Math.max(8, ...items.map((r) => r.table.length));
	const w_col = Math.max(8, ...items.map((r) => r.column.length));
	const w_type = Math.max(10, ...items.map((r) => r.current_type.length));

	// Header row
	console.log(`  ${pad("Table", w_table)}  ${pad("Column", w_col)}  ${pad("Current Type", w_type)}  Domain Type  Expected SQL`);
	console.log(`  ${"-".repeat(w_table)}  ${"-".repeat(w_col)}  ${"-".repeat(w_type)}  ${"-".repeat(11)}  ${"-".repeat(25)}`);

	for (const r of items) {
		const domain = r.domain_type ?? "-";
		const expected = r.expected_sql ?? "-";
		const comment = r.comment ? `  ${DIM}// ${r.comment}${RESET}` : "";
		console.log(`  ${pad(r.table, w_table)}  ${pad(r.column, w_col)}  ${pad(r.current_type, w_type)}  ${pad(domain, 11)}  ${pad(expected, 25)}${comment}`);
	}

	console.log("");
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const stay_alive = setInterval(() => {}, 2_147_483_647);

	try {
		const code = await run_check();
		process.exit(code);
	} catch (err) {
		console.error(`\n  ${RED}${BOLD}Error:${RESET}`, err instanceof Error ? err.message : err, "\n");
		process.exit(1);
	} finally {
		clearInterval(stay_alive);
		db.close();
	}
}

if (import.meta.path === Bun.main) { main(); }
