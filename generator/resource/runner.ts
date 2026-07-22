import { generate_crud } from "../crud/main";
import { generate_schema } from "../schema";
import type { ResourceFlags } from "./flags";

export async function run_schema_generation(target: string, flags: ResourceFlags): Promise<boolean> {
	console.log(`Generating schema(s): ${target}...`);

	const success = await generate_schema(target, {
		prefix: flags.prefix,
		parent_table: flags.parent,
		pagination_strategy: flags.pagination,
		route_name: flags.route_name,
	});

	if (!success) {
		console.error(`✗ Schema generation failed for ${target}`);
		return false;
	}

	console.log(`✓ Schema generation complete for ${target}\n`);
	return true;
}

// Run CRUD generation for a single table
export async function run_crud_generation(table: string, flags: ResourceFlags): Promise<boolean> {
	console.log(`  Generating CRUD for ${table}...`);

	// Don't pass translate to crud - resource handles the final sync itself
	// to avoid double-sync (crud would sync, then we'd sync again after)
	const success = await generate_crud(table, {
		force: flags.force,
		translate: false,
		prefix: flags.prefix,
		parent_table: flags.parent,
		route_name: flags.route_name,
	});

	if (!success) {
		console.error(`  ✗ CRUD generation failed for ${table}`);
		return false;
	}

	console.log(`  ✓ ${table} CRUD complete`);
	return true;
}

// Run CRUD generation for multiple tables
export async function run_crud_batch(tables: string[], flags: ResourceFlags): Promise<number> {
	console.log(`Generating CRUD for ${tables.length} table(s)...\n`);

	let success_count = 0;
	for (const table of tables) {
		if (await run_crud_generation(table, flags)) { success_count++; }
	}

	return success_count;
}
