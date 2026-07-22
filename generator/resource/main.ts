#!/usr/bin/env bun

import { normalize_prefix } from "$lib/route";

import { discover_existing_crud_tables, get_available_db_tables, get_generated_table_schemas } from "./db";
import { parse_resource_args } from "./flags";
import { sync_translations_if_needed, validate_parent_crud } from "./helpers";
import { run_crud_batch, run_crud_generation, run_schema_generation } from "./runner";

const { command, param, flags } = parse_resource_args(process.argv.slice(2));

if (!command) {
	console.error("Error: Please provide a command or table name");
	console.error("");
	console.error("Usage:");
	console.error("  bun generator/resource.ts schema <table | all | all-tables>  Generate schema(s) only");
	console.error("  bun generator/resource.ts crud    <table | all>              Generate CRUD from existing schemas");
	console.error("  bun generator/resource.ts all                                Full pipeline: schema all-tables + crud all");
	console.error("  bun generator/resource.ts bulk  [--prefix <dir>]               Auto-detect tables without CRUD and batch-generate all");
	console.error("  bun generator/resource.ts <table>                            Full pipeline: schema + crud for a single table");
	console.error("");
	console.error("Flags:");
	console.error("  --force              Overwrite existing files without prompting");
	console.error("  --translate          Auto-translate generated JSON files via OpenRouter AI");
	console.error("  --prefix <dir>       Nest routes under a subdirectory (e.g. --prefix admin)");
	console.error("  --pagination <type>  Pagination strategy: 'cursor' or 'offset' (default: offset)");
	console.error("  --route-name <name>  Custom route name for URL (defaults to table_name)");
	console.error("");
	console.error("  bun generator/resource.ts schema all");
	console.error("  bun generator/resource.ts crud users");
	console.error("  bun generator/resource.ts all --translate");
	console.error("  bun generator/resource.ts users --prefix admin");
	console.error("  bun generator/resource.ts users --pagination cursor");
	console.error("  bun generator/resource.ts bulk --prefix system");
	console.error("  bun generator/resource.ts items --parent orders        Nested CRUD (child table with FK to parent)");
	console.error("  bun generator/resource.ts items --parent orders --prefix admin");
	process.exit(1);
}

// Narrowed after the usage guard above - safe to treat as string inside main().
const cli_command: string = command;

const { clean: clean_prefix } = normalize_prefix(flags.prefix);

/**
 * Route directory a single-table generation writes into - used to scope the
 * post-generation translation sync.
 */
function touched_dirs(table: string): string[] {
	const dir_name = flags.route_name || table;
	if (flags.parent) {
		// Nested child - only the child dir needs translation
		const child_dir = clean_prefix ? `routes/${clean_prefix}/${flags.parent}/${dir_name}` : `routes/${flags.parent}/${dir_name}`;
		return [child_dir];
	}
	const route_dir = clean_prefix ? `routes/${clean_prefix}/${dir_name}` : `routes/${dir_name}`;
	return [route_dir, "routes"];
}

// Main execution
async function main() {
	if (cli_command === "schema") {
		if (!param) {
			console.error("Error: schema command requires a target (table name, 'all', or 'all-tables')");
			process.exit(1);
		}
		const schema_target = param === "all" ? "all-tables" : param;
		const success = await run_schema_generation(schema_target, flags);
		if (success) {
			// Scoped dirs for single-table schema generation
			const schema_dirs = param !== "all" && param !== "all-tables" ? touched_dirs(param) : undefined;
			sync_translations_if_needed(flags, schema_dirs);
		}
		process.exit(success ? 0 : 1);
	} else if (cli_command === "crud") {
		if (!param) {
			console.error("Error: crud command requires a target (table name or 'all')");
			process.exit(1);
		}

		// Validate parent CRUD exists if --parent is specified
		if (flags.parent && !validate_parent_crud(flags.parent, flags)) { process.exit(1); }

		let tables_to_generate: string[] = [];

		if (param === "all") {
			tables_to_generate = get_generated_table_schemas();
			if (tables_to_generate.length === 0) {
				console.log("No generated schemas found. Run 'bun generator/resource.ts schema all' first.");
				process.exit(1);
			}
		} else {
			tables_to_generate = [param];
		}

		console.log(`Found ${tables_to_generate.length} schema(s) to generate CRUD for:`);
		tables_to_generate.forEach((t) => console.log(`  - ${t}`));
		console.log();

		const success_count = await run_crud_batch(tables_to_generate, flags);

		console.log(`${"=".repeat(50)}`);
		console.log(`Complete: ${success_count}/${tables_to_generate.length} CRUD generated`);
		console.log(`${"=".repeat(50)}`);

		// Scoped dirs for single-table CRUD generation
		const crud_dirs = param !== "all" ? touched_dirs(param) : undefined;
		sync_translations_if_needed(flags, crud_dirs);
		process.exit(success_count === tables_to_generate.length ? 0 : 1);
	} else if (cli_command === "bulk") {
		console.log("Starting bulk CRUD generation...\n");

		// Get all DB tables
		const all_db_tables = await get_available_db_tables();
		if (all_db_tables.length === 0) {
			console.error("✗ No tables found in database.");
			process.exit(1);
		}
		console.log(`Found ${all_db_tables.length} table(s) in database.`);

		// Discover tables that already have CRUD folders
		const existing_crud = discover_existing_crud_tables();
		const existing_names = new Set(existing_crud);

		const available_tables = all_db_tables.filter((t) => !existing_names.has(t));

		if (available_tables.length === 0) {
			console.log("All database tables already have CRUD folders. Nothing to generate.");
			process.exit(0);
		}

		console.log(`  ${existing_crud.length} table(s) already have CRUD (skipped)`);
		console.log(`  ${available_tables.length} table(s) to generate:`);
		available_tables.forEach((t) => console.log(`    - ${t}`));
		console.log();

		let success_count = 0;
		let fail_count = 0;

		// Bulk always forces - it only targets tables without existing CRUD
		const bulk_flags = { ...flags, force: true };

		for (let i = 0; i < available_tables.length; i++) {
			const table = available_tables[i]!;
			console.log(`[${i + 1}/${available_tables.length}] Processing: ${table}`);

			// Step 1: Schema generation
			console.log(`  Step 1: Generating schema for ${table}...`);
			const schema_ok = await run_schema_generation(table, bulk_flags);

			if (!schema_ok) {
				console.error(`  ✗ Schema generation failed for ${table}`);
				fail_count++;
				continue;
			}

			// Step 2: CRUD generation
			console.log(`  Step 2: Generating CRUD for ${table}...`);
			const crud_ok = await run_crud_generation(table, bulk_flags);

			if (crud_ok) {
				console.log(`  ✓ ${table} complete`);
				success_count++;
			} else {
				console.error(`  ✗ CRUD generation failed for ${table}`);
				fail_count++;
			}
		}

		console.log(`${"=".repeat(50)}`);
		console.log(`Bulk CRUD complete: ${success_count}/${available_tables.length} generated`);
		if (fail_count > 0) { console.log(`  ${fail_count} failed`); }
		console.log(`${"=".repeat(50)}`);

		// Bulk touches many tables - translate all
		sync_translations_if_needed(flags);
		process.exit(fail_count > 0 ? 1 : 0);
	} else if (cli_command === "all") {
		console.log("Starting full generation pipeline...\n");

		const schema_success = await run_schema_generation("all", flags);
		if (!schema_success) { process.exit(1); }

		const tables = get_generated_table_schemas();
		console.log(`Found ${tables.length} table(s) in routes/:`);
		tables.forEach((t) => console.log(`  - ${t}`));
		console.log();

		if (tables.length === 0) {
			console.warn("⚠  No tables found in database or routes/ directory.");
			process.exit(0);
		}

		console.log(`\nGenerating CRUD for ${tables.length} table(s)...\n`);

		const success_count = await run_crud_batch(tables, flags);

		console.log(`${"=".repeat(50)}`);
		console.log(`Pipeline complete: ${success_count}/${tables.length} CRUD generated`);
		console.log(`${"=".repeat(50)}`);

		// All tables pipeline - translate all
		sync_translations_if_needed(flags);

		// Formatting handled per-directory in crud.ts, including routes.ts after deferred write
	} else {
		const table = cli_command;

		// Validate parent CRUD exists if --parent is specified
		if (flags.parent && !validate_parent_crud(flags.parent, flags)) { process.exit(1); }

		console.log(`Starting generation pipeline for table: ${table}\n`);

		console.log("Step 1: Generating schema...");
		const schema_success = await run_schema_generation(table, flags);
		if (!schema_success) { process.exit(1); }

		console.log("Step 2: Generating CRUD...\n");
		const crud_success = await run_crud_generation(table, flags);

		console.log(`${"=".repeat(50)}`);
		if (crud_success) {
			console.log(`✓ Pipeline complete: ${table} fully generated`);
			// Single table pipeline - scope translation to touched dirs
			sync_translations_if_needed(flags, touched_dirs(table));
		} else {
			console.log(`✗ Pipeline failed: ${table} generation had errors`);
		}
		console.log(`${"=".repeat(50)}`);

		process.exit(crud_success ? 0 : 1);
	}
}

main();
