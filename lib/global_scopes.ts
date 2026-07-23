import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { db } from "$config/db";
import { IGNORE_TABLES, INTERNAL_TABLE_PREFIX } from "$config/db_structure";
import type { RequestContext } from "$lib/request_context";

export interface ScopeDef {
	scope_key: string;
	display_name: string;
	is_default: boolean;
}

/**
 * Fetch available global scopes for a table, optionally filtered by feature_name
 * (route name) and module_code to support per-route scope separation
 * (e.g. /admin/brands vs /user/brands both use "brands" table but have different scopes).
 *
 * When module_code is provided, scopes are additionally filtered by module_code
 * to prevent duplicate scope keys from different modules leaking into the same dropdown.
 *
 * Falls back to table_name-only match for backward compatibility.
 */
export async function get_global_scopes(table_name: string, route_name?: string, module_code?: string): Promise<ScopeDef[]> {
	try {
		// When route_name is provided, filter by feature_name to support per-route scopes.
		// Named routes pass a route_name different from the table_name; regular routes pass the
		// same value for both. In either case, if route_name is set, we filter by feature_name
		// to avoid leaking scopes between routes that share the same underlying table.
		const has_route = !!route_name;

		let rows: any[];

		if (has_route) {
			if (module_code) {
				rows = await db`SELECT scope_key, display_name, is_default FROM global_scopes WHERE table_name = ${table_name} AND feature_name = ${route_name} AND module_code = ${module_code} ORDER BY sort_order ASC`;
			} else {
				rows = await db`SELECT scope_key, display_name, is_default FROM global_scopes WHERE table_name = ${table_name} AND feature_name = ${route_name} ORDER BY sort_order ASC`;
			}
		} else {
			// Exact match by table_name (bare table name like "brands")
			if (module_code) {
				rows = await db`SELECT scope_key, display_name, is_default FROM global_scopes WHERE table_name = ${table_name} AND module_code = ${module_code} ORDER BY sort_order ASC`;
			} else {
				rows = await db`SELECT scope_key, display_name, is_default FROM global_scopes WHERE table_name = ${table_name} ORDER BY sort_order ASC`;
			}
		}

		// Fallback: route_name filter returned no results -> try table_name alone
		// (backward compat for existing scopes without feature_name)
		if (has_route && (rows as any[]).length === 0) {
			if (module_code) {
				rows = await db`SELECT scope_key, display_name, is_default FROM global_scopes WHERE table_name = ${table_name} AND module_code = ${module_code} ORDER BY sort_order ASC`;
			} else {
				rows = await db`SELECT scope_key, display_name, is_default FROM global_scopes WHERE table_name = ${table_name} ORDER BY sort_order ASC`;
			}
		}

		// Fallback: suffix match for full namespace (e.g. "user.brands")
		if ((rows as any[]).length === 0) {
			const suffix = `%.${table_name}`;
			if (module_code) {
				rows = await db`SELECT scope_key, display_name, is_default FROM global_scopes WHERE table_name LIKE ${suffix} AND module_code = ${module_code} ORDER BY sort_order ASC`;
			} else {
				rows = await db`SELECT scope_key, display_name, is_default FROM global_scopes WHERE table_name LIKE ${suffix} ORDER BY sort_order ASC`;
			}
		}

		// Final fallback: try without module_code (backward compat for old scopes
		// that were created before module_code existed)
		if ((rows as any[]).length === 0 && module_code) {
			rows = await db`SELECT scope_key, display_name, is_default FROM global_scopes WHERE table_name = ${table_name} ORDER BY sort_order ASC`;
		}

		const scopes = (rows as any[]).map((row: any) => ({
			scope_key: row.scope_key,
			display_name: row.display_name,
			is_default: !!row.is_default,
		}));

		// A single scope is an admin-imposed restriction, not a menu choice - it must
		// always apply, regardless of whether is_default was set when it was created.
		if (scopes.length === 1 && scopes[0]) { scopes[0].is_default = true; }

		return scopes;
	} catch (error) {
		console.error("Error fetching global scopes:", error);
		return [];
	}
}

/**
 * Resolve the active scope_key for a request: URL param > cookie > table default.
 *
 * The URL param and cookie are both user-controlled input, so either can be
 * hand-edited to any string. Both are validated against the table's actual
 * `global_scopes` list here - an unrecognized scope_key must NOT reach
 * get_scope_clause(), because a scope_key with no matching row resolves to an
 * empty WHERE clause there (no match found = no filter), which would silently
 * bypass whatever restriction the admin configured instead of falling back to
 * the default scope.
 */
export function resolve_scope_key(global_scopes: ScopeDef[], url_scope: string, cookie_scope: string | null): string {
	const known_keys = new Set(global_scopes.map((s) => s.scope_key));

	if (url_scope && known_keys.has(url_scope)) return url_scope;
	if (cookie_scope && known_keys.has(cookie_scope)) return cookie_scope;

	return global_scopes.find((s) => s.is_default)?.scope_key || "";
}

/**
 * Session variable registry: maps `::session.*` paths to their runtime resolvers.
 * Each resolver extracts the value from the RequestContext and returns it.
 */
const SESSION_VARIABLES: Record<string, (ctx: RequestContext) => string | number | null> = {
	"session.user.id": (ctx) => ctx.user?.id ?? null,
	"session.user.email": (ctx) => ctx.user?.email ?? null,
	"session.user.name": (ctx) => ctx.user?.name ?? null,
	"session.user.nickname": (ctx) => ctx.user?.nickname ?? null,
	"session.user.username": (ctx) => ctx.user?.username ?? null,
	"session.user.modules_tags": (ctx) => ctx.user?.modules_tags ?? null,
};

/**
 * List of available ::session.* variable paths for UI pickers.
 */
export const SESSION_VARIABLE_PATHS: string[] = Object.keys(SESSION_VARIABLES);

/**
 * SQL-escape a runtime value for inline use in `db.unsafe()`.
 * Numbers are emitted as bare literals. Strings are single-quoted with `''` escaping.
 */
function sql_escape_literal(value: string | number | null): string {
	if (value === null) return "NULL";
	if (typeof value === "number") return String(value);
	// Single-quote with '' escaping (MySQL-style)
	return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Resolve `::session.*` variable tokens in a where_clause string.
 * Replaces tokens with their SQL-safe literal representations.
 * Fail-loud: if `::session.*` is used but no user is authenticated, returns `1=0`.
 */
export function resolve_session_variables(clause: string, ctx?: RequestContext): string {
	if (!clause.includes("::")) return clause;

	const has_session_var = /::session\.\S+/.test(clause);
	if (!has_session_var) return clause;

	// Fail-loud: session vars used but no request context
	if (!ctx) {
		console.warn("[global_scopes] ::session.* token found in where_clause but no RequestContext provided - returning 1=0");
		return "1=0";
	}

	// Fail-loud: session vars used but user not authenticated
	if (!ctx.user) {
		console.warn(`[global_scopes] ::session.* token found in where_clause but no authenticated user - returning 1=0`);
		return "1=0";
	}

	return clause.replace(/::(session\.\S+)/g, (_match, path: string) => {
		const resolver = SESSION_VARIABLES[path];
		if (!resolver) {
			console.warn(`[global_scopes] Unknown ::session variable "${path}" - replacing with NULL`);
			return "NULL";
		}

		const value = resolver(ctx);
		if (value === null) {
			console.warn(`[global_scopes] Session variable "${path}" resolved to null - replacing with NULL`);
			return "NULL";
		}

		return sql_escape_literal(value);
	});
}

/**
 * Fetch the WHERE clause for a given table+scope, then resolve any
 * `::session.*` variable tokens inline.
 *
 * Accepts an optional `ctx` (RequestContext) for session variable resolution.
 * Accepts an optional `route_name` to filter by feature_name for named routes.
 * When `::session.*` tokens are present but no ctx (or no user), fail-loud by returning `1=0`.
 *
 * Accepts an optional `module_code` to filter by module (e.g. "admin" vs "user")
 * when the same table has scopes scoped to different modules.
 */
export async function get_scope_clause(
	table_name: string,
	scope_key: string,
	ctx?: RequestContext,
	route_name?: string,
	module_code?: string,
): Promise<string> {
	if (!scope_key) return "";

	try {
		const has_route = !!route_name;
		let rows: any[];
		let row: any;

		if (has_route) {
			if (module_code) {
				rows = await db`SELECT where_clause FROM global_scopes WHERE table_name = ${table_name} AND feature_name = ${route_name} AND module_code = ${module_code} AND scope_key = ${scope_key} LIMIT 1`;
			} else {
				rows = await db`SELECT where_clause FROM global_scopes WHERE table_name = ${table_name} AND feature_name = ${route_name} AND scope_key = ${scope_key} LIMIT 1`;
			}
			row = (rows as any[])[0];
		}

		// Fallback: no route_name, or route_name filter returned no results
		if (!row) {
			if (module_code) {
				rows = await db`SELECT where_clause FROM global_scopes WHERE table_name = ${table_name} AND module_code = ${module_code} AND scope_key = ${scope_key} LIMIT 1`;
			} else {
				rows = await db`SELECT where_clause FROM global_scopes WHERE table_name = ${table_name} AND scope_key = ${scope_key} LIMIT 1`;
			}
			row = (rows as any[])[0];
		}

		// Fallback: suffix match for full namespace (e.g. "user.brands")
		if (!row) {
			const suffix = `%.${table_name}`;
			if (module_code) {
				rows = await db`SELECT where_clause FROM global_scopes WHERE table_name LIKE ${suffix} AND module_code = ${module_code} AND scope_key = ${scope_key} LIMIT 1`;
			} else {
				rows = await db`SELECT where_clause FROM global_scopes WHERE table_name LIKE ${suffix} AND scope_key = ${scope_key} LIMIT 1`;
			}
			row = (rows as any[])[0];
		}

		// Final fallback: try without module_code (backward compat for old scopes
		// that were created before module_code existed)
		if (!row && module_code) {
			rows = await db`SELECT where_clause FROM global_scopes WHERE table_name = ${table_name} AND scope_key = ${scope_key} LIMIT 1`;
			row = (rows as any[])[0];
		}

		const raw_clause = row?.where_clause || "";

		// Resolve ::session.* variable tokens
		return resolve_session_variables(raw_clause, ctx);
	} catch (error) {
		console.error("Error fetching scope clause:", error);
		return "";
	}
}

export interface TableOption {
	value: string;
	label: string;
}

/**
 * Read the sql.ts file in a route directory to extract the actual DB table name
 * from the TABLE_NAME constant. Returns the route name and actual table when
 * they differ (i.e. a named route), or null if sql.ts doesn't exist.
 */
function detect_named_route(dir_path: string, dir_name: string): { route_name: string; table_name: string; } | null {
	try {
		const sql_path = join(dir_path, "sql.ts");
		if (!existsSync(sql_path)) return null;
		const content = readFileSync(sql_path, "utf-8");
		const match = content.match(/export const TABLE_NAME\s*=\s*["'`]([^"'`]+)["'`]/);
		if (match && match[1] !== dir_name) {
			return {
				route_name: dir_name,
				table_name: match[1],
			};
		}
	} catch {}
	return null;
}

function scan_named_routes(): { route_name: string; table_name: string; }[] {
	const routes_dir = join(process.cwd(), "routes");
	const results: { route_name: string; table_name: string; }[] = [];

	if (!existsSync(routes_dir)) return results;

	try {
		const entries = readdirSync(routes_dir);

		for (const entry of entries) {
			if (entry.startsWith(".") || entry.startsWith(INTERNAL_TABLE_PREFIX)) continue;

			const entry_path = join(routes_dir, entry);
			const entry_stat = statSync(entry_path);
			if (!entry_stat.isDirectory()) continue;

			// Check: routes/<table>/schema/table.ts (standalone table)
			const direct_schema = join(entry_path, "schema", "table.ts");
			if (existsSync(direct_schema)) {
				const named = detect_named_route(entry_path, entry);
				if (named) results.push(named);
				continue;
			}

			// Check: routes/<prefix>/<table>/schema/table.ts
			const sub_entries = readdirSync(entry_path);
			for (const sub of sub_entries) {
				if (sub.startsWith(".") || sub.startsWith(INTERNAL_TABLE_PREFIX) || sub.startsWith("v_")) continue;

				const sub_path = join(entry_path, sub);
				const sub_stat = statSync(sub_path);
				if (!sub_stat.isDirectory()) continue;

				const sub_schema = join(sub_path, "schema", "table.ts");
				if (!existsSync(sub_schema)) continue;

				const named = detect_named_route(sub_path, sub);
				if (named) results.push(named);
			}
		}
	} catch (error) {
		console.error("Error scanning routes for named routes:", error);
	}

	return results;
}

export async function get_available_tables(): Promise<TableOption[]> {
	try {
		const conn_str = (Bun.env.CONNECTION_STRING || "").replace(/^["']|["']$/g, "");
		const is_sqlite = conn_str.toLowerCase().startsWith("sqlite://") || conn_str.endsWith(".sqlite") || conn_str.endsWith(".db");

		const rows: any[] = is_sqlite
			? await (db`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name` as any)
			: await (db`SELECT TABLE_NAME as name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME` as any);

		const db_table_names = rows.map((r: any) => String(r.name)).filter(Boolean).filter((t: string) => !t.startsWith(INTERNAL_TABLE_PREFIX)).filter((t: string) => !IGNORE_TABLES.includes(
			t as any
		));

		// Discover named routes and exclude their underlying DB tables
		const named_routes = scan_named_routes();
		const named_table_set = new Set(named_routes.map((n) => n.table_name));
		const named_route_set = new Set(named_routes.map((n) => n.route_name));

		const options: TableOption[] = [];

		// Add named routes first
		for (const nr of named_routes.sort((a, b) => a.route_name.localeCompare(b.route_name))) {
			options.push({
				value: nr.route_name,
				label: nr.route_name,
			});
		}

		// Add remaining DB tables (not masked by named routes)
		for (const t of db_table_names.sort()) {
			if (!named_table_set.has(t) && !named_route_set.has(t)) {
				options.push({
					value: t,
					label: t,
				});
			}
		}

		return options;
	} catch (error) {
		console.error("Error fetching available tables:", error);
		return [];
	}
}
