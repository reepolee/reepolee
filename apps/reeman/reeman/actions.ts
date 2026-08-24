/**
 * reeman web actions - run the same generator library functions the reeman
 * CLI calls. Most actions run in-process with console output captured; CRUD
 * generation is spawned so it can finish independently of hot reloads, with
 * its stdout and stderr persisted to the run log when it completes.
 *
 * The heavy generator modules are imported lazily inside each in-process action
 * so the /reeman page stays cheap and an import problem in one generator never
 * breaks the whole server at startup.
 */

import { clean_output, capture_output } from "./lib/capture";
import { clear_busy, get_busy, GLOBAL_BUSY_KEY, set_busy, type BusyEntry } from "./lib/busy_state";
import { record_run, update_run } from "./lib/state";
import { backup_database } from "./lib/database_backup";

import type { OrderByItem, WhereItem } from "$generator/reeman/types";
import type { GridColumnDefinition } from "$generator/schema/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActionResult {
	ok: boolean;
	output: string;
	error?: string;
	meta?: Record<string, any>;
}

type InnerResult = { ok: boolean; meta?: Record<string, any>; };

// ---------------------------------------------------------------------------
// Busy guard - generator actions write files and mutate the DB. Actions that
// touch one table (crud, schema, refresh-crud) are keyed by that table, so
// generating "sessions" does not block starting "files". Actions that touch
// shared state (translations sync, SQL file execution, locale changes, route
// removal) use GLOBAL_BUSY_KEY and stay exclusive against everything else,
// per-table or global - see ./lib/busy_state.ts for why this is file-backed.
// ---------------------------------------------------------------------------

let _completed_return_to: string | null = null;

/** Busy entry for `key` (table name), or the global lock if that is set. Omit `key` to check only the global lock. */
export async function is_busy(key?: string): Promise<BusyEntry | null> {
	return get_busy(key);
}

/**
 * Store the intended redirect target so the busy-poller can navigate there
 * after the action completes, even if a live-reload eats the server's 303.
 */
export function set_completed_return_to(url: string): void {
	_completed_return_to = url;
}

/** Return and clear the stored redirect target (one-shot). */
export function get_and_clear_completed_return_to(): string | null {
	const url = _completed_return_to;
	_completed_return_to = null;
	return url;
}

async function run_captured_action(action: string, target: string, run: () => Promise<boolean | InnerResult>, busy_key: string = GLOBAL_BUSY_KEY): Promise<ActionResult> {
	const acquired = await set_busy(busy_key, { action, target });
	if (!acquired) {
		const busy = await get_busy(busy_key);
		return { ok: false, output: "", error: `Another reeman action is already running: ${busy?.action ?? "?"} (${busy?.target || "—"}). Wait for it to finish.` };
	}

	const cap = capture_output(run);
	try {
		const result = await cap.fn();
		const ok = typeof result === "boolean" ? result : result.ok;
		return {
			ok,
			output: clean_output([...cap.stdout, ...cap.stderr]),
			meta: typeof result === "boolean" ? undefined : result.meta,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			output: clean_output([...cap.stdout, ...cap.stderr]),
			error: message,
		};
	} finally {
		await clear_busy(busy_key);
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Re-introspect the DB before generating from the schema, matching the CLI and
 * MCP behaviour: schema changes happen outside the generators, so a stale
 * snapshot would generate against a schema that no longer exists.
 */
async function refresh_ddl_cache(): Promise<void> {
	const { invalidate_cache, load_ddl_cache } = await import("$generator/ddl_cache");
	invalidate_cache();
	await load_ddl_cache({ force_refresh: true });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pick<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
	return value !== undefined && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export async function action_crud(params: { table: string; force?: boolean; translate?: boolean; prefix?: string; route_name?: string; pagination?: string; render_strategy?: string; template_tags?: string; grid_columns?: string[]; grid_column_definitions?: GridColumnDefinition[]; }): Promise<ActionResult> {
	return run_captured_action("crud", params.table, async () => {
		await refresh_ddl_cache();
		const { run_full_pipeline } = await import("$generator/reeman/callers/resource_caller");
		return await run_full_pipeline(params.table, {
			prefix: params.prefix?.trim() || undefined,
			route_name: params.route_name?.trim() || undefined,
			force: params.force ?? false,
			// Web actions run in the server process - never block on stdin.
			interactive: false,
			translate: params.translate ?? false,
			pagination_method: pick(params.pagination, ["cursor", "offset"]),
			render_strategy: pick(params.render_strategy, ["stream", "load"]),
			template_tags: pick(params.template_tags, ["flat", "tags"]),
			// An explicit empty list means every editable index-grid column is hidden.
			grid_columns: params.grid_columns,
			grid_column_definitions: params.grid_column_definitions,
		});
	}, params.table);
}

export async function action_schema(params: { table: string; prefix?: string; }): Promise<ActionResult> {
	return run_captured_action("schema", params.table, async () => {
		await refresh_ddl_cache();
		const { generate_schema } = await import("$generator/schema");
		return await generate_schema(params.table, { prefix: params.prefix?.trim() || undefined });
	}, params.table);
}

export async function action_simple_page(params: { prefix: string; folder_name: string; }): Promise<ActionResult> {
	return run_captured_action("simple-page", params.folder_name, async () => {
		const { generate_simple_page } = await import("$generator/reeman/simple_page");
		await generate_simple_page(params.prefix, params.folder_name);
		return true;
	});
}

export async function action_simple_route(params: { prefix: string; folder_name: string; table: string; fields: string[]; order_by: OrderByItem[]; where: WhereItem[]; }): Promise<ActionResult> {
	return run_captured_action("simple-table-page", params.folder_name, async () => {
		await refresh_ddl_cache();
		const { generate_simple_route } = await import("$generator/reeman/simple_route");
		await generate_simple_route(params.prefix, params.folder_name, params.table, params.fields, params.order_by, params.where);
		return true;
	});
}

export async function action_bulk(params: { tables: string[]; translate?: boolean; prefix?: string; pagination?: string; render_strategy?: string; template_tags?: string; }): Promise<ActionResult> {
	const target = params.tables.join(", ");
	return run_captured_action("bulk", target, async () => {
		await refresh_ddl_cache();
		const { run_bulk_generator } = await import("$generator/reeman/callers/resource_caller");
		const result = await run_bulk_generator(
			params.tables,
			params.prefix?.trim() || "",
			params.translate ?? false,
			params.pagination === "cursor" || params.pagination === "offset" ? params.pagination : "offset",
			params.render_strategy === "stream" ? "stream" : "load",
			pick(params.template_tags, ["flat", "tags"]),
			false,
		);
		return result.fail === 0;
	});
}

export async function action_bulk_schema(params: { tables: string[]; prefix?: string; }): Promise<ActionResult> {
	const target = params.tables.join(", ");
	return run_captured_action("bulk-schema", target, async () => {
		await refresh_ddl_cache();
		const { generate_schema } = await import("$generator/schema");
		let fail = 0;
		for (const table of params.tables) {
			const ok = await generate_schema(table, { prefix: params.prefix?.trim() || undefined });
			if (!ok) fail++;
		}
		return fail === 0;
	});
}

export async function action_bulk_refresh(params: { tables: string[]; mode: "fields" | "full"; template_tags?: string; }): Promise<ActionResult> {
	const target = params.tables.join(", ");
	return run_captured_action("bulk-refresh", target, async () => {
		const { discover_routes_with_schema } = await import("$generator/reeman/utils/route_scan");
		const { refresh_crud_fields_only, refresh_crud_for_table } = await import("$generator/reeman/refresh_crud");
		const routes = discover_routes_with_schema();
		const template_tags = pick(params.template_tags, ["flat", "tags"]);
		let fail = 0;
		for (const table of params.tables) {
			const route = routes.find((r) => r.table === table);
			if (!route) {
				console.error(`✗ Skipped ${table}: no existing CRUD route found`);
				fail++;
				continue;
			}
			const ok = params.mode === "fields"
				? await refresh_crud_fields_only(route.table, route.prefix, route.parent, route.route_name, false, template_tags)
				: await refresh_crud_for_table(route.table, route.prefix, route.parent, route.route_name, false, template_tags);
			if (!ok) fail++;
		}
		return fail === 0;
	});
}

export async function action_refresh(params: { url: string; mode: "fields" | "full"; template_tags?: string; }): Promise<ActionResult> {
	return run_captured_action("refresh-crud", params.url, async () => {
		const { discover_routes_with_schema } = await import("$generator/reeman/utils/route_scan");
		const route = discover_routes_with_schema().find((r) => r.url === params.url);
		if (!route) throw new Error(`Route not found: ${params.url}`);
		const template_tags = pick(params.template_tags, ["flat", "tags"]);
		if (params.mode === "fields") {
			const { refresh_crud_fields_only } = await import("$generator/reeman/refresh_crud");
			return await refresh_crud_fields_only(route.table, route.prefix, route.parent, route.route_name, false, template_tags);
		}
		const { refresh_crud_for_table } = await import("$generator/reeman/refresh_crud");
		return await refresh_crud_for_table(route.table, route.prefix, route.parent, route.route_name, false, template_tags);
	}, params.url);
}

export async function action_sync_translations(params: { translate?: boolean; }): Promise<ActionResult> {
	return run_captured_action("sync-translations", params.translate ? "with AI translate" : "structure only", async () => {
		if (params.translate) {
			const { sync_all_namespaces } = await import("$generator/translate_namespace");
			await sync_all_namespaces();
		} else {
			const { sync_single_namespace } = await import("$generator/translate_namespace");
			const { read_all_translation_rows } = await import("$lib/translation_files");
			const rows = await read_all_translation_rows();
			const namespaces = [...new Set(rows.map((row) => row.namespace))].sort();
			for (const namespace of namespaces) { await sync_single_namespace(namespace, false); }
		}
		const { notify_server_reload } = await import("$lib/server_notify");
		// Cross-process: the translations live in the main app's memory too.
		await notify_server_reload(false, Bun.env.MAIN_APP_URL);
		return true;
	});
}

export async function action_sync_locale_tables(): Promise<ActionResult> {
	return run_captured_action("sync-locale-tables", "", async () => {
		const { sync_locale_tables_command } = await import("$generator/reeman/sync_locale_tables");
		return await sync_locale_tables_command();
	});
}

export async function action_backup_database(): Promise<ActionResult> {
	return run_captured_action("backup-database", "", async () => {
		const backup_path = await backup_database();
		console.log(`Wrote ${backup_path}`);
		return true;
	});
}

export async function action_run_sql(params: { path: string; }): Promise<ActionResult> {
	return run_captured_action("run-sql-file", params.path, async () => {
		const { execute_sql_file } = await import("$generator/reeman/run_sql_file");
		const ok = await execute_sql_file(params.path, true);
		// Running SQL may have repaired the DDL (e.g. recreated a missing table
		// behind a broken view) - drop the snapshot so the next page load
		// re-introspects and the broken-views warning reflects the new state.
		// Invalidate on failure too: a script that fails partway can still have
		// altered the DDL, and the re-introspect is cheap (it runs on the next
		// page load regardless).
		const { invalidate_cache } = await import("$generator/ddl_cache");
		invalidate_cache();
		// SQL files commonly seed/update translations too - reload the main
		// app's in-memory copy across the two-app split, same as sync-translations.
		const { notify_server_reload } = await import("$lib/server_notify");
		await notify_server_reload(false, Bun.env.MAIN_APP_URL);
		return ok;
	});
}

export async function action_check_compliance(): Promise<ActionResult> {
	return run_captured_action("check-domain-compliance", "", async () => {
		const checker = await import("$root/scripts/check_domain_compliance");
		await checker.run_check();
		// run_check()'s return code signals CI pass/fail (issues found = 1), not
		// whether the check itself ran successfully - the check always completes here.
		return {
			ok: true,
			meta: {
				non_compliant: checker.last_non_compliant,
				unknown: checker.last_unknown,
			},
		};
	});
}

export async function action_add_locale(params: { locale_code: string; translate?: boolean; }): Promise<ActionResult> {
	return run_captured_action("add-locale", params.locale_code, async () => {
		const { add_locale_to_system } = await import("$generator/add_locale");
		return await add_locale_to_system(params.locale_code, { translate: params.translate ?? false });
	});
}

export async function action_add_seeded_locale(params: { locale_code: string; }): Promise<ActionResult> {
	return run_captured_action("add-seeded-locale", params.locale_code, async () => {
		const { add_seeded_locale } = await import("$generator/add_locale");
		return await add_seeded_locale(params.locale_code);
	});
}

export async function action_install_archived_locale(params: { locale_code: string; }): Promise<ActionResult> {
	return run_captured_action("install-archived-locale", params.locale_code, async () => {
		const { install_locale_from_archive } = await import("$generator/install_locale");
		return await install_locale_from_archive(params.locale_code);
	});
}

export async function action_activate_locales(params: { locale_codes: string[]; }): Promise<ActionResult> {
	return run_captured_action("activate-locales", params.locale_codes.join(", "), async () => {
		const { activate_locales_in_system } = await import("$generator/activate_locale");
		const result = await activate_locales_in_system(params.locale_codes);
		if (!result.ok) { throw new Error(result.error || "Failed to activate locale(s)."); }
		return { ok: true, meta: { activated: result.activated } };
	});
}

export async function action_remove_locale(params: { locale_code: string; }): Promise<ActionResult> {
	return run_captured_action("remove-locale", params.locale_code, async () => {
		const { remove_locale_from_system } = await import("$generator/remove_locale");
		// force=true: the web confirm dialog is the confirmation gate (mirrors
		// the CLI's --force). remove_locale_from_system refuses to run without it.
		return await remove_locale_from_system(params.locale_code, { force: true });
	});
}

export async function action_json_to_sql(params: { json_path: string; table: string; slug?: string; project_root?: string; }): Promise<ActionResult> {
	const target = `${params.json_path} → ${params.table}`;
	return run_captured_action("json-to-sql", target, async () => {
		const { convert_json_to_sql } = await import("$generator/reeman/data_to_sql");
		const result = await convert_json_to_sql(params.json_path, params.table, {
			slug: params.slug?.trim() || undefined,
			project_root: params.project_root,
		});
		console.log(`Wrote ${result.mysql_path}`);
		console.log(`Wrote ${result.sqlite_path}`);
		console.log(`${result.row_count} row(s) seeded.`);
		return true;
	});
}

export async function action_spreadsheet_to_sql(params: { spreadsheet_path: string; table?: string; slug?: string; project_root?: string; selections?: Array<{ sheet: string; table: string; }>; }): Promise<ActionResult> {
	const target_tables = params.selections?.map((selection) => selection.table).join(", ") || params.table || "";
	const target = `${params.spreadsheet_path} → ${target_tables}`;
	return run_captured_action("spreadsheet-to-sql", target, async () => {
		const { convert_spreadsheet_selections_to_sql, convert_spreadsheet_to_sql } = await import("$generator/reeman/data_to_sql");
		if (params.selections) {
			const result = await convert_spreadsheet_selections_to_sql(params.spreadsheet_path, params.selections, {
				project_root: params.project_root,
			});
			for (const table of result.tables) {
				console.log(`Wrote ${table.mysql_path}`);
				console.log(`Wrote ${table.sqlite_path}`);
				console.log(`${table.row_count} row(s) seeded from ${table.sheet} into ${table.table}.`);
			}
			return true;
		}
		if (!params.table) throw new Error("A table name is required.");
		const result = await convert_spreadsheet_to_sql(params.spreadsheet_path, params.table, {
			slug: params.slug?.trim() || undefined,
			project_root: params.project_root,
		});
		console.log(`Wrote ${result.mysql_path}`);
		console.log(`Wrote ${result.sqlite_path}`);
		console.log(`${result.row_count} row(s) seeded from ${result.sheets.join(", ")}.`);
		return true;
	});
}

export async function action_bulk_remove_route(params: { urls: string[]; delete_translations?: boolean; }): Promise<ActionResult> {
	const target = params.urls.join(", ");
	return run_captured_action("bulk-remove-route", target, async () => {
		const { list_removable_routes, remove_route } = await import("$generator/reeman/remove_route");
		const removable = await list_removable_routes();
		const removable_urls = new Set(removable.map((r) => r.url));
		let fail = 0;
		for (const url of params.urls) {
			if (!removable_urls.has(url)) {
				console.error(`✗ Skipped ${url}: not removable (system route or root page)`);
				fail++;
				continue;
			}
			try {
				// force=true: the web form's confirm dialog is the confirmation gate.
				// The POST handler sends the redirect before asking the main app to
				// reload. Reloading here can interrupt this request while Bun is
				// rebuilding the route table, leaving the browser on /routes/:id.
				await remove_route(url, true, params.delete_translations ?? undefined, false);
			} catch (err) {
				console.error(`✗ Failed to remove ${url}: ${err instanceof Error ? err.message : String(err)}`);
				fail++;
			}
		}
		return fail === 0;
	});
}

export async function action_bulk_refresh_routes(params: { urls: string[]; mode: "fields" | "full"; template_tags?: string; pagination?: string; render_strategy?: string; grid_columns?: string[]; grid_column_definitions?: GridColumnDefinition[]; }): Promise<ActionResult> {
	const target = params.urls.join(", ");
	return run_captured_action("bulk-refresh-routes", target, async () => {
		const { discover_routes_with_schema } = await import("$generator/reeman/utils/route_scan");
		const { refresh_crud_fields_only, refresh_crud_for_table } = await import("$generator/reeman/refresh_crud");
		const routes = discover_routes_with_schema();
		const template_tags = pick(params.template_tags, ["flat", "tags"]);
		const is_single_route = params.urls.length === 1;
		const refresh_options = is_single_route ? {
			pagination_strategy: pick(params.pagination, ["cursor", "offset"]),
			render_strategy: pick(params.render_strategy, ["stream", "load"]),
			grid_columns: params.grid_columns,
			grid_column_definitions: params.grid_column_definitions,
		} : undefined;
		let fail = 0;
		for (const url of params.urls) {
			const route = routes.find((r) => r.url === url);
			if (!route) {
				// Simple pages / simple table routes have no CRUD schema and cannot
				// be refreshed - skip them instead of failing the whole batch.
				console.log(`  - Skipped ${url}: not a CRUD route (no schema folder)`);
				continue;
			}
			const ok = params.mode === "fields"
				? await refresh_crud_fields_only(route.table, route.prefix, route.parent, route.route_name, false, template_tags, refresh_options)
				: await refresh_crud_for_table(route.table, route.prefix, route.parent, route.route_name, false, template_tags, refresh_options);
			if (!ok) fail++;
		}
		return fail === 0;
	});
}

/**
 * Dynamic route refresh - pick up newly generated routes/nav without a full
 * restart. Two channels, matching lib/server_notify.ts:
 *  1. restart=false - POST /__reload-translations: reloads in-memory
 *     translations + route maps and notifies open clients (best effort - the
 *     endpoint requires INTERNAL_ADMIN_ENDPOINTS + a strong RELOAD_SECRET).
 *  2. restart=true  - stamps routes.ts so bun --hot re-evaluates the route
 *     table/nav in place (the mechanism generators already rely on).
 */
export async function action_reload_routes(): Promise<ActionResult> {
	return run_captured_action("reload-routes", "", async () => {
		const { notify_server_reload } = await import("$lib/server_notify");
		// Cross-process: the translations live in the main app's memory too.
		await notify_server_reload(false, Bun.env.MAIN_APP_URL);
		await notify_server_reload(true);
		return true;
	});
}

// ---------------------------------------------------------------------------
// Spawn-based CRUD generation - survives bun --hot reloads by running in a
// separate process. Busy state is file-backed (./lib/busy_state.ts) and keyed
// per table, so generating "sessions" does not block starting "files" -
// spawn_bulk_action locks each table in the batch independently and each
// clears on its own subprocess's exit, rather than one flag for the batch.
// ---------------------------------------------------------------------------

/** Spawn `bun run reeman crud <table>` with the given flags. Caller has already reserved `table`'s busy key and created the pending run record. */
async function spawn_one(
	table: string,
	opts: { force?: boolean; translate?: boolean; prefix?: string; route_name?: string; pagination?: string; render_strategy?: string; template_tags?: string; grid_columns?: string[]; grid_column_definitions?: GridColumnDefinition[]; },
	run_id: string,
	action: "crud" | "bulk",
): Promise<void> {
	const args: string[] = ["run", "reeman", "crud", table];
	if (opts.force) args.push("--force");
	if (opts.translate) args.push("--translate");
	if (opts.prefix) args.push("--prefix", opts.prefix);
	if (opts.route_name) args.push("--route_name", opts.route_name);
	if (opts.pagination) args.push("--pagination", opts.pagination);
	if (opts.render_strategy) args.push("--render-strategy", opts.render_strategy);
	if (opts.template_tags) args.push("--template-tags", opts.template_tags);
	if (opts.grid_columns && opts.grid_columns.length > 0) args.push("--grid-columns", opts.grid_columns.join(","));
	if (opts.grid_column_definitions) {
		const definitions_json = JSON.stringify(opts.grid_column_definitions);
		const encoded_definitions = encodeURIComponent(definitions_json);
		const shell_safe_definitions = encoded_definitions.replaceAll("'", "%27");
		args.push("--grid-column-definitions", shell_safe_definitions);
	}

	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn(["bun", ...args], {
			cwd: process.cwd(),
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await update_run(run_id, { ok: false, output: "", error: message });
		await clear_busy(table);
		return;
	}

	// Consume both pipes or a verbose generation can block when the OS pipe fills.
	// Keeping the streams in the parent also lets the completed operation replace
	// the short "started in background" placeholder in the run log.
	const stdout_stream = proc.stdout;
	const stderr_stream = proc.stderr;
	const stdout_promise = typeof stdout_stream === "object" && stdout_stream !== null
		? new Response(stdout_stream).text()
		: Promise.resolve("");
	const stderr_promise = typeof stderr_stream === "object" && stderr_stream !== null
		? new Response(stderr_stream).text()
		: Promise.resolve("");
	const completion = Promise.all([proc.exited, stdout_promise, stderr_promise]);

	void completion.then(async ([exit_code, stdout, stderr]) => {
		const output = clean_output([stdout, stderr]);
		const error = exit_code === 0
			? undefined
			: `CRUD generation for "${table}" failed with exit code ${exit_code}. See the captured generator output below.`;
		await update_run(run_id, { ok: exit_code === 0, output, error });
		await clear_busy(table);
		if (exit_code !== 0) {
			console.error(`[reeman] ${error}`);
			if (output) console.error(`[reeman] Generator output for ${table}:\n${output}`);
		}
	}).catch(async (err) => {
		const message = err instanceof Error ? err.message : String(err);
		await update_run(run_id, { ok: false, output: "", error: `Failed to collect ${action} output for "${table}": ${message}` });
		await clear_busy(table);
		console.error(`[reeman] Failed to collect ${action} output for ${table}: ${message}`);
	});

	// Unref so the server process can exit without waiting for the child.
	proc.unref();
}

/** Spawn a single table CRUD generation as a subprocess. Returns false (no-op) if `table` is already busy. */
export async function spawn_crud_action(table: string, opts: { force?: boolean; translate?: boolean; prefix?: string; route_name?: string; pagination?: string; render_strategy?: string; template_tags?: string; grid_columns?: string[]; grid_column_definitions?: GridColumnDefinition[]; }): Promise<boolean> {
	const acquired = await set_busy(table, { action: "crud", target: table });
	if (!acquired) return false;
	const run_id = await record_run({ action: "crud", target: table, ok: true, output: "Generation started in background." });
	await spawn_one(table, opts, run_id, "crud");
	return true;
}

/** Spawn multiple table CRUD generations as subprocesses, one busy key per table. Tables already busy are skipped; returns the tables actually started. */
export async function spawn_bulk_action(tables: string[], opts: { force?: boolean; translate?: boolean; prefix?: string; pagination?: string; render_strategy?: string; template_tags?: string; }): Promise<string[]> {
	const started: string[] = [];
	for (const table of tables) {
		const acquired = await set_busy(table, { action: "bulk", target: table });
		if (!acquired) continue;
		const run_id = await record_run({ action: "bulk", target: table, ok: true, output: "Generation started in background." });
		await spawn_one(table, opts, run_id, "bulk");
		started.push(table);
	}
	return started;
}
