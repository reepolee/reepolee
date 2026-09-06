#!/usr/bin/env bun
/**
 * reeman - the single entry point for the resource generator.
 *
 * Usage:
 *   bun generator/reeman.ts                  Interactive menu
 *   bun generator/reeman.ts <subcommand> ...  Non-interactive CLI (see reeman/cli.ts)
 *
 * Delegates to generator/reeman/cli.ts for scripted subcommands and
 * generator/reeman/index.ts for the interactive menu.
 */

import { invalidate_cache } from "./ddl_cache";
import { run_cli } from "./reeman/cli";
import { main } from "./reeman/index";
import { color, RED } from "./reeman/ui";

async function start() {
	// Every reeman run re-introspects the schema from scratch. Seed SQL is
	// often piped directly into sqlite3/mysql (outside reeman), so a cached
	// DDL snapshot from an earlier run can silently describe a schema that
	// no longer exists - invalidating up front is the only way every
	// subcommand can trust what it reads.
	invalidate_cache();

	// run_cli() only returns (false) when no subcommand was given - every
	// recognized subcommand exits the process itself once it's done.
	const has_subcommand = await run_cli(Bun.argv.slice(2));
	if (has_subcommand) return;
	await main();
}

start().catch((err) => {
	console.error(`${color("Unexpected error:", RED)}`, err);
	process.exit(1);
});
