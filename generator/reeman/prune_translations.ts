#!/usr/bin/env bun
/**
 * Prune unused translation keys - scan .ree template files for all
 * {= ... } / {~ ... } output refs and {_ ... } / {- ... } translation
 * lookups, find DB keys that are no longer referenced, and output a
 * .sql file with DELETE statements for manual review.
 *
 * Exports:
 * - find_orphaned_keys() - core logic: scan .ree files, compare against DB
 * - write_prune_sql() - write DELETE statements to a .sql file
 * - prune_unused_translations() - reeman wrapper with user prompts
 *
 * How it works:
 * 1. Scans all .ree files in routes/ and public/
 * 2. Extracts ALL {= word }, {~ word }, {_ path } and {- path } template references
 * 3. Maps each file to its DB namespace from the file path
 * 4. Queries DB for all existing (namespace, key_path) pairs
 * 5. Non-translation refs (e.g. {= records.length }) simply won't match
 * 6. Writes orphans to a timestamped .sql file (compatible with MySQL + SQLite)
 *
 * Usage: run from reeman -> review generated SQL file -> run against DB when ready.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { db_cli } from "$config/db_cli";
import type { SQL } from "bun";

import { BOLD, color, confirm, CYAN, dim, GREEN, header, press_enter, YELLOW } from "./ui";

// Exported types

export interface OrphanKey {
	namespace: string;
	key_path: string;
}

export interface OrphanResult {
	orphans: OrphanKey[];
	stats: { files: number; refs: number; db_pairs: number; };
}

// Internal helpers

function find_ree_files(root_dir: string): string[] {
	const files: string[] = [];
	function walk(dir: string) {
		const entries = readdirSync(dir);
		for (const entry of entries) {
			const full = join(dir, entry);
			try {
				const s = statSync(full);
				if (s.isDirectory()) {
					if (entry.startsWith(".")) continue;
					if (entry === "node_modules") continue;
					walk(full);
				} else if (entry.endsWith(".ree")) {
					files.push(full);
				}
			} catch {}
		}
	}
	walk(root_dir);
	return files;
}

function extract_all_refs(content: string): Set<string> {
	const refs = new Set();
	// Match {= expr }/{~ expr } output tags AND {_ path }/{- path } translation
	// lookup tags. The {_ }/{- } paths are bare dotted key_paths resolved against
	// props.translations (no "props." prefix), so they line up directly with the
	// DB key_path column - same shape namespace_from_path() + the ::-join expect.
	const static_re = /\{[=~_-]\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}/g;
	let match;
	while ((match = static_re.exec(content)) !== null) {
		refs.add(match[1]);
	}
	return refs;
}

function namespace_from_path(file_path: string, cwd: string): string {
	const rel = relative(cwd, file_path).replace(/\\/g, "/");
	const parts = rel.split("/");

	if (parts[0] === "public") {
		if (parts.length === 2) return "root";
		return parts.slice(1, -1).join(".");
	}

	if (parts[0] === "routes") {
		const ns_parts = parts.slice(1, -1);
		return ns_parts.length > 0 ? ns_parts.join(".") : "root";
	}

	return "";
}

// Exported core: find orphaned keys

/**
 * Scan .ree template files and compare their {= ... }/{~ ... } output refs
 * and {_ ... }/{- ... } translation lookups against the database to find
 * translation keys that exist in the DB but are never referenced in any template.
 *
 * @param db - SQL database instance (use in-memory SQLite for testing)
 * @param ree_dirs - directories to scan for .ree files
 * @param cwd - current working directory (used for namespace resolution)
 */
export async function find_orphaned_keys(db: SQL, ree_dirs: string[], cwd: string): Promise<OrphanResult> {
	// 1. Discover .ree template files (skip components/ - placeholder keys)
	const all_files: { path: string; namespace: string; }[] = [];

	for (const dir of ree_dirs) {
		if (existsSync(dir)) {
			for (const f of find_ree_files(dir)) {
				all_files.push({ path: f, namespace: namespace_from_path(f, cwd) });
			}
		}
	}

	if (all_files.length === 0) { return { orphans: [], stats: { files: 0, refs: 0, db_pairs: 0 } }; }

	// 2. Extract ALL refs from templates and build in-use set
	const in_use = new Set();
	const all_key_paths = new Set();
	for (const { path, namespace } of all_files) {
		try {
			const content = readFileSync(path, "utf-8");
			const refs = extract_all_refs(content);
			for (const key_path of refs) {
				in_use.add(`${namespace}::${key_path}`);
				all_key_paths.add(key_path);
			}
		} catch {
			// skip unreadable files
		}
	}

	// 2b. Root-namespace keys serve as fallbacks for all templates.
	// If ANY template references a key_path, the root:: version is also
	// considered in-use since the translation engine falls back to it
	// when a namespace doesn't have its own copy.
	// (At merge time, root is replaced by "" - see lib/i18n.ts)
	for (const key_path of all_key_paths) {
		in_use.add(`root::${key_path}`);
	}

	// 2c. Nav entries (key_path = "nav") and prefix titles (key_path = "nav_prefix_title")
	// are system-managed - created by the CRUD generator and used at runtime via
	// the nav_label() helper function, not through direct {= nav } expressions.
	// They cannot be detected by static template scanning, so we always protect them.
	// Also protect route_name keys which are set at generation time.
	// Also protect modules_tags.* keys which are looked up by code.
	const ALWAYS_PROTECTED_KEY_PATHS = new Set(["nav", "nav_prefix_title", "route_name", "parent_label"]);

	// 3. Query DB for existing (namespace, key_path) pairs
	const db_pairs: OrphanKey[] = [];
	const rows = (await db`SELECT DISTINCT namespace, key_path FROM translations`) as { namespace: string; key_path: string; }[];
	for (const row of rows) {
		db_pairs.push({ namespace: row.namespace, key_path: row.key_path });
	}

	// 4. Find orphans - DB keys not referenced in any template
	const orphans = db_pairs.filter(({ namespace, key_path }) => {
		// Skip always-protected system keys (nav entries, etc.)
		if (ALWAYS_PROTECTED_KEY_PATHS.has(key_path)) return false;
		// Skip modules_tags.* keys (looked up by code from tag values)
		if (key_path.endsWith("_tags") || key_path.startsWith("modules_tags")) return false;
		// Skip if referenced in any template
		if (in_use.has(`${namespace}::${key_path}`)) return false;
		return true;
	});

	return {
		orphans,
		stats: { files: all_files.length, refs: in_use.size, db_pairs: db_pairs.length },
	};
}

// Exported core: write .sql file

export interface SqlFileResult {
	path: string;
	count: number;
}

/**
 * Write DELETE statements for orphaned keys to a .sql file.
 *
 * @param orphans - keys to generate DELETE statements for
 * @param output_dir - directory to write the file into
 * @returns the file path and count of statements written
 */
export function write_prune_sql(orphans: OrphanKey[], output_dir: string): SqlFileResult {
	const timestamp = Date.now();
	const sql_path = join(output_dir, `prune_translations_${timestamp}.sql`);

	const sql_lines: string[] = [
		`-- Prune unused translation keys - generated ${new Date().toISOString()}`,
		`-- Review carefully before running against your database.`,
		`-- Found ${orphans.length} unused key(s).`,
		"",
	];

	for (const { namespace, key_path } of orphans) {
		const ns_escaped = namespace.replace(/'/g, "''");
		const kp_escaped = key_path.replace(/'/g, "''");
		sql_lines.push(`DELETE FROM translations WHERE namespace = '${ns_escaped}' AND key_path = '${kp_escaped}';`);
	}

	sql_lines.push("");

	writeFileSync(sql_path, sql_lines.join("\n"), "utf-8");
	return { path: sql_path, count: orphans.length };
}

// reeman wrapper

export async function prune_unused_translations(): Promise<void> {
	header("Prune unused translation keys");

	console.log(`  ${dim("Scans .ree templates for all {= } {~ } {_ } {- } references. Compares against DB.")}`);
	console.log(`  ${dim("Outputs a .sql file with DELETE statements for manual review.")}`);
	console.log();

	const proceed = await confirm("Scan for unused translation keys?", "y");
	if (!proceed) {
		console.log(`  ${color("Cancelled.", YELLOW)}`);
		return;
	}

	console.log();

	const cwd = process.cwd();
	const routes_dir = join(cwd, "routes");
	const public_dir = join(cwd, "public");

	const result = await find_orphaned_keys(db_cli, [routes_dir, public_dir], cwd);

	if (result.stats.files === 0) {
		console.log(`  ${color("No .ree template files found.", YELLOW)}`);
		return;
	}

	console.log(`  ${dim(`Scanned ${result.stats.files} .ree template file(s).`)}`);
	console.log(`  ${dim(`${result.stats.refs} unique reference(s) found in templates.`)}`);
	console.log(`  ${dim(`${result.stats.db_pairs} unique (namespace, key_path) pairs in database.`)}`);
	console.log();

	if (result.orphans.length === 0) {
		console.log(`  ${color("✓ All translation keys are referenced in templates. Nothing to prune.", GREEN)}`);
		return;
	}

	console.log(`  ${color(`Found ${result.orphans.length} unused translation key(s).`, YELLOW)}`);
	console.log();

	// Show preview (grouped by namespace)
	const grouped: Record<string, string[]> = {};
	for (const { namespace, key_path } of result.orphans) {
		if (!grouped[namespace]) grouped[namespace] = [];
		grouped[namespace].push(key_path);
	}

	const ns_entries = Object.entries(grouped).sort((a, b) => a[0].localeCompare(b[0]));
	let preview_count = 0;
	const PREVIEW_MAX = 30;
	let shown_all = true;

	for (const [ns, kps] of ns_entries) {
		for (const kp of kps) {
			if (preview_count >= PREVIEW_MAX) {
				shown_all = false;
				break;
			}
			console.log(`  ${dim(`  ${ns} :: ${kp}`)}`);
			preview_count++;
		}
		if (!shown_all) break;
	}

	if (!shown_all) { console.log(`  ${dim(`  ... and ${result.orphans.length - preview_count} more across ${ns_entries.length} namespace(s)`)}`); }
	console.log();

	// Write .sql file
	const { path: sql_path } = write_prune_sql(result.orphans, cwd);
	const rel_path = relative(cwd, sql_path);

	console.log(`  ${color("✓", GREEN)} Wrote ${result.orphans.length} DELETE statement(s) to:`);
	console.log(`    ${color(BOLD + rel_path, CYAN)}`);
	console.log();
	console.log(`  ${dim("Review the file, then run it via reeman > Database & Config > Run SQL file")}`);
	console.log(`  ${dim("or pipe it to your database CLI:")}`);
	console.log();
	console.log(`    ${color(`${BOLD}mysql -u root -p < ${rel_path}`, CYAN)}`);
	console.log(`    ${color(`${BOLD}sqlite3 ./data.db < ${rel_path}`, CYAN)}`);

	await press_enter();
}
