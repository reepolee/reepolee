#!/usr/bin/env bun
/**
 * Route scanning helpers - discover routes with existing CRUD configuration.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { INTERNAL_TABLE_PREFIX } from "$config/db_structure";
import { MAIN_APP } from "$config/paths";
import { inspect_generated_ree_hashes, type ReeHashStatus } from "../../crud/ree_hash";

export interface CrudTableInfo {
	name: string;
	prefix: string;
	template_hash_status: ReeHashStatus;
	// Custom route name when it differs from the DB table name
	route_name?: string;
}

export interface RouteSchema {
	// Table name (e.g. "users")
	table: string;
	// Module prefix (e.g. "system") or empty string
	prefix: string;
	// Parent table name for nested children (e.g. "equipment"), or undefined
	parent?: string;
	// Full URL path (e.g. "/system/users")
	url: string;
	/** Database table creation timestamp used to exclude bootstrap routes. */
	created_at?: string | null;
	/**
	 * Custom route name when it differs from the DB table name.
	 * Set when the directory name is different from TABLE_NAME in sql.ts.
	 * e.g. directory is "my-users" but TABLE_NAME is "users".
	 */
	route_name?: string;
	/** Whether this route's generated .ree templates still match their generator hash. */
	template_hash_status?: ReeHashStatus;
}

/**
 * Read the sql.ts file in a route directory to extract the actual DB table name
 * from the TABLE_NAME constant. If it differs from the directory name, the
 * directory name is a custom route_name.
 */
function resolve_table_and_route(dir_path: string, dir_name: string): { table: string; route_name?: string; } {
	try {
		const sql_path = join(dir_path, "sql.ts");
		if (existsSync(sql_path)) {
			const content = readFileSync(sql_path, "utf-8");
			const match = content.match(/export const TABLE_NAME\s*=\s*["'`]([^"'`]+)["'`]/);
			if (match && match[1] !== dir_name) {
				return {
					table: match[1]!,
					route_name: dir_name,
				};
			}
		}
	} catch {}
	return { table: dir_name };
}

/**
 * Read the TABLE_NAME constant from a simple route's index.ts (the
 * simple-route generator declares it without `export`). Returns null when the
 * route has no DB table (e.g. a static simple page).
 */
function resolve_simple_route_table(dir_path: string): string | null {
	try {
		const index_path = join(dir_path, "index.ts");
		if (existsSync(index_path)) {
			const content = readFileSync(index_path, "utf-8");
			const match = content.match(/(?:export\s+)?const TABLE_NAME\s*=\s*["'`]([^"'`]+)["'`]/);
			if (match && match[1]) return match[1]!;
		}
	} catch {}
	return null;
}

export function discover_existing_crud_tables(): CrudTableInfo[] {
	const routes_dir = join(process.cwd(), MAIN_APP);
	const results: CrudTableInfo[] = [];

	if (!existsSync(routes_dir)) return results;

	const entries = readdirSync(routes_dir);

	for (const entry of entries) {
		if (entry.startsWith(".") || entry.startsWith(INTERNAL_TABLE_PREFIX) || entry.startsWith("v_")) continue;

		const entry_path = join(routes_dir, entry);
		const entry_stat = statSync(entry_path, { throwIfNoEntry: false });
		if (!entry_stat?.isDirectory()) continue;

		// Top-level table: routes/<table>/config.ts
		const direct_schema = join(entry_path, "config.ts");
		if (existsSync(direct_schema)) {
			const { table, route_name } = resolve_table_and_route(entry_path, entry);
			results.push({
				name: table,
				prefix: "",
				template_hash_status: inspect_generated_ree_hashes(entry_path),
				route_name,
			});
			continue;
		}

		// One level deep under prefix: routes/<prefix>/<table>/config.ts
		const sub_entries = readdirSync(entry_path);
		for (const sub of sub_entries) {
			if (sub.startsWith(".") || sub.startsWith(INTERNAL_TABLE_PREFIX) || sub.startsWith("v_")) continue;
			const sub_path = join(entry_path, sub);
			const sub_stat = statSync(sub_path, { throwIfNoEntry: false });
			if (!sub_stat?.isDirectory()) continue;

			const sub_schema = join(sub_path, "config.ts");
			if (existsSync(sub_schema)) {
				const { table: sub_table, route_name: sub_route } = resolve_table_and_route(sub_path, sub);
				results.push({
					name: sub_table,
					prefix: entry,
					template_hash_status: inspect_generated_ree_hashes(sub_path),
					route_name: sub_route,
				});
			}
		}
	}

	return results;
}

export function discover_routes_with_schema(routes_dir: string = join(process.cwd(), MAIN_APP)): RouteSchema[] {
	const results: RouteSchema[] = [];

	if (!existsSync(routes_dir)) return results;

	const entries = readdirSync(routes_dir);

	for (const entry of entries) {
		if (entry.startsWith(".") || entry.startsWith(INTERNAL_TABLE_PREFIX)) continue;

		const entry_path = join(routes_dir, entry);

		const entry_stat = statSync(entry_path);
		if (!entry_stat.isDirectory()) continue;

		// Check if entry itself is a table dir (no prefix): routes/<table>/config.ts
		const direct_schema = join(entry_path, "config.ts");
		if (existsSync(direct_schema)) {
			const { table, route_name } = resolve_table_and_route(entry_path, entry);
			results.push({
				table,
				prefix: "",
				url: `/${entry}`,
				created_at: null,
				route_name,
				template_hash_status: inspect_generated_ree_hashes(entry_path),
			});

			// Also check for nested child routes under this parent:
			// routes/<parent>/<child>/config.ts
			const sub_entries = readdirSync(entry_path);
			for (const sub of sub_entries) {
				if (sub.startsWith(".") || sub.startsWith(INTERNAL_TABLE_PREFIX)) continue;
				const sub_path = join(entry_path, sub);
				const sub_stat = statSync(sub_path);
				if (!sub_stat.isDirectory()) continue;
				const sub_schema = join(sub_path, "config.ts");
				if (existsSync(sub_schema)) {
					const { table: child_table, route_name: child_route } = resolve_table_and_route(sub_path, sub);
					results.push({
						table: child_table,
						prefix: "",
						parent: entry,
						url: `/${entry}/${sub}`,
						route_name: child_route,
						template_hash_status: inspect_generated_ree_hashes(sub_path),
					});
				}
			}
			continue;
		}

		// Check if entry is a prefix dir with subdirs: routes/<prefix>/<table>/config.ts
		const sub_entries = readdirSync(entry_path);
		for (const sub of sub_entries) {
			if (sub.startsWith(".") || sub.startsWith(INTERNAL_TABLE_PREFIX) || sub.startsWith("v_")) continue;

			const sub_path = join(entry_path, sub);
			const sub_stat = statSync(sub_path);
			if (!sub_stat.isDirectory()) continue;

			const sub_schema = join(sub_path, "config.ts");
			if (existsSync(sub_schema)) {
				const { table: sub_table, route_name: sub_route } = resolve_table_and_route(sub_path, sub);
				results.push({
					table: sub_table,
					prefix: entry,
					url: `/${entry}/${sub}`,
					created_at: null,
					route_name: sub_route,
					template_hash_status: inspect_generated_ree_hashes(sub_path),
				});

				// Also check for nested child routes under this prefixed parent:
				// routes/<prefix>/<parent>/<child>/config.ts
				const child_dirs = readdirSync(sub_path);
				for (const child of child_dirs) {
					if (child.startsWith(".") || child.startsWith(INTERNAL_TABLE_PREFIX)) continue;
					const child_path = join(sub_path, child);
					const child_stat = statSync(child_path);
					if (!child_stat.isDirectory()) continue;
					const child_schema = join(child_path, "config.ts");
					if (existsSync(child_schema)) {
						const { table: child_table, route_name: child_route } = resolve_table_and_route(child_path, child);
						results.push({
							table: child_table,
							prefix: entry,
							parent: sub,
							url: `/${entry}/${sub}/${child}`,
							route_name: child_route,
							template_hash_status: inspect_generated_ree_hashes(child_path),
						});
					}
				}
			}
		}
	}

	// Sort by URL for consistent ordering
	results.sort((a, b) => a.url.localeCompare(b.url));
	return results;
}

/**
 * Discover static "simple" routes (simple page / simple table page generators)
 * registered in routes.ts via the `import { route_definitions as alias } ...` +
 * `...alias,` spread pattern, excluding those that already have a CRUD schema
 * folder (they are reported by discover_routes_with_schema). The /routes grid
 * repopulates db_routes from this + discover_routes_with_schema() so every
 * generated route shows up - not just CRUD ones.
 */
export function discover_simple_routes(): RouteSchema[] {
	let raw: string;
	try {
		raw = readFileSync(join(process.cwd(), MAIN_APP, "routes.ts"), "utf-8");
	} catch {
		return [];
	}

	const results: RouteSchema[] = [];
	const lines = raw.split("\n");
	const static_spread_re = /^\.\.\.([\w]+),$/;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("//")) continue;

		// Static route_definitions spread pattern: ...alias, with a matching
		// `import { route_definitions as alias } from "$main/<path>";` above.
		const spread_match = trimmed.match(static_spread_re);
		if (!spread_match) continue;

		const alias = spread_match[1]!;
		const import_match = raw.match(new RegExp(`import \\{ route_definitions as ${alias} \\} from "\\$main/([^"]+)"`));
		if (!import_match) continue;

		const route_path = import_match[1]!;
		const parts = route_path.split("/");
		const dir_path = join(process.cwd(), MAIN_APP, ...parts);

		// CRUD routes are already reported by discover_routes_with_schema().
		if (existsSync(join(dir_path, "config.ts"))) continue;

		const folder_name = parts[parts.length - 1] ?? route_path;
		const table = resolve_simple_route_table(dir_path) ?? folder_name;
		results.push({
			table,
			prefix: parts.length > 1 ? parts[0]! : "",
			url: `/${route_path}`,
			template_hash_status: inspect_generated_ree_hashes(dir_path),
		});
	}

	results.sort((a, b) => a.url.localeCompare(b.url));
	return results;
}
