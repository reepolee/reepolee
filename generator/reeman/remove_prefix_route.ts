#!/usr/bin/env bun
/**
 * Remove prefix folder - delete a whole prefixed folder from routes/
 * including all sub-routes, handlers, imports, and nav translations.
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { db_cli } from "$config/db_cli";
import { notify_server_reload } from "$lib/server_notify";

import { BOLD, color, confirm, CYAN, dim, GREEN, header, RED, select_from_list, YELLOW } from "./ui";

// System prefixes that should not be deletable through this tool
const PROTECTED_PREFIXES = ["system", "home"];

export async function remove_prefix_folder(): Promise<void> {
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

	header("Select prefix folder to remove");

	const items = prefix_dirs.map((d) => ({
		value: d.name,
		label: `${d.name}/ (${d.subdirectories.length} subdirectories)${d.is_protected ? ` ${color("[PROTECTED]", RED)}` : ""}`,
	}));

	const selected_name = await select_from_list("Select prefix", items);
	const selected = prefix_dirs.find((d) => d.name === selected_name);

	if (!selected) {
		console.log(`  ${color("Invalid choice.", RED)}`);
		return;
	}

	if (selected.is_protected) {
		console.log(`\n  ${color("Cannot delete protected prefix folder.", RED)}`);
		console.log(`  ${dim(`"${selected.name}" is a system folder and cannot be removed through this tool.`)}`);
		return;
	}

	console.log(`\n  ${color("✓", GREEN)} Selected: ${color(`${BOLD + selected.name}/`, CYAN)}`);
	console.log(`  ${dim("Will delete these subdirectories:")}`);
	for (const sub of selected.subdirectories) {
		console.log(`    ${color("•", RED)} ${selected.name}/${sub}`);
	}
	console.log();

	const proceed = await confirm(
		`Delete the entire "${selected.name}/" folder and all files inside? This will also remove all related handlers from routes.ts and nav translations. This cannot be undone.`,
		"n"
	);

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

		// 1. Remove import lines for this prefix (single-line, filter works fine)
		const lines = routes_content.split("\n");
		const filtered_lines = lines.filter((line) => {
			const trimmed = line.trim();
			if (trimmed.startsWith("import ") && (trimmed.includes(`/routes/${selected.name}/`) || trimmed.includes(`$routes/${selected.name}/`))) { return false; }
			return true;
		});
		routes_content = filtered_lines.join("\n");

		// 2. Remove multi-line route_def blocks for this prefix.
		// Blocks are: \t{\n\t\turl: "/<prefix>/...",\n\t\t...\n\t},
		// Line-by-line filtering misses these because { and url: are on separate lines.
		const block_pattern = new RegExp(`\t\\{\n\t\turl: "\\/${selected.name}\\/[^"]*"[\\s\\S]*?\t\\},?`, "g");
		routes_content = routes_content.replace(block_pattern, "");

		// 3. Remove child crud spread lines (e.g. ...user_equipment_items_crud,)
		// inside the GENERATED CHILD CRUD section that belong to this prefix.
		const child_crud_pattern = new RegExp(`\n\t\\.\\.\\.${selected.name}_[\\w]+_crud,`, "g");
		routes_content = routes_content.replace(child_crud_pattern, "");

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
	try {
		// Check if any translations exist under this prefix namespace
		const existing = (await db_cli`SELECT COUNT(*) AS cnt FROM translations WHERE namespace = ${selected.name} OR namespace LIKE ${`${selected.name}.%`}`) as { cnt: number; }[];
		const count = existing[0]?.cnt ?? 0;

		if (count > 0) {
			console.log(`\n  Found ${color(String(count), CYAN)} translation entries for prefix "${selected.name}/".`);
			const del_translations = await confirm(`Delete all ${count} translation entries from DB?`, "n");

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
}
