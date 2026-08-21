#!/usr/bin/env bun
/**
 * MCP Server - Operations helpers
 *
 * Provides background operations: generator runner, translation reload,
 * queue status, test runner, and static site builder.
 */

import { join } from "node:path";

import { spawnSync } from "bun";
import { list_generators } from "./project";
import { add_locale_to_system } from "$generator/add_locale";
import { sync_locale_tables_command } from "$generator/reeman/sync_locale_tables";
import { remove_locale_from_system } from "$generator/remove_locale";
import { generate_schema } from "$generator/schema";
import { generate_crud } from "$generator/crud/main";
import { create_bread_detailed, create_localized_bread_detailed } from "$generator/crud/create_bread";
import type { SyntheticSchema } from "$generator/schema/types";
import { run_full_pipeline, run_bulk_generator, run_bulk_nested_generator } from "$generator/reeman/callers/resource_caller";
import { sync_all_namespaces, sync_single_namespace } from "$generator/translate_namespace";
import { notify_server_reload } from "$lib/server_notify";
import { create_user } from "$generator/user_lib";
import { find_orphaned_keys } from "$generator/reeman/prune_translations";
import { find_missing_keys, write_missing_translations } from "$generator/reeman/insert_translations";
import { invalidate_cache, load_ddl_cache } from "$generator/ddl_cache";
import { assert_mcp_mutation_enabled } from "./capabilities";
import { default_locale, locales } from "$config/supported_locales";
import { delete_file_translation, get_dotted, read_all_translation_rows, read_namespace_file, upsert_file_translation } from "$lib/translation_files";
import { MAIN_APP } from "$config/paths";

// ---------------------------------------------------------------------------
// Capture output helper
// ---------------------------------------------------------------------------

export function capture_output<T>(fn: () => Promise<T>): { stdout: string[]; stderr: string[]; fn: () => Promise<T>; } {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const console_log = console.log;
	const orig_error = console.error;

	console.log = (...msgs) => {
		const line = msgs.map((m: any) => (typeof m === "string" ? m : Bun.inspect(m))).join(" ");
		stdout.push(line);
	};
	console.error = (...msgs) => {
		const line = msgs.map((m: any) => (typeof m === "string" ? m : Bun.inspect(m))).join(" ");
		stderr.push(line);
		orig_error(...msgs);
	};

	const wrapped = async () => {
		try {
			return await fn();
		} finally {
			console.log = console_log;
			console.error = orig_error;
		}
	};

	return { stdout, stderr, fn: wrapped };
}

/**
 * Run `fn` with console output captured, normalizing the result into the
 * { success, stdout, stderr } shape shared by the generator-style tools. A
 * thrown error is appended to stderr and reported as success: false.
 */
async function run_captured(fn: () => Promise<any>): Promise<{ success: boolean; stdout: string; stderr: string; data?: any; }> {
	const cap = capture_output(fn);
	try {
		const result = await cap.fn();
		const success = typeof result === "object" && result !== null && "success" in result ? result.success !== false : result !== false;
		return { success, stdout: cap.stdout.join("\n"), stderr: cap.stderr.join("\n"), data: result };
	} catch (e: any) {
		cap.stderr.push(e.message);
		return { success: false, stdout: cap.stdout.join("\n"), stderr: cap.stderr.join("\n") };
	}
}

// ---------------------------------------------------------------------------
// Generator runner
// ---------------------------------------------------------------------------

export async function run_generator(name: string, args: string[] = [], synthetic_schema?: SyntheticSchema): Promise<{ success: boolean; stdout: string; stderr: string; data?: any; }> {
	assert_mcp_mutation_enabled();
	const generators = list_generators();
	const gen = generators.find((g) => g.name === name);
	if (!gen) { throw new Error(`Generator "${name}" not found. Available: ${generators.map((g) => g.name).join(", ")}`); }

	const flag_val = (flag: string): string | undefined => {
		const idx = args.indexOf(flag);
		return idx >= 0 ? args[idx + 1] : undefined;
	};
	const has_flag = (flag: string): boolean => args.includes(flag);
	const positional = (): string => args.find((a) => !a.startsWith("--")) || "";
	const non_flag_args = (): string[] => args.filter((a) => !a.startsWith("--"));

	// Generators that read the DB schema need a live one. The locale/user
	// generators do not introspect, so they skip the introspection pass.
	const SCHEMA_READING_GENERATORS = new Set(["schema", "crud", "resource", "bulk", "nested", "sync_locale_tables"]);
	if (SCHEMA_READING_GENERATORS.has(name)) { await refresh_ddl_cache_before_generation(); }

	return run_captured(async () => {
		switch (name) {
			case "install_locale":
				{
					const locale_code = positional();
					if (!locale_code) throw new Error("Locale code is required");
					const { install_locale_from_archive } = await import("$generator/install_locale");
					return await install_locale_from_archive(locale_code, { activate: has_flag("--activate") });
				}
			case "add_locale":
				{
					const locale_code = positional();
					if (!locale_code) throw new Error("Locale code is required");
					return await add_locale_to_system(locale_code, { translate: has_flag("--translate") });
				}
			case "remove_locale":
				{
					const locale_code = positional();
					if (!locale_code) throw new Error("Locale code is required");
					return await remove_locale_from_system(locale_code, {
						force: has_flag("--force"),
						new_default: flag_val("--new-default"),
					});
				}
			case "sync_locale_tables":
				{
					// No positional table means "every localized table".
					return await sync_locale_tables_command(positional() || undefined, has_flag("--dry-run"));
				}
			case "schema":
				{
					const target = positional() || "all";
					return await generate_schema(target, {
						prefix: flag_val("--prefix"),
						parent_table: flag_val("--parent"),
					});
				}
			case "crud":
				{
					const table = positional();
					if (!table) throw new Error("Table name is required");
					return await generate_crud(table, {
						force: has_flag("--force"),
						interactive: false,
						translate: has_flag("--translate"),
						prefix: flag_val("--prefix"),
						parent_table: flag_val("--parent"),
					});
				}
			case "create_bread":
			case "create_localized_bread":
				{
					if (!synthetic_schema) throw new Error("synthetic_schema is required");
					const pagination_flag = flag_val("--pagination");
					const render_strategy_flag = flag_val("--render-strategy");
					const template_tags_flag = flag_val("--template-tags");
					const generator = name === "create_localized_bread" ? create_localized_bread_detailed : create_bread_detailed;
					return await generator(synthetic_schema, {
						force: has_flag("--force"),
						interactive: false,
						prefix: flag_val("--prefix"),
						route_name: flag_val("--route-name"),
						pagination_strategy: pagination_flag === "cursor" ? "cursor" : pagination_flag === "offset" ? "offset" : undefined,
						render_strategy: render_strategy_flag === "stream" ? "stream" : render_strategy_flag === "load" ? "load" : undefined,
						template_tags: template_tags_flag === "tags" ? "tags" : template_tags_flag === "flat" ? "flat" : undefined,
					});
				}
			case "resource":
				{
					const table = positional();
					if (!table) throw new Error("Table name is required");
					return await run_full_pipeline(table, {
						prefix: flag_val("--prefix"),
						parent_table: flag_val("--parent"),
						force: has_flag("--force"),
						interactive: false,
						translate: has_flag("--translate"),
					});
				}
			case "bulk":
				{
					const tables = non_flag_args();
					if (tables.length === 0) throw new Error("At least one table name is required");
					const prefix = flag_val("--prefix") || ""; // template_tags=undefined, interactive=false: MCP runs headless, never prompts.
					const result = await run_bulk_generator(tables, prefix, has_flag("--translate"), "offset", "load", undefined, false);
					return result.fail === 0;
				}
			case "nested":
				{
					const tables = non_flag_args();
					const parent = flag_val("--parent");
					if (!parent) throw new Error("Parent table (--parent) is required");
					if (tables.length === 0) throw new Error("At least one child table name is required");
					const prefix = flag_val("--prefix") || ""; // translate=false, template_tags=undefined, interactive=false: MCP runs headless, never prompts.
					const result = await run_bulk_nested_generator(tables, parent, prefix, "offset", "load", false, undefined, false);
					return result.fail === 0;
				}
			case "sync_translations":
				{
					await sync_all_namespaces();
					return true;
				}
			case "user":
				{
					const positional_args = non_flag_args();
					const username = positional_args[0] || "";
					const email = positional_args[1] || "";
					const password = positional_args[2] || "";
					const modules = flag_val("--modules") || "";
					if (!username) throw new Error("Username is required");
					if (!email) throw new Error("Email is required");
					if (!password) throw new Error("Password is required");
					const created = await create_user(username, email, password, modules);
					const modules_display = modules || "(default)";
					console.log(`✓ Created user ${created.username} <${email}> modules: ${modules_display}`);
					return true;
				}
			case "validation":
				{
					console.log("Validation generator is a library module, not a CLI command.");
					return true;
				}
			default:
				throw new Error(`Unknown generator: "${name}"`);
		}
	});
}

// ---------------------------------------------------------------------------
// Translation reload
// ---------------------------------------------------------------------------

export async function reload_translations(): Promise<{ success: boolean; message: string; }> {
	assert_mcp_mutation_enabled();
	const port = Bun.env.PORT || "2338";
	const secret = Bun.env.RELOAD_SECRET;

	try {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (secret) { headers["X-Reload-Secret"] = secret; }

		const response = await fetch(`http://localhost:${port}/__reload-translations`, { method: "POST", headers });

		return {
			success: response.ok,
			message: response.ok ? "Translations reloaded successfully" : `Server responded with ${response.status}`,
		};
	} catch (e: any) {
		return { success: false, message: `Failed to reload translations: ${e.message}` };
	}
}

// ---------------------------------------------------------------------------
// Queue status
// ---------------------------------------------------------------------------

export async function get_queue_status(): Promise<Record<string, any>> {
	// Reads through the queue store API so it reports the real backend - Redis
	// when it is enabled (REDIS_ENABLED=true and REDIS_URL), the SQL database
	// otherwise.
	try {
		const queue = await import("$queue/index");
		if (!queue.is_queue_available()) {
			return { enabled: false, message: "Queue store unavailable." };
		}

		const queue_names = await queue.scan_queue_names();
		const queues: Record<string, any> = {};
		for (const name of queue_names) {
			const [length, failed_ids] = await Promise.all([queue.queue_length(name), queue.get_failed_job_ids(name, 1000)]);
			queues[name] = { length, failed: failed_ids.length };
		}

		const worker_alive = await queue.is_worker_alive();
		return { enabled: true, worker_alive, queues };
	} catch (e: any) {
		return { enabled: true, error: e.message, message: "Queue status read failed" };
	}
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

export async function run_project_tests(filter?: string, timeout = 120): Promise<{ success: boolean; stdout: string; stderr: string; }> {
	const args = ["test"];
	if (filter) { args.push("--filter", filter); }

	const result = spawnSync(["bun", ...args], { timeout: timeout * 1000 });

	return {
		success: result.exitCode === 0,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

// ---------------------------------------------------------------------------
// Domain compliance check
// ---------------------------------------------------------------------------

/**
 * Introspect the live DB and report columns not matching the canonical
 * DOMAIN_TYPES taxonomy. Non-interactive: runs the check and returns the
 * structured report plus captured console output. Never generates SQL.
 */
export async function check_domain_compliance(): Promise<{ compliant: boolean; non_compliant: any[]; unknown: any[]; output: string; }> {
	const checker = await import("$root/scripts/check_domain_compliance");

	const cap = capture_output(async () => await checker.run_check());
	const exit_code = await cap.fn();

	return {
		compliant: exit_code === 0,
		non_compliant: checker.last_non_compliant,
		unknown: checker.last_unknown,
		output: cap.stdout.join("\n"),
	};
}

// ---------------------------------------------------------------------------
// Refresh CRUD - regenerate CRUD for an existing route (non-interactive)
// ---------------------------------------------------------------------------

/**
 * Regenerate CRUD files for a table that already has a schema folder.
 * Mirrors the reeman "Refresh CRUD" command without the prompts: pass
 * refresh_fields to update only .ree field sections, otherwise a full
 * force-overwrite of generated files.
 */
export async function refresh_crud(table: string, options: {
	prefix?: string;
	parent_table?: string;
	route_name?: string;
	refresh_fields?: boolean;
	translate?: boolean;
} = {}): Promise<{ success: boolean; stdout: string; stderr: string; }> {
	assert_mcp_mutation_enabled();
	await refresh_ddl_cache_before_generation();
	return run_captured(async () => {
		if (options.refresh_fields) {
			return await generate_crud(table, {
				refresh_fields: true,
				interactive: false,
				translate: options.translate ?? false,
				prefix: options.prefix,
				parent_table: options.parent_table,
				route_name: options.route_name,
			});
		}
		return await generate_crud(table, {
			force: true,
			interactive: false,
			translate: options.translate ?? false,
			prefix: options.prefix,
			parent_table: options.parent_table,
			route_name: options.route_name,
		});
	});
}

// ---------------------------------------------------------------------------
// Translation maintenance - prune / sync missing (non-interactive)
// ---------------------------------------------------------------------------

/**
 * Scan .ree templates and find file-backed translation keys no longer referenced.
 * Optionally applies deletions to locale files.
 */
export async function prune_translations(apply_changes = false): Promise<{ orphans: any[]; stats: any; applied: boolean; }> {
	if (apply_changes) { assert_mcp_mutation_enabled(); }
	const cwd = process.cwd();
	const routes_dir = join(cwd, MAIN_APP);
	const public_dir = join(cwd, "public");

	const result = await find_orphaned_keys([routes_dir, public_dir], cwd);

	if (apply_changes && result.orphans.length > 0) {
		const rows = await read_all_translation_rows(cwd);
		for (const orphan of result.orphans) {
			const matching_rows = rows.filter((row) => row.namespace === orphan.namespace && row.key_path === orphan.key_path);
			for (const row of matching_rows) await delete_file_translation(row.locale, row.namespace, row.key_path, cwd);
		}
	}

	return { orphans: result.orphans, stats: result.stats, applied: apply_changes };
}

/**
 * Scan .ree templates and find translation keys referenced but missing from
 * locale files. Optionally applies additions to locale files.
 */
export async function insert_translations(apply_changes = false): Promise<{ missing: any[]; stats: any; applied: boolean; }> {
	if (apply_changes) { assert_mcp_mutation_enabled(); }
	const cwd = process.cwd();
	const routes_dir = join(cwd, MAIN_APP);
	const public_dir = join(cwd, "public");
	const components_dir = join(cwd, "components");

	const result = await find_missing_keys([routes_dir, public_dir, components_dir], cwd);

	if (apply_changes && result.missing.length > 0) {
		await write_missing_translations(result.missing, cwd);
	}

	return { missing: result.missing, stats: result.stats, applied: apply_changes };
}

// ---------------------------------------------------------------------------
// Add translations
// ---------------------------------------------------------------------------

export async function sync_translations(translate = false): Promise<{ namespaces: number; translate: boolean; }> {
	assert_mcp_mutation_enabled();
	if (translate) {
		await sync_all_namespaces();
		await notify_server_reload();
		const rows = await read_all_translation_rows();
		const namespaces = new Set(rows.map((row) => row.namespace));
		return { namespaces: namespaces.size, translate };
	}

	const rows = await read_all_translation_rows();
	const namespaces = [...new Set(rows.map((row) => row.namespace))].sort();
	await Promise.all(namespaces.map((namespace) => sync_single_namespace(namespace, false)));
	await notify_server_reload();
	return { namespaces: namespaces.length, translate };
}

export type TranslationEntry = { locale: string; namespace: string; key_path: string; translation: string; };
export type IncompleteTranslationGroup = { locale: string; namespace: string; group: string; missing: string[]; };

async function translation_group_gaps(entries: TranslationEntry[]): Promise<IncompleteTranslationGroup[]> {
	const pairs = new Map<string, { locale: string; namespace: string; proposed_keys: Set<string>; }>();
	for (const entry of entries) {
		const pair_key = `${entry.locale}\u0000${entry.namespace}`;
		let pair = pairs.get(pair_key);
		if (!pair) {
			pair = { locale: entry.locale, namespace: entry.namespace, proposed_keys: new Set() };
			pairs.set(pair_key, pair);
		}
		pair.proposed_keys.add(entry.key_path);
	}

	const incomplete_groups: IncompleteTranslationGroup[] = [];
	for (const pair of pairs.values()) {
		if (pair.locale === default_locale) continue;
		const rows = await read_all_translation_rows();
		const default_rows = rows.filter((row) => row.locale === default_locale && row.namespace === pair.namespace);
		const target_rows = rows.filter((row) => row.locale === pair.locale && row.namespace === pair.namespace);
		const target_keys = new Set(target_rows.map((row) => row.key_path));
		for (const key_path of pair.proposed_keys) target_keys.add(key_path);
		const active_groups = new Set([...target_keys].map((key_path) => key_path.split(".")[0]!));
		for (const group of active_groups) {
			const default_group_keys = default_rows.map((row) => row.key_path).filter((key_path) => key_path.split(".")[0] === group);
			const missing = default_group_keys.filter((key_path) => !target_keys.has(key_path));
			if (missing.length > 0) incomplete_groups.push({ locale: pair.locale, namespace: pair.namespace, group, missing });
		}
	}
	return incomplete_groups;
}

export async function add_translations(entries: TranslationEntry[], require_complete_groups = false): Promise<{ inserted: number; skipped: number; incomplete_groups: IncompleteTranslationGroup[]; empty_entries: Array<{ locale: string; namespace: string; key_path: string; }>; rejected: boolean; }> {
	assert_mcp_mutation_enabled();
	const configured_locales = new Set(locales);
	for (const entry of entries) {
		if (!configured_locales.has(entry.locale as (typeof locales)[number])) throw new Error(`Unsupported locale: ${entry.locale}`);
		// Namespace segments become filesystem path segments in
		// namespace_directory() - restrict them to the same identifier shape as
		// key_path so `..` and other traversal segments are impossible.
		if (!/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/.test(entry.namespace)) throw new Error(`Invalid translation namespace: ${entry.namespace}`);
		if (!/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/.test(entry.key_path)) throw new Error(`Invalid translation key path: ${entry.key_path}`);
	}
	const empty_entries = entries.filter((entry) => entry.translation.trim().length === 0).map((entry) => ({ locale: entry.locale, namespace: entry.namespace, key_path: entry.key_path }));
	const incomplete_groups = await translation_group_gaps(entries);
	if (require_complete_groups && (incomplete_groups.length > 0 || empty_entries.length > 0)) {
		return { inserted: 0, skipped: 0, incomplete_groups, empty_entries, rejected: true };
	}
	let inserted = 0;
	let skipped = 0;

	for (const entry of entries) {
		const obj = await read_namespace_file(entry.namespace, entry.locale);
		const existing = get_dotted(obj, entry.key_path);
		if (existing !== undefined) {
			skipped++;
			continue;
		}
		await upsert_file_translation(entry.locale, entry.namespace, entry.key_path, entry.translation);
		inserted++;
	}

	return { inserted, skipped, incomplete_groups, empty_entries, rejected: false };
}

/**
 * Re-introspect the DB before an operation that generates from the schema.
 *
 * Schema changes are normally made outside the generators (direct mysql/sqlite3
 * calls, migration tools). The MCP server is long-lived, so its in-memory snapshot
 * would otherwise survive for the whole session and every generation would build
 * against a schema that no longer exists - worse than the CLI, where a stale
 * snapshot at least dies with the process.
 */
async function refresh_ddl_cache_before_generation(): Promise<void> {
	invalidate_cache();
	await load_ddl_cache({ force_refresh: true });
}
