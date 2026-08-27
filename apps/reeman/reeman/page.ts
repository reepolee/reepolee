/** Shared data loading for the independently routed Reeman pages. */

import { default_locale, locale_names, locales } from "$config/supported_locales";
import { db_type } from "$lib/resolve_db_type";

import { locale_clone_table_names } from "$generator/naming";

import { any_busy } from "./lib/busy_state";
import { load_runs, type RunRecord } from "./lib/state";
import { list_sql_files, type SqlFileEntry } from "./lib/sql_files";
import { get_users_table_created_at } from "../db_tables/sql.custom";
import { db } from "$config/db";

export type PageOverrides = {
	form_error?: string;
	status?: number;
};

export type ReemanData = {
	/** Most recent failed background action, kept visible until the user dismisses it. */
	last_error?: RunRecord;
	db_summary: { type: string; display: string; };
	tables: Array<{ name: string; column_count: number; fk_count: number; has_view: boolean; has_crud: boolean; comment: string; }>;
	crud_count: number;
	/** Views skipped during introspection because they reference missing tables (DDL needs repair). */
	broken_views: string[];
	modules: Array<{ id: number; code: string; name: string; }>;
	refresh_routes: Array<{ url: string; label: string; }>;
	sql_files: SqlFileEntry[];
	runs: RunRecord[];
	removable_routes: Array<{ url: string; module: string; }>;
	busy: { action: string; target: string; } | null;
	locales_info: { list: string[]; default_locale: string; locale_names: Record<string, string>; };
};

export type ReemanLoad = {
	/** Load the DDL-cache table list (also drives the crud_count stat). Default true. */
	tables?: boolean;
	/** Scan routes that have a schema folder (refresh page). Default false. */
	refresh_routes?: boolean;
	/** List .sql files (database page). Default false. */
	sql_files?: boolean;
	/** Read the run log (dashboard + logs pages). Default false. */
	runs?: boolean;
	/** List removable routes (routes page). Default false. */
	removable_routes?: boolean;
};

/**
 * Load the shared dataset. Pages opt in with a `ReemanLoad` mask so e.g. the
 * logs page does not pay for DDL-cache loads or filesystem scans.
 */
export async function load_reeman_data(load: ReemanLoad = {}): Promise<ReemanData> {
	const [{ get_available_modules }] = await Promise.all([import("$generator/reeman/db")]);
	const modules = await get_available_modules();

	const [tables_data, refresh_routes, sql_files, runs, removable_routes] = await Promise.all([
		load.tables === false
			? Promise.resolve(null)
			: (async () => {
				const [{ load_ddl_cache }, { discover_existing_crud_tables }] = await Promise.all([
					import("$generator/ddl_cache"),
					import("$generator/reeman/utils/route_scan"),
				]);
				const cache = await load_ddl_cache();
				const users_created_at = await get_users_table_created_at();
				const table_creation_times = await get_table_creation_times();
				const bootstrap_cutoff = users_created_at ? new Date(users_created_at).getTime() : 0;
				const crud_by_table = new Set(discover_existing_crud_tables().map((t) => t.name));
				const all_names = cache.tables.map((t) => t.name);
				const locale_clones = locale_clone_table_names(all_names, locales, default_locale);
				const tables = cache.tables
					.filter((t) => !locale_clones.has(t.name))
					.filter((t) => t.name !== "users")
					.filter((t) => !users_created_at || t.name !== "users")
					.filter((t) => {
						const created_at = table_creation_times.get(t.name.toLowerCase());
						return !bootstrap_cutoff || (created_at !== undefined && new Date(created_at).getTime() > bootstrap_cutoff);
					})
					.map((t) => ({
						name: t.name,
						column_count: t.columns.length,
						fk_count: t.foreign_keys.length + t.inferred_foreign_keys.length + t.view_foreign_keys.length,
						has_view: t.has_view,
						has_crud: crud_by_table.has(t.name),
						comment: t.comment ?? "",
					}))
					.sort((a, b) => a.name.localeCompare(b.name));
				return { tables, crud_count: tables.filter((t) => t.has_crud).length, broken_views: cache.broken_views ?? [] };
			})(),
		load.refresh_routes === false
			? Promise.resolve([])
			: import("$generator/reeman/utils/route_scan").then((m) => m.discover_routes_with_schema()),
		load.sql_files === false ? Promise.resolve([]) : list_sql_files(),
		load.runs === false ? Promise.resolve([]) : load_runs(),
		load.removable_routes === false
			? Promise.resolve([])
			: import("$generator/reeman/remove_route").then((m) => m.list_removable_routes()),
	]);

	const last_error = runs.find((run) => !run.ok);

	return {
		last_error,
		db_summary: summarize_connection(),
		tables: tables_data?.tables ?? [],
		crud_count: tables_data?.crud_count ?? 0,
		broken_views: tables_data?.broken_views ?? [],
		modules,
		refresh_routes: refresh_routes.map((r) => ({
			url: r.url,
			label: r.route_name ? `${r.url} → ${r.route_name}` : r.url,
		})),
		sql_files,
		runs,
		removable_routes,
		// Generic "something is running" banner for pages with no single busy
		// target (dashboard, database, logs, locales) - reports any table or
		// global action, not just the global lock. Pages with a specific
		// target (the table detail form) check is_busy(table) instead.
		busy: await any_busy(),
		locales_info: { list: [...locales], default_locale, locale_names },
	};
}

// ---------------------------------------------------------------------------
// Connection summary - type + password-masked display string
// ---------------------------------------------------------------------------

async function get_table_creation_times(): Promise<Map<string, string>> {
	const rows = await db.unsafe(`SELECT TABLE_NAME, CREATE_TIME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`) as Array<{ TABLE_NAME?: string; CREATE_TIME?: Date | string | null }>;
	return new Map(rows.filter((row) => row.TABLE_NAME && row.CREATE_TIME).map((row) => [row.TABLE_NAME!.toLowerCase(), new Date(row.CREATE_TIME!).toISOString()]));
}

function summarize_connection(): { type: string; display: string; } {
	const raw = Bun.env.DEV_CONNECTION_STRING?.trim() || "";
	const normalized = raw.toLowerCase();

	if (normalized.startsWith("mysql://")) {
		try {
			const url = new URL(raw);
			const user = url.username ? `${url.username}@` : "";
			return {
				type: "MySQL",
				display: `mysql://${user}***@${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname.replace(/\/$/, "")}`,
			};
		} catch {
			return { type: "MySQL", display: "mysql://***" };
		}
	}

	if (normalized.startsWith("sqlite")) {
		return { type: "SQLite", display: raw.replace(/^sqlite:?/, "") || "(in-memory)" };
	}

	return { type: db_type === "mysql" ? "MySQL" : "SQLite", display: raw || "(not set)" };
}
