#!/usr/bin/env bun
/**
 * Check domain compliance - introspect the live DB and report columns that
 * don't match the canonical DOMAIN_TYPES taxonomy.
 *
 * After a successful check, if non-compliant columns were found, offers to
 * generate an ALTER TABLE SQL script to fix them.
 *
 * Follows the reeman standalone command pattern (cf. set_session_driver.ts).
 */

import { relative } from "node:path";

import { BOLD, color, confirm, CYAN, dim, GREEN, header, RED, show_cli_tip, YELLOW } from "./ui";

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function check_domain_compliance(): Promise<void> {
	header("Domain type compliance");

	console.log(`  ${dim("This will introspect the live database and check every column")}`);
	console.log(`  ${dim("against the canonical DOMAIN_TYPES taxonomy.")}`);
	console.log();

	const proceed = await confirm("Run domain compliance check?", "y");

	if (!proceed) {
		console.log(`  ${color("Cancelled.", YELLOW)}`);
		return;
	}

	console.log();

	let exit_code = 0;

	try {
		const checker = await import("$root/scripts/check_domain_compliance");
		exit_code = await checker.run_check();

		if (exit_code !== 0 && checker.last_non_compliant.length > 0) {
			console.log();
			const gen_sql = await confirm(`${color(String(checker.last_non_compliant.length), RED)} non-compliant column(s) found. Generate ALTER TABLE SQL script?`, "y");

			if (gen_sql) {
				try {
					const sql = await checker.generate_alter_sql_with_constraints(checker.last_non_compliant);
					const filepath = await checker.write_alter_sql(sql);
					const rel_path = relative(process.cwd(), filepath);
					console.log(`  ${color("\\u2713", GREEN)} SQL written to ${color(BOLD + rel_path, CYAN)}`);
					console.log(`  ${dim("Review before running against your database.")}`);
				} catch (err) {
					console.error(`  ${color("Error generating SQL:", RED)}`, err instanceof Error ? err.message : err);
				}
			}
		}
	} catch (err) {
		console.error(`\n  ${color("Error running compliance check:", RED)}`, err instanceof Error ? err.message : err);
		exit_code = 1;
	}

	if (exit_code === 0) {
		console.log(`  ${color("\\u2713 All columns comply with the domain type taxonomy.", GREEN)}`);
	} else {
		// Already printed results above; just add the CLI tip
	}

	console.log();
	show_cli_tip("bun scripts/check_domain_compliance.ts --verbose");
}
