#!/usr/bin/env bun
/**
 * Sync missing translation keys - scan .ree template files for all
 * translation-like {= ... } / {~ ... } output refs and {_ ... } / {- ... }
 * translation lookups, find keys referenced in templates but missing from
 * the database, and output a .sql file with INSERT statements for manual review.
 *
 * Exports:
 * - find_missing_keys() - core logic: scan .ree files, compare against DB
 * - write_missing_sql() - write INSERT statements to a .sql file
 * - sync_missing_translations() - reeman wrapper with user prompts
 *
 * How it works:
 * 1. Scans all .ree files in routes/ and public/
 * 2. Extracts {= word.subword }, {~ word.subword }, {_ path } and {- path }
 * references and filters to translation-like patterns (labels.*, ui.*,
 * actions.*, etc.) plus known single-word keys
 * 3. Maps each file to its DB namespace from the file path
 * 4. Queries DB for all existing (namespace, key_path) pairs
 * 5. Keys referenced in templates but absent from both the namespace and
 * root fallback are flagged as missing
 * 6. Writes missing keys to a timestamped .sql file with INSERT statements
 * for all active languages (empty translation values, fill in via UI)
 *
 * Usage: run from reeman -> review generated SQL file -> run against DB when ready.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { db_cli } from "$config/db_cli";
import { languages } from "$config/supported_languages";
import type { SQL } from "bun";

import { BOLD, color, confirm, CYAN, dim, GREEN, header, press_enter, YELLOW } from "./ui";

// Constants - known translation sections

const KNOWN_TRANSLATION_SECTIONS = new Set([
	"labels",
	"ui",
	"actions",
	"messages",
	"errors",
	"search",
	"selectors",
	"child_ui",
	"misc",
	"nav",
	"nav_auth",
	"modules_tags",
]);

const KNOWN_SINGLE_WORD_KEYS = new Set(["nav", "route_name", "parent_label", "nav_prefix_title"]);

function is_translation_ref(ref: string): boolean {
	const dot_idx = ref.indexOf(".");
	if (dot_idx !== -1) { return KNOWN_TRANSLATION_SECTIONS.has(ref.slice(0, dot_idx)); }
	return KNOWN_SINGLE_WORD_KEYS.has(ref);
}

// Exported types

export interface MissingKey {
	namespace: string;
	key_path: string;
}

export interface MissingResult {
	missing: MissingKey[];
	stats: { files: number; translation_refs: number; db_pairs: number; };
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
	// lookup tags. The {_ }/{- } paths are bare dotted key_paths (no "props."
	// prefix), so is_translation_ref() and the ::-join line them up directly with
	// the DB key_path column - e.g. {_ labels.email } -> "labels.email".
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

// Exported core: find missing keys

/**
 * Scan .ree template files and find translation-like references - {= ... }/
 * {~ ... } output refs plus {_ ... }/{- ... } translation lookups - that are
 * missing from the database. Checks both the exact namespace
 * match AND the root fallback - a key is truly missing only when neither
 * exists in the DB.
 *
 * @param db - SQL database instance
 * @param ree_dirs - directories to scan for .ree files
 * @param cwd - current working directory (used for namespace resolution)
 */
export async function find_missing_keys(db: SQL, ree_dirs: string[], cwd: string): Promise<MissingResult> {
	// 1. Discover .ree template files
	const all_files: { path: string; namespace: string; }[] = [];

	for (const dir of ree_dirs) {
		if (existsSync(dir)) {
			for (const f of find_ree_files(dir)) {
				all_files.push({ path: f, namespace: namespace_from_path(f, cwd) });
			}
		}
	}

	if (all_files.length === 0) {
		return { missing: [], stats: { files: 0, translation_refs: 0, db_pairs: 0 } };
	}

	// 2. Extract refs from templates, keep only translation-like ones
	const template_refs = new Map();
	// Collect all key_paths to check root fallback too
	const all_translation_key_paths = new Set();

	for (const { path, namespace } of all_files) {
		try {
			const content = readFileSync(path, "utf-8");
			const refs = extract_all_refs(content);
			for (const key_path of refs) {
				if (!is_translation_ref(key_path)) continue;
				if (!template_refs.has(namespace)) { template_refs.set(namespace, new Set()); }
				template_refs.get(namespace)?.add(key_path);
				all_translation_key_paths.add(key_path);
			}
		} catch {
			// skip unreadable files
		}
	}

	let translation_ref_count = 0;
	for (const refs of template_refs.values()) {
		translation_ref_count += refs.size;
	}

	// 3. Query DB for existing (namespace, key_path) pairs
	const db_set = new Set();
	const rows = (await db`SELECT DISTINCT namespace, key_path FROM translations`) as { namespace: string; key_path: string; }[];

	for (const row of rows) {
		db_set.add(`${row.namespace}::${row.key_path}`);
	}

	// 4. Find missing keys - ref'd in templates but neither in the
	// specific namespace NOR in root fallback
	const missing: MissingKey[] = [];

	for (const [namespace, key_paths] of template_refs) {
		for (const key_path of key_paths) {
			const exact_key = `${namespace}::${key_path}`;
			const root_fallback_key = `root::${key_path}`;

			// Skip if exact match exists in DB
			if (db_set.has(exact_key)) continue;

			// Skip if root fallback exists (namespace != root)
			if (namespace !== "root" && db_set.has(root_fallback_key)) continue;

			missing.push({ namespace, key_path });
		}
	}

	return {
		missing,
		stats: {
			files: all_files.length,
			translation_refs: translation_ref_count,
			db_pairs: rows.length,
		},
	};
}

// Exported core: write .sql file

export interface SqlFileResult {
	path: string;
	count: number;
}

/**
 * Write INSERT statements for missing translation keys to a .sql file.
 * Generates one row per active language with an empty translation value.
 *
 * @param missing - keys to generate INSERT statements for
 * @param output_dir - directory to write the file into
 * @returns the file path and count of INSERT statements written
 */
export function write_missing_sql(missing: MissingKey[], output_dir: string): SqlFileResult {
	const timestamp = Date.now();
	const sql_path = join(output_dir, `sync_missing_translations_${timestamp}.sql`);

	const total_rows = missing.length * languages.length;

	const sql_lines: string[] = [
		`-- Sync missing translation keys - generated ${new Date().toISOString()}`,
		`-- Review carefully before running against your database.`,
		`-- Found ${missing.length} missing key(s), will insert ${total_rows} row(s)`,
		`-- (one per active language: ${languages.join(", ")})`,
		`-- Fill in empty translation values via the Translations admin UI after importing.`,
		"",
		"INSERT INTO translations (lang, namespace, key_path, translation) VALUES",
	];

	const values: string[] = [];
	for (const { namespace, key_path } of missing) {
		const ns_escaped = namespace.replace(/'/g, "''");
		const kp_escaped = key_path.replace(/'/g, "''");
		for (const lang of languages) {
			values.push(`('${lang}', '${ns_escaped}', '${kp_escaped}', '')`);
		}
	}

	sql_lines.push(values.join(",\n"));
	sql_lines.push(";");
	sql_lines.push("");

	writeFileSync(sql_path, sql_lines.join("\n"), "utf-8");
	return { path: sql_path, count: total_rows };
}

// reeman wrapper

export async function sync_missing_translations(): Promise<void> {
	header("Sync missing translation keys");

	console.log(`  ${dim("Scans .ree templates for translation-like {= } {~ } {_ } {- } references not in DB.")}`);
	console.log(`  ${dim("Outputs a .sql file with INSERT statements for manual review.")}`);
	console.log();
	console.log(`  ${dim("Only true missing keys are flagged - if a key exists as a root fallback,")}`);
	console.log(`  ${dim("it won't appear here since the system resolves it at runtime.")}`);
	console.log();

	const proceed = await confirm("Scan for missing translation keys?", "y");
	if (!proceed) {
		console.log(`  ${color("Cancelled.", YELLOW)}`);
		return;
	}

	console.log();

	const cwd = process.cwd();
	const routes_dir = join(cwd, "routes");
	const public_dir = join(cwd, "public");

	const result = await find_missing_keys(db_cli, [routes_dir, public_dir], cwd);

	if (result.stats.files === 0) {
		console.log(`  ${color("No .ree template files found.", YELLOW)}`);
		return;
	}

	console.log(`  ${dim(`Scanned ${result.stats.files} .ree template file(s).`)}`);
	console.log(`  ${dim(`${result.stats.translation_refs} translation-like reference(s) found in templates.`)}`);
	console.log(`  ${dim(`${result.stats.db_pairs} unique (namespace, key_path) pairs in database.`)}`);
	console.log();

	if (result.missing.length === 0) {
		console.log(`  ${color("✓ All translation keys referenced in templates exist in the database (or root fallback). Nothing to sync.", GREEN)}`);
		return;
	}

	console.log(`  ${color(`Found ${result.missing.length} missing translation key(s).`, YELLOW)}`);
	console.log();

	// Show preview (grouped by namespace)
	const grouped: Record<string, string[]> = {};
	for (const { namespace, key_path } of result.missing) {
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

	if (!shown_all) { console.log(`  ${dim(`  ... and ${result.missing.length - preview_count} more across ${ns_entries.length} namespace(s)`)}`); }
	console.log();

	// Write .sql file
	const total_rows = result.missing.length * languages.length;
	const { path: sql_path } = write_missing_sql(result.missing, cwd);
	const rel_path = relative(cwd, sql_path);

	console.log(`  ${color("✓", GREEN)} Wrote ${total_rows} INSERT row(s) across ${languages.length} language(s) to:`);
	console.log(`    ${color(BOLD + rel_path, CYAN)}`);
	console.log();
	console.log(`  ${dim("Review the file, then run it via reeman > Database & Config > Run SQL file")}`);
	console.log(`  ${dim("or pipe it to your database CLI:")}`);
	console.log();
	console.log(`    ${color(`${BOLD}mysql -u root -p < ${rel_path}`, CYAN)}`);
	console.log(`    ${color(`${BOLD}sqlite3 ./data.db < ${rel_path}`, CYAN)}`);
	console.log();
	console.log(`  ${dim("After importing, fill in translation values via the Translations admin UI.")}`);

	await press_enter();
}
