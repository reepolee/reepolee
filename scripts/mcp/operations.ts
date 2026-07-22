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
import { add_language_to_system } from "$generator/add_language";
import { remove_language_from_system } from "$generator/remove_language";
import { generate_schema } from "$generator/schema";
import { generate_crud } from "$generator/crud/main";
import { run_full_pipeline, run_bulk_generator, run_bulk_nested_generator } from "$generator/reeman/callers/resource_caller";
import { sync_all_namespaces } from "$generator/translate_namespace";
import { create_user } from "$generator/user_lib";
import { db } from "$config/db";
import { db_cli } from "$config/db_cli";
import { find_orphaned_keys, write_prune_sql } from "$generator/reeman/prune_translations";
import { find_missing_keys, write_missing_sql } from "$generator/reeman/sync_missing_translations";
import { invalidate_cache, load_ddl_cache } from "$generator/ddl_cache";
import { assert_mcp_mutation_enabled } from "./capabilities";

// ---------------------------------------------------------------------------
// Capture output helper
// ---------------------------------------------------------------------------

export function capture_output<T>(fn: () => Promise<T>): { stdout: string[]; stderr: string[]; fn: () => Promise<T>; } {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const orig_log = console.log;
	const orig_error = console.error;

	console.log = (...msgs) => {
		const line = msgs.map((m: any) => (typeof m === "string" ? m : Bun.inspect(m))).join(" ");
		stdout.push(line);
		orig_log(...msgs);
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
			console.log = orig_log;
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
async function run_captured(fn: () => Promise<any>): Promise<{ success: boolean; stdout: string; stderr: string; }> {
	const cap = capture_output(fn);
	try {
		const result = await cap.fn();
		return { success: result !== false, stdout: cap.stdout.join("\n"), stderr: cap.stderr.join("\n") };
	} catch (e: any) {
		cap.stderr.push(e.message);
		return { success: false, stdout: cap.stdout.join("\n"), stderr: cap.stderr.join("\n") };
	}
}

// ---------------------------------------------------------------------------
// Generator runner
// ---------------------------------------------------------------------------

export async function run_generator(name: string, args: string[] = []): Promise<{ success: boolean; stdout: string; stderr: string; }> {
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

	return run_captured(async () => {
		switch (name) {
			case "add_language":
				{
					const lang_code = positional();
					if (!lang_code) throw new Error("Language code is required");
					return await add_language_to_system(lang_code, { translate: has_flag("--translate") });
				}
			case "remove_language":
				{
					const lang_code = positional();
					if (!lang_code) throw new Error("Language code is required");
					return await remove_language_from_system(lang_code, {
						force: has_flag("--force"),
						new_default: flag_val("--new-default"),
					});
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
						translate: has_flag("--translate"),
						prefix: flag_val("--prefix"),
						parent_table: flag_val("--parent"),
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
						translate: has_flag("--translate"),
					});
				}
			case "bulk":
				{
					const tables = non_flag_args();
					if (tables.length === 0) throw new Error("At least one table name is required");
					const prefix = flag_val("--prefix") || "";
					const result = await run_bulk_generator(tables, prefix, has_flag("--translate"));
					return result.fail === 0;
				}
			case "nested":
				{
					const tables = non_flag_args();
					const parent = flag_val("--parent");
					if (!parent) throw new Error("Parent table (--parent) is required");
					if (tables.length === 0) throw new Error("At least one child table name is required");
					const prefix = flag_val("--prefix") || "";
					const result = await run_bulk_nested_generator(tables, parent, prefix);
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
	const redis_url = Bun.env.REDIS_URL;
	if (!redis_url) { return { enabled: false, message: "REDIS_URL not set. Queue is disabled." }; }

	try {
		const RedisClient = Bun.RedisClient;
		const prefix = redis_url.startsWith("redis://") || redis_url.startsWith("rediss://") ? "" : "redis://";
		const conn = new RedisClient(`${prefix}${redis_url}`);

		const queue_keys_result = await conn.send("KEYS", ["queue:*"]);
		const queue_keys: string[] = (queue_keys_result as any[])?.map((k: any) => String(k)) || [];

		const queues: Record<string, any> = {};
		for (const key of queue_keys) {
			if (key.includes(":delayed") || key.includes(":failed")) continue;
			const queue_name = key.replace("queue:", "");
			const length = await conn.send("LLEN", [key]);
			queues[queue_name] = { length: Number(length) };
		}

		for (const key of queue_keys) {
			if (key.includes(":delayed")) {
				const queue_name = key.replace("queue:", "").replace(":delayed", "");
				if (!queues[queue_name]) queues[queue_name] = {};
				const count = await conn.send("ZCARD", [key]);
				queues[queue_name].delayed = Number(count);
			}
			if (key.includes(":failed")) {
				const queue_name = key.replace("queue:", "").replace(":failed", "");
				if (!queues[queue_name]) queues[queue_name] = {};
				const count = await conn.send("ZCARD", [key]);
				queues[queue_name].failed = Number(count);
			}
		}

		let running_count = 0;
		const running_keys_result = await conn.send("KEYS", ["queue:running"]);
		const running_keys: string[] = (running_keys_result as any[])?.map((k: any) => String(k)) || [];
		for (const key of running_keys) {
			const count = await conn.send("SCARD", [key]);
			running_count += Number(count);
		}

		await conn.close();

		return { enabled: true, running_jobs: running_count, queues };
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
	return run_captured(async () => {
		if (options.refresh_fields) {
			return await generate_crud(table, {
				refresh_fields: true,
				translate: options.translate ?? false,
				prefix: options.prefix,
				parent_table: options.parent_table,
				route_name: options.route_name,
			});
		}
		return await generate_crud(table, {
			force: true,
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
 * Scan .ree templates and find DB translation keys no longer referenced.
 * Returns the orphan list and stats. When write_sql is true, also writes a
 * timestamped DELETE .sql file for manual review and returns its path.
 */
export async function prune_translations(write_sql = false): Promise<{ orphans: any[]; stats: any; sql_path: string | null; }> {
	if (write_sql) { assert_mcp_mutation_enabled(); }
	const cwd = process.cwd();
	const routes_dir = join(cwd, "routes");
	const public_dir = join(cwd, "public");

	const result = await find_orphaned_keys(db_cli, [routes_dir, public_dir], cwd);

	let sql_path: string | null = null;
	if (write_sql && result.orphans.length > 0) {
		const written = write_prune_sql(result.orphans, cwd);
		sql_path = written.path;
	}

	return { orphans: result.orphans, stats: result.stats, sql_path };
}

/**
 * Scan .ree templates and find translation keys referenced but missing from
 * the DB. Returns the missing list and stats. When write_sql is true, also
 * writes a timestamped INSERT .sql file for manual review and returns its path.
 */
export async function sync_missing_translations(write_sql = false): Promise<{ missing: any[]; stats: any; sql_path: string | null; }> {
	if (write_sql) { assert_mcp_mutation_enabled(); }
	const cwd = process.cwd();
	const routes_dir = join(cwd, "routes");
	const public_dir = join(cwd, "public");

	const result = await find_missing_keys(db_cli, [routes_dir, public_dir], cwd);

	let sql_path: string | null = null;
	if (write_sql && result.missing.length > 0) {
		const written = write_missing_sql(result.missing, cwd);
		sql_path = written.path;
	}

	return { missing: result.missing, stats: result.stats, sql_path };
}

// ---------------------------------------------------------------------------
// Add translations
// ---------------------------------------------------------------------------

export type TranslationEntry = { lang: string; namespace: string; key_path: string; translation: string; };

export async function add_translations(entries: TranslationEntry[]): Promise<{ inserted: number; skipped: number; }> {
	assert_mcp_mutation_enabled();
	let inserted = 0;
	let skipped = 0;

	for (const entry of entries) {
		const existing = await db`SELECT 1 FROM translations WHERE lang = ${entry.lang} AND namespace = ${entry.namespace} AND key_path = ${entry.key_path} LIMIT 1`;
		if (existing.length > 0) {
			skipped++;
			continue;
		}
		await db`INSERT INTO translations (lang, namespace, key_path, translation) VALUES (${entry.lang}, ${entry.namespace}, ${entry.key_path}, ${entry.translation})`;
		inserted++;
	}

	return { inserted, skipped };
}

// ---------------------------------------------------------------------------
// DDL cache rescan
// ---------------------------------------------------------------------------

/**
 * Invalidate and re-introspect the full database (detect new tables, columns,
 * FKs). Returns the number of tables detected.
 */
export async function rescan_ddl_cache(): Promise<{ tables: number; }> {
	assert_mcp_mutation_enabled();
	invalidate_cache();
	const fresh = await load_ddl_cache({ force_refresh: true });
	return { tables: fresh.tables.length };
}
