#!/usr/bin/env bun
/**
 * One-shot migration: localized_values EAV rows -> per-locale clone tables.
 *
 * Step 8 of PLAN_locale_suffixed_tables. Runs after the syncer has created the
 * clone tables (it calls the syncer itself), then for each non-default locale
 * copies that locale's overrides from localized_values into the clone's own
 * columns, carrying copy provenance into the <field>_src / <field>_hash
 * sidecars.
 *
 * Usage:
 *   bun scripts/migrate_localized_values.ts [--dry-run] [--drop]
 *
 *   --dry-run  report what would be written, touch nothing
 *   --drop     drop the localized_values table once migration succeeds
 *
 * Safe to re-run: the clone row already exists (the syncer backfills it from
 * the base table), so this only overwrites the fields that actually have an
 * override row.
 */

import { parseArgs } from "node:util";

import { db } from "$config/db";
import { default_locale, locales } from "$config/supported_locales";
import { db_type } from "$lib/resolve_db_type";
import { locale_table } from "$lib/locale_tables";
import { hash_localized_value } from "$lib/localized_hash";

import { discover_localized_tables, run_locale_table_sync } from "../generator/locale_tables/run";

const VALUE_COLUMNS = ["text_value", "integer_value", "decimal_value", "boolean_value", "date_value", "datetime_value", "json_value"] as const;

interface LegacyRow {
	table_name: string;
	record_id: number;
	field_name: string;
	locale_code: string;
	copied_from_locale: string | null;
	copied_source_hash: string | null;
	[key: string]: unknown;
}

function quote(identifier: string): string {
	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) throw new Error(`Unsafe SQL identifier: ${identifier}`);
	return db_type === "mysql" ? `\`${identifier}\`` : `"${identifier}"`;
}

/** The one value column an EAV row actually populated. */
function row_value(row: LegacyRow): unknown {
	for (const column of VALUE_COLUMNS) {
		const value = row[column];
		if (value !== null && value !== undefined) return value;
	}
	return null;
}

async function localized_values_exists(): Promise<boolean> {
	if (db_type === "sqlite") {
		const rows = (await db.unsafe(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'localized_values'`)) as any[];
		return rows.length > 0;
	}
	const rows = (await db.unsafe(`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'localized_values'`)) as any[];
	return rows.length > 0;
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: { "dry-run": { type: "boolean", default: false }, drop: { type: "boolean", default: false } },
		strict: false,
	});
	const dry_run = Boolean(values["dry-run"]);
	const drop_after = Boolean(values.drop);

	console.log(`\nMigrating localized_values -> locale tables${dry_run ? " (dry run)" : ""}\n`);

	if (!(await localized_values_exists())) {
		console.log("  localized_values does not exist - nothing to migrate.");
		return;
	}

	// The clone tables must exist before anything can be copied into them.
	console.log("  Ensuring locale tables exist...");
	const { results } = await run_locale_table_sync({ dry_run });
	for (const result of results) {
		if (result.actions.length > 0) console.log(`    ${result.base_table}: ${result.actions.length} change(s)`);
	}

	const localized_tables = await discover_localized_tables();
	const localized_by_table = new Map(localized_tables.map((info) => [info.table_name, info.localized_field_names]));
	if (localized_by_table.size === 0) {
		console.log("  No table declares a localized: true column - nothing to migrate.");
		return;
	}

	const legacy_rows = (await db.unsafe(`SELECT * FROM localized_values`)) as LegacyRow[];
	console.log(`  Found ${legacy_rows.length} localized_values row(s)\n`);

	// Group by (table, record, locale) so each clone row is written once with
	// every field it overrides, rather than one UPDATE per field.
	const grouped = new Map<string, LegacyRow[]>();
	for (const row of legacy_rows) {
		const key = `${row.table_name}|${row.record_id}|${row.locale_code}`;
		const bucket = grouped.get(key) ?? [];
		bucket.push(row);
		grouped.set(key, bucket);
	}

	const configured = new Set((locales as readonly string[]).filter((locale) => locale !== default_locale));
	let written = 0;
	let skipped = 0;

	for (const [key, rows] of grouped) {
		const [table_name, record_id_text, locale_code] = key.split("|") as [string, string, string];
		const record_id = Number(record_id_text);

		const known_fields = localized_by_table.get(table_name);
		if (!known_fields) { skipped += rows.length; continue; }
		if (!configured.has(locale_code)) { skipped += rows.length; continue; }

		const target = locale_table(table_name, locale_code);
		const assignments: string[] = [];
		const params: unknown[] = [];

		for (const row of rows) {
			if (!known_fields.includes(row.field_name)) { skipped++; continue; }
			const value = row_value(row);
			if (value === null) { skipped++; continue; }

			assignments.push(`${quote(row.field_name)} = ?`);
			params.push(value);

			// Copy provenance carries over verbatim where it exists; the stored
			// hash stays valid because it hashes the same source value.
			assignments.push(`${quote(`${row.field_name}_src`)} = ?`, `${quote(`${row.field_name}_hash`)} = ?`);
			params.push(row.copied_from_locale ?? null, row.copied_source_hash ?? (row.copied_from_locale ? hash_localized_value(value) : null));
			written++;
		}

		if (assignments.length === 0) continue;

		const sql = `UPDATE ${quote(target)} SET ${assignments.join(", ")} WHERE ${quote("id")} = ?`;
		if (dry_run) {
			console.log(`    would update ${target} id=${record_id} (${rows.length} field(s))`);
			continue;
		}
		await db.unsafe(sql, [...params, record_id]);
	}

	console.log(`\n  ${dry_run ? "Would write" : "Wrote"} ${written} field value(s), skipped ${skipped}\n`);

	if (drop_after && !dry_run) {
		await db.unsafe(`DROP TABLE localized_values`);
		console.log("  Dropped localized_values\n");
	} else if (drop_after) {
		console.log("  Would drop localized_values\n");
	} else {
		console.log("  localized_values kept - re-run with --drop once the data looks right.\n");
	}
}

await main();
