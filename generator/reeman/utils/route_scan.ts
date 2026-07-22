#!/usr/bin/env bun
/**
 * Route scanning helpers - discover routes with existing CRUD schemas.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { INTERNAL_TABLE_PREFIX } from "$config/db_structure";

export interface CrudTableInfo {
	name: string;
	prefix: string;
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
	/**
	 * Custom route name when it differs from the DB table name.
	 * Set when the directory name is different from TABLE_NAME in sql.ts.
	 * e.g. directory is "my-users" but TABLE_NAME is "users".
	 */
	route_name?: string;
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
					table: match[1],
					route_name: dir_name,
				};
			}
		}
	} catch {}
	return { table: dir_name };
}

export function discover_existing_crud_tables(): CrudTableInfo[] {
	const routes_dir = join(process.cwd(), "routes");
	const results: CrudTableInfo[] = [];

	if (!existsSync(routes_dir)) return results;

	const entries = readdirSync(routes_dir);

	for (const entry of entries) {
		if (entry.startsWith(".") || entry.startsWith(INTERNAL_TABLE_PREFIX) || entry.startsWith("v_")) continue;

		const entry_path = join(routes_dir, entry);
		const entry_stat = statSync(entry_path, { throwIfNoEntry: false });
		if (!entry_stat?.isDirectory()) continue;

		// Top-level table: routes/<table>/schema/table.ts
		const direct_schema = join(entry_path, "schema", "table.ts");
		if (existsSync(direct_schema)) {
			const { table, route_name } = resolve_table_and_route(entry_path, entry);
			results.push({
				name: table,
				prefix: "",
				route_name,
			});
			continue;
		}

		// One level deep under prefix: routes/<prefix>/<table>/schema/table.ts
		const sub_entries = readdirSync(entry_path);
		for (const sub of sub_entries) {
			if (sub.startsWith(".") || sub.startsWith(INTERNAL_TABLE_PREFIX) || sub.startsWith("v_")) continue;
			const sub_path = join(entry_path, sub);
			const sub_stat = statSync(sub_path, { throwIfNoEntry: false });
			if (!sub_stat?.isDirectory()) continue;

			const sub_schema = join(sub_path, "schema", "table.ts");
			if (existsSync(sub_schema)) {
				const { table: sub_table, route_name: sub_route } = resolve_table_and_route(sub_path, sub);
				results.push({
					name: sub_table,
					prefix: entry,
					route_name: sub_route,
				});
			}
		}
	}

	return results;
}

export function discover_routes_with_schema(): RouteSchema[] {
	const routes_dir = join(process.cwd(), "routes");
	const results: RouteSchema[] = [];

	if (!existsSync(routes_dir)) return results;

	const entries = readdirSync(routes_dir);

	for (const entry of entries) {
		if (entry.startsWith(".") || entry.startsWith(INTERNAL_TABLE_PREFIX)) continue;

		const entry_path = join(routes_dir, entry);

		const entry_stat = statSync(entry_path);
		if (!entry_stat.isDirectory()) continue;

		// Check if entry itself is a table dir (no prefix): routes/<table>/schema/table.ts
		const direct_schema = join(entry_path, "schema", "table.ts");
		if (existsSync(direct_schema)) {
			const { table, route_name } = resolve_table_and_route(entry_path, entry);
			results.push({
				table,
				prefix: "",
				url: `/${entry}`,
				route_name,
			});

			// Also check for nested child routes under this parent:
			// routes/<parent>/<child>/schema/table.ts
			const sub_entries = readdirSync(entry_path);
			for (const sub of sub_entries) {
				if (sub.startsWith(".") || sub.startsWith(INTERNAL_TABLE_PREFIX)) continue;
				const sub_path = join(entry_path, sub);
				const sub_stat = statSync(sub_path);
				if (!sub_stat.isDirectory()) continue;
				const sub_schema = join(sub_path, "schema", "table.ts");
				if (existsSync(sub_schema)) {
					const { table: child_table, route_name: child_route } = resolve_table_and_route(sub_path, sub);
					results.push({
						table: child_table,
						prefix: "",
						parent: entry,
						url: `/${entry}/${sub}`,
						route_name: child_route,
					});
				}
			}
			continue;
		}

		// Check if entry is a prefix dir with subdirs: routes/<prefix>/<table>/schema/table.ts
		const sub_entries = readdirSync(entry_path);
		for (const sub of sub_entries) {
			if (sub.startsWith(".") || sub.startsWith(INTERNAL_TABLE_PREFIX) || sub.startsWith("v_")) continue;

			const sub_path = join(entry_path, sub);
			const sub_stat = statSync(sub_path);
			if (!sub_stat.isDirectory()) continue;

			const sub_schema = join(sub_path, "schema", "table.ts");
			if (existsSync(sub_schema)) {
				const { table: sub_table, route_name: sub_route } = resolve_table_and_route(sub_path, sub);
				results.push({
					table: sub_table,
					prefix: entry,
					url: `/${entry}/${sub}`,
					route_name: sub_route,
				});

				// Also check for nested child routes under this prefixed parent:
				// routes/<prefix>/<parent>/<child>/schema/table.ts
				const child_dirs = readdirSync(sub_path);
				for (const child of child_dirs) {
					if (child.startsWith(".") || child.startsWith(INTERNAL_TABLE_PREFIX)) continue;
					const child_path = join(sub_path, child);
					const child_stat = statSync(child_path);
					if (!child_stat.isDirectory()) continue;
					const child_schema = join(child_path, "schema", "table.ts");
					if (existsSync(child_schema)) {
						const { table: child_table, route_name: child_route } = resolve_table_and_route(child_path, child);
						results.push({
							table: child_table,
							prefix: entry,
							parent: sub,
							url: `/${entry}/${sub}/${child}`,
							route_name: child_route,
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
