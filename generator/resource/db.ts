import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { IGNORE_TABLES, INTERNAL_TABLE_PREFIX } from "$config/db_structure";

/**
 * Get all table names from the DDL cache (excluding views, IGNORE_TABLES).
 */
export async function get_available_db_tables(): Promise<string[]> {
	try {
		const { load_ddl_cache, get_cached_tables } = await import("../ddl_cache");
		const cache = await load_ddl_cache();
		const tables = get_cached_tables(cache);

		return tables.filter((t) => !IGNORE_TABLES.includes(t as any)).filter((t) => !t.startsWith(INTERNAL_TABLE_PREFIX));
	} catch (error) {
		console.error("Error fetching tables from DDL cache:", error);
		return [];
	}
}

/**
 * Read the sql.ts file in a route directory to extract the actual DB table name
 * from the TABLE_NAME constant. If it differs from the directory name, the
 * directory name is a custom route_name.
 */
function resolve_table_from_sql(dir_path: string, dir_name: string): string {
	try {
		const sql_path = join(dir_path, "sql.ts");
		if (existsSync(sql_path)) {
			const content = readFileSync(sql_path, "utf-8");
			const match = content.match(/export const TABLE_NAME\s*=\s*["'`]([^"'`]+)["'`]/);
			if (match && match[1] !== dir_name) { return match[1]; }
		}
	} catch {}
	return dir_name;
}

export function discover_existing_crud_tables(): string[] {
	const routes_dir = join(process.cwd(), "routes");
	const tables: string[] = [];

	if (!existsSync(routes_dir)) return tables;

	const entries = readdirSync(routes_dir);

	for (const entry of entries) {
		if (entry.startsWith(".") || entry.startsWith(INTERNAL_TABLE_PREFIX) || entry.startsWith("v_")) continue;

		const entry_path = join(routes_dir, entry);
		const entry_stat = statSync(entry_path, { throwIfNoEntry: false });
		if (!entry_stat?.isDirectory()) continue;

		// Top-level table: routes/<table>/schema/table.ts
		if (existsSync(join(entry_path, "schema", "table.ts"))) {
			tables.push(resolve_table_from_sql(entry_path, entry));
			continue;
		}

		// One level deep under prefix: routes/<prefix>/<table>/schema/table.ts
		const sub_entries = readdirSync(entry_path);
		for (const sub of sub_entries) {
			if (sub.startsWith(".") || sub.startsWith(INTERNAL_TABLE_PREFIX) || sub.startsWith("v_")) continue;
			const sub_path = join(entry_path, sub);
			const sub_stat = statSync(sub_path, { throwIfNoEntry: false });
			if (sub_stat?.isDirectory() && existsSync(join(sub_path, "schema", "table.ts"))) { tables.push(resolve_table_from_sql(sub_path, sub)); }
		}
	}

	return tables;
}

export function get_generated_table_schemas(): string[] {
	try {
		const routes_dir = join(process.cwd(), "routes");

		if (!existsSync(routes_dir)) {
			console.error("Routes directory not found:", routes_dir);
			return [];
		}

		const tables: string[] = [];

		const entries = readdirSync(routes_dir);

		for (const entry of entries) {
			if (entry.startsWith(INTERNAL_TABLE_PREFIX)) continue;
			if (entry.startsWith("v_")) continue;
			if (IGNORE_TABLES.includes(entry)) continue;

			const table_path = join(routes_dir, entry);
			const entry_stat = statSync(table_path, { throwIfNoEntry: false });

			if (!entry_stat?.isDirectory()) continue;

			// Check if this is a top-level table directory
			const table_generated_path = join(table_path, "schema", "table.generated.ts");
			if (existsSync(table_generated_path)) {
				tables.push(entry);
				continue;
			}

			// Check if this is a prefix directory (e.g. admin, my) with subdirectories
			const sub_entries = readdirSync(table_path);
			for (const sub of sub_entries) {
				if (IGNORE_TABLES.includes(sub)) continue;
				const sub_path = join(table_path, sub);
				const sub_stat = statSync(sub_path, { throwIfNoEntry: false });
				if (sub_stat?.isDirectory()) {
					const sub_generated_path = join(sub_path, "schema", "table.generated.ts");
					if (existsSync(sub_generated_path)) { tables.push(sub); }
				}
			}
		}

		return tables;
	} catch (error) {
		console.error("Error reading routes directory:", error);
		return [];
	}
}
