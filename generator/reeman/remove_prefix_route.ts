#!/usr/bin/env bun
/**
 * Remove prefix folder - delete a whole prefixed folder from routes/
 * including all sub-routes, handlers, imports, and nav translations.
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { db_cli } from "$config/db_cli";
import { notify_server_reload } from "$lib/server_notify";

import { BOLD, color, confirm, CYAN, dim, GREEN, header, RED, select_from_list, show_cli_tip, YELLOW } from "./ui";

// System prefixes that should not be deletable through this tool
const PROTECTED_PREFIXES = ["system", "home"];

/**
 * Remove an entire prefixed route folder (all sub-routes, handlers, imports, nav translations).
 * @param name - prefix folder name to remove (e.g. "admin"). When omitted, prompts for selection.
 * @param force - skip the deletion confirmation prompt (for non-interactive CLI use).
 * @param del_translations_opt - delete DB translation entries for this prefix's namespace.
 *   When omitted, prompts interactively; under force without this set, translations are preserved.
 * @param as_examples - report the run as `remove-examples` in the CLI tip and replay log,
 *   so the logged line matches the verb actually invoked rather than this generic one.
 */
export async function remove_prefix_folder(name?: string, force: boolean = false, del_translations_opt?: boolean, as_examples: boolean = false): Promise<void> {
	const routes_dir = join(process.cwd(), "routes");

	if (!existsSync(routes_dir)) {
		console.log(`  ${color("Routes directory not found.", RED)}`);
		return;
	}

	// Find prefix directories (directories that contain subdirectories)
	const entries = readdirSync(routes_dir);
	const prefix_dirs: { name: string; is_protected: boolean; subdirectories: string[]; }[] = [];

	for (const entry of entries) {
		const entry_path = join(routes_dir, entry);
		if (!statSync(entry_path).isDirectory()) continue;

		// Check if this directory contains subdirectories
		const sub_entries = readdirSync(entry_path);
		const subdirs = sub_entries.filter((sub) => {
			const sub_path = join(entry_path, sub);
			return statSync(sub_path).isDirectory();
		});

		if (subdirs.length > 0) {
			prefix_dirs.push({
				name: entry,
				is_protected: PROTECTED_PREFIXES.includes(entry),
				subdirectories: subdirs,
			});
		}
	}

	if (prefix_dirs.length === 0) {
		console.log(`  ${color("No prefix folders found in routes/.", YELLOW)}`);
		return;
	}

	let selected: { name: string; is_protected: boolean; subdirectories: string[]; } | undefined;

	if (name) {
		selected = prefix_dirs.find((d) => d.name === name);
		if (!selected) {
			console.log(`  ${color(`Prefix folder "${name}" not found in routes/.`, RED)}`);
			return;
		}
	} else {
		header("Select prefix folder to remove");

		const items = prefix_dirs.map((d) => ({
			value: d.name,
			label: `${d.name}/ (${d.subdirectories.length} subdirectories)${d.is_protected ? ` ${color("[PROTECTED]", RED)}` : ""}`,
		}));

		const selected_name = await select_from_list("Select prefix", items);
		selected = prefix_dirs.find((d) => d.name === selected_name);

		if (!selected) {
			console.log(`  ${color("Invalid choice.", RED)}`);
			return;
		}
	}

	if (selected.is_protected) {
		console.log(`\n  ${color("Cannot delete protected prefix folder.", RED)}`);
		console.log(`  ${dim(`"${selected.name}" is a system folder and cannot be removed through this tool.`)}`);
		return;
	}

	console.log(`\n  ${color("✓", GREEN)} Selected: ${color(`${BOLD + selected.name}/`, CYAN)}`);
	console.log(`  ${dim("Will delete these subdirectories:")}`);
	for (const sub of selected.subdirectories) {
		console.log(`    ${color("*", RED)} ${selected.name}/${sub}`);
	}
	console.log();

	const proceed = force || (await confirm(
		`Delete the entire "${selected.name}/" folder and all files inside? This will also remove all related handlers from routes.ts and nav translations. This cannot be undone.`,
		"n"
	));

	if (!proceed) {
		console.log(`  ${color("Cancelled.", YELLOW)}`);
		return;
	}

	// -----------------------------------------------------------------------
	// 1. Remove imports and route entries from routes.ts
	// -----------------------------------------------------------------------
	const routes_path = join(process.cwd(), "routes", "routes.ts");
	let routes_content = "";
	let routes_file_exists = false;

	if (existsSync(routes_path)) {
		routes_content = await Bun.file(routes_path).text();
		routes_file_exists = true;
	}

	if (routes_file_exists) {
		const original_length = routes_content.length;

		// Normalize line endings for consistent regex matching
		const original_has_crlf = routes_content.includes("\r\n");
		routes_content = routes_content.replace(/\r\n/g, "\n");

		// 1. Remove import lines for this prefix (single-line, filter works fine),
		// collecting the local names they bind so their corresponding spread
		// entries can be removed in step 3. Covers both aliased static imports
		// (`import { route_definitions as user_clubs } from "$routes/user/clubs";`)
		// and plain nested-crud imports (`import { user_members_crud } from "$routes/user/members";`).
		const removed_aliases: string[] = [];
		const alias_re = /^import\s*\{\s*(?:[\w]+\s+as\s+([\w]+)|([\w]+))\s*\}/;
		const lines = routes_content.split("\n");
		const filtered_lines = lines.filter((line) => {
			const trimmed = line.trim();
			if (trimmed.startsWith("import ") && (trimmed.includes(`/routes/${selected.name}/`) || trimmed.includes(`$routes/${selected.name}/`))) {
				const alias_match = trimmed.match(alias_re);
				const local_name = alias_match?.[1] ?? alias_match?.[2];
				if (local_name) { removed_aliases.push(local_name); }
				return false;
			}
			return true;
		});
		routes_content = filtered_lines.join("\n");

		// 2. Remove multi-line route_def blocks for this prefix.
		// Blocks are: \t{\n\t\turl: "/<prefix>/...",\n\t\t...\n\t},
		// Line-by-line filtering misses these because { and url: are on separate lines.
		const block_pattern = new RegExp(`\t\\{\n\t\turl: "\\/${selected.name}\\/[^"]*"[\\s\\S]*?\t\\},?`, "g");
		routes_content = routes_content.replace(block_pattern, "");

		// 3. Remove spread lines for aliases whose import was just removed - covers
		// both child crud spreads (...user_equipment_items_crud,) and static
		// route_definitions spreads (...user_clubs,) added by add_static_route_definitions.
		for (const alias of removed_aliases) {
			const spread_pattern = new RegExp(`\n\t\\.\\.\\.${alias},`, "g");
			routes_content = routes_content.replace(spread_pattern, "");
		}

		// Collapse extra blank lines left behind
		routes_content = routes_content.replace(/\n{3,}/g, "\n\n");

		// Restore original line endings
		if (original_has_crlf) { routes_content = routes_content.replace(/\n/g, "\r\n"); }

		if (routes_content.length !== original_length) {
			await Bun.write(routes_path, routes_content);
			console.log(`  ${color("✓", GREEN)} Removed imports and route entries for ${selected.name}/ from routes.ts`);
		} else {
			console.log(`  ${dim("  (no matching imports or route entries found in routes.ts)")}`);
		}
	}

	// -----------------------------------------------------------------------
	// 2. Delete the prefix folder
	// -----------------------------------------------------------------------
	const prefix_path = join(routes_dir, selected.name);
	if (existsSync(prefix_path)) {
		rmSync(prefix_path, { recursive: true, force: true });
		console.log(`  ${color("✓", GREEN)} Deleted folder: ${prefix_path}`);
	} else {
		console.log(`  ${dim("  (folder not found on disk)")}`);
	}

	// -----------------------------------------------------------------------
	// 3. Ask to delete all translations for this prefix from DB
	// -----------------------------------------------------------------------
	let del_translations = false;
	try {
		// Check if any translations exist under this prefix namespace
		const existing = (await db_cli`SELECT COUNT(*) AS cnt FROM translations WHERE namespace = ${selected.name} OR namespace LIKE ${`${selected.name}.%`}`) as { cnt: number; }[];
		const count = existing[0]?.cnt ?? 0;

		if (count > 0) {
			console.log(`\n  Found ${color(String(count), CYAN)} translation entries for prefix "${selected.name}/".`);
			del_translations = del_translations_opt !== undefined
				? del_translations_opt
				: force
					? false
					: await confirm(`Delete all ${count} translation entries from DB?`, "n");

			if (del_translations) {
				await db_cli`DELETE FROM translations WHERE namespace = ${selected.name} OR namespace LIKE ${`${selected.name}.%`}`;
				console.log(`  ${color("✓", GREEN)} Deleted ${count} translation entries for prefix "${selected.name}/"`);
				await notify_server_reload();
			} else {
				console.log(`  ${dim("  (translations preserved)")}`);
			}
		} else {
			console.log(`  ${dim("  (no translations found for this prefix)")}`);
		}
	} catch (err) {
		console.log(`  ${color("✗ Failed to clean up translations:", RED)} ${err instanceof Error ? err.message : err}`);
	}

	console.log(`\n  ${color("✓ Done", GREEN)} Prefix folder "${selected.name}/" removed.`);
	const cli_args = as_examples ? ["--force"] : [selected.name, "--force"];
	if (del_translations) cli_args.push("--delete-translations");
	const cli_verb = as_examples ? "remove-examples" : "remove-prefix-folder";
	await show_cli_tip(`bun reeman ${cli_verb} ${cli_args.join(" ")}`, `Removed prefix folder: ${selected.name}/`);
}

/** The demo/example routes shipped with a fresh project. */
export const EXAMPLES_PREFIX = "examples";

/**
 * Remove the shipped demo routes.
 *
 * A dedicated verb rather than an argument to remove_prefix_folder: deleting
 * the examples is a step every new project takes, and "remove-examples" says
 * that plainly where "remove-prefix-folder examples" reads as an internal
 * detail. The removal itself is identical, so this delegates rather than
 * duplicating any of it.
 */
export async function remove_examples_folder(force: boolean = false, del_translations_opt?: boolean): Promise<void> {
	await remove_prefix_folder(EXAMPLES_PREFIX, force, del_translations_opt, true);
}
