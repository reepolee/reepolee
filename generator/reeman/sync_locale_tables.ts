#!/usr/bin/env bun
/**
 * reeman: sync locale tables.
 *
 * Creates, alters, and drops the per-locale clone tables so they match their
 * base table plus the configured locales. Idempotent - running it on a
 * converged schema reports "already in sync" and changes nothing.
 */

import { default_locale, locales } from "$config/supported_locales";

import { format_sync_actions, run_locale_table_sync } from "../locale_tables/run";
import { BOLD, color, CYAN, dim, GREEN, header, YELLOW } from "./ui";

export async function sync_locale_tables_command(table?: string, dry_run: boolean = false): Promise<boolean> {
	header("Sync locale tables");

	const non_default = (locales as readonly string[]).filter((locale) => locale !== default_locale);
	console.log(`  ${dim("default locale")} ${color(default_locale, CYAN)} ${dim("(base tables)")}`);
	console.log(`  ${dim("clone locales")}  ${non_default.length > 0 ? color(non_default.join(", "), CYAN) : dim("none")}`);
	console.log();

	if (non_default.length === 0) {
		console.log(`  ${dim("Only the default locale is configured - no clone tables are needed.")}`);
		return true;
	}

	const { results, localized_tables } = await run_locale_table_sync({ table, dry_run });

	if (localized_tables.length === 0) {
		console.log(`  ${dim("No table declares a localized: true column - nothing to sync.")}`);
		return true;
	}

	if (results.length === 0) {
		console.log(`  ${color(`No localized table named "${table}".`, YELLOW)}`);
		console.log(`  ${dim(`Localized tables: ${localized_tables.map((info) => info.table_name).join(", ")}`)}`);
		return false;
	}

	let total_actions = 0;
	for (const result of results) {
		const descriptions = format_sync_actions(result.actions);
		if (descriptions.length === 0) {
			console.log(`  ${color("✓", GREEN)} ${color(result.base_table, BOLD)} ${dim("already in sync")}`);
			continue;
		}

		total_actions += descriptions.length;
		console.log(`  ${color("→", CYAN)} ${color(result.base_table, BOLD)}`);
		for (const description of descriptions) {
			// Drops are called out: removing a locale or un-localizing a field
			// destroys that locale's content, and it must never look routine.
			const is_drop = description.startsWith("dropped");
			const line = is_drop ? color(description, YELLOW) : dim(description);
			console.log(`      ${line}`);
		}
	}

	console.log();
	if (dry_run) {
		console.log(`  ${color(`Dry run - ${total_actions} change(s) would be applied.`, YELLOW)}`);
		return true;
	}

	if (total_actions === 0) console.log(`  ${color("✓ Locale tables are in sync", GREEN)}`);
	else console.log(`  ${color(`✓ Applied ${total_actions} change(s)`, GREEN)}`);

	return true;
}
