import { existsSync } from "node:fs";
import { join } from "node:path";

import { normalize_prefix } from "$lib/route";
import { spawnSync } from "bun";

import type { ResourceFlags } from "./flags";

export function sync_translations_if_needed(flags: ResourceFlags, dirs?: string[]) {
	if (!flags.translate) return;
	console.log("\n🌍 Syncing translations...");
	const cmd = ["bun", "generator/sync_translations", "--translate", ...(dirs || [])];
	const result = spawnSync({ cmd, stdio: ["inherit", "inherit", "inherit"] });
}

/**
 * Validate that the parent table's CRUD files exist before generating a child table.
 * Checks for schema/table.ts and index.ts in the parent's route directory.
 * Scans both top-level and one-level-deep prefix directories.
 */
export function validate_parent_crud(parent_table: string, flags: ResourceFlags): boolean {
	const routes_dir = join(process.cwd(), "routes");

	if (!existsSync(routes_dir)) {
		console.error("✗ Routes directory not found.");
		return false;
	}

	const { clean: clean_prefix } = normalize_prefix(flags.prefix);

	// Always check root level first (parents are standalone CRUDs with absolute paths)
	// Also check under prefix as a fallback
	const parent_dirs = [join(routes_dir, parent_table)];
	if (clean_prefix) { parent_dirs.push(join(routes_dir, clean_prefix, parent_table)); }

	let found = false;
	for (const parent_dir of parent_dirs) {
		const schema_path = join(parent_dir, "schema", "table.ts");
		const index_path = join(parent_dir, "index.ts");

		if (existsSync(schema_path) && existsSync(index_path)) {
			found = true;
			break;
		}
	}

	if (!found) {
		const parent_label = clean_prefix ? `${clean_prefix}/${parent_table}` : parent_table;
		console.error(`✗ Parent table "${parent_label}" has no CRUD files.`);
		console.error(`  Run the full pipeline for the parent table first:`);
		console.error(`    bun generator/resource.ts ${parent_table}${clean_prefix ? ` --prefix ${clean_prefix}` : ""}`);
		return false;
	}

	return true;
}
