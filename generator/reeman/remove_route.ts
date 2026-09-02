#!/usr/bin/env bun
/**
 * Remove route - delete a registered route (folder, imports, nav)
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { notify_server_reload } from "$lib/server_notify";

import { BOLD, color, confirm, CYAN, dim, GREEN, header, multi_select, RED, show_cli_tip, YELLOW } from "./ui";
import { MAIN_APP } from "$config/paths";

interface ParsedEntry {
	url: string;
	handler: string;
	line_idx: number;
	end_line: number;
	module: string;
}

// System prefixes that should not be deletable
const PROTECTED_PREFIXES = ["system", "home"];

function parse_entries(raw: string): ParsedEntry[] {
	const entries: ParsedEntry[] = [];
	const sys_modules = ["system"];
	const lines = raw.split("\n");

	let i = 0;
	while (i < lines.length) {
		const trimmed = lines[i]!.trim();

		if (!trimmed || trimmed.startsWith("//")) {
			i++;
			continue;
		}

		// Static route_definitions pattern: ...alias, with import { route_definitions as alias } at top
		const static_spread_match = trimmed.match(/^\.\.\.([\w]+),$/);
		if (static_spread_match) {
			const alias = static_spread_match[1]!;
			const import_match = raw.match(new RegExp(`import \\{ route_definitions as ${alias} \\} from "\\$main/([^"]+)"`));
			if (import_match) {
				const route_path = import_match[1]!;
				const parts = route_path.split("/");
				const mod = parts.length > 1 ? parts[0]! : "";
				entries.push({
					url: `/${route_path}`,
					handler: alias,
					line_idx: i,
					end_line: i,
					module: mod,
				});
				i++;
				continue;
			}
		}

		// Legacy pattern: { url: "...", crud: name, ... } single-line
		const single_match = trimmed.match(/^\{\s*url:\s*"([^"]+)"\s*,\s*(?:handler|crud|resource):\s*(\w+)/);
		if (single_match) {
			const module_match = trimmed.match(/module:\s*"([^"]+)"/);
			entries.push({
				url: single_match[1]!,
				handler: single_match[2]!,
				line_idx: i,
				end_line: i,
				module: module_match ? module_match[1]! : "",
			});
			i++;
			continue;
		}

		// Legacy pattern: multi-line block starting with bare "{"
		if (trimmed === "{") {
			const start_line = i;
			let block = "";
			let brace_depth = 0;

			while (i < lines.length) {
				const line = lines[i]!;
				block += `${line}\n`;
				for (const ch of line) {
					if (ch === "{") brace_depth++;
					if (ch === "}") brace_depth--;
				}
				if (brace_depth === 0) {
					const url_match = block.match(/url:\s*"([^"]+)"/);
					const handler_match = block.match(/(?:handler|crud|resource):\s*(\w+)/);
					if (url_match && handler_match) {
						const module_match = block.match(/module:\s*"([^"]+)"/);
						entries.push({
							url: url_match[1]!,
							handler: handler_match[1]!,
							line_idx: start_line,
							end_line: i,
							module: module_match ? module_match[1]! : "",
						});
					}
					i++;
					break;
				}
				i++;
			}
			continue;
		}

		i++;
	}

	return entries;
}

/**
 * Delete a single already-selected route (folder, imports, nav, optionally translations).
 * Re-reads routes.ts fresh AND re-parses it so repeated calls (e.g. from a multi-select
 * batch) never splice using line_idx/end_line computed against an earlier, longer
 * version of the file - a prior removal in the same batch shifts every later entry's
 * line numbers, so the caller-supplied indices on `selected` cannot be trusted here.
 */
async function remove_single_route(selected: ParsedEntry, del_translations_opt: boolean | undefined, force: boolean, notify_server: boolean): Promise<void> {
	const routes_path = join(process.cwd(), MAIN_APP, "routes.ts");
	const raw = await Bun.file(routes_path).text();

	let routes_content = raw;
	let modified = false;
	const url_path = selected.url.replace(
		/^\//,
		""
	);

	// Re-locate this entry in the freshly-read content - `selected` may carry
	// line_idx/end_line from a batch-wide parse taken before earlier removals
	// in this same run shifted the file.
	const current_entry = parse_entries(raw).find((e) => e.url === selected.url && e.handler === selected.handler);
	if (!current_entry) {
		console.log(`  ${dim(`  (route entry for ${selected.url} not found - already removed?)`)}`);
	} else {
		// 1. Remove route_def lines (may span multiple lines for multi-line entries)
		// Must run before import removal - current_entry.line_idx/end_line were just
		// computed against this same routes_content, so removing lines above them
		// first would shift the indices and cause the splice below to hit the wrong lines.
		const num_lines = current_entry.end_line - current_entry.line_idx + 1;
		const content_lines = routes_content.split("\n");
		content_lines.splice(current_entry.line_idx, num_lines);
		routes_content = content_lines.join("\n");
		modified = true;
		console.log(`  ${color("✓", GREEN)} Removed route entry for ${selected.url} (${num_lines} line${num_lines > 1 ? "s" : ""})`);
	}

	// 2. Remove import line
	const is_static_route_definitions = routes_content.includes(`route_definitions as ${selected.handler}`);
	if (is_static_route_definitions) {
		const import_re = new RegExp(`import \\{ route_definitions as ${selected.handler} \\} from "[^"]+";\\n?`);
		routes_content = routes_content.replace(import_re, "");
		modified = true;
		console.log(`  ${color("✓", GREEN)} Removed import for ${selected.handler}`);
	} else {
		// Legacy: import { handlerName } from "$main/..."
		const import_re = new RegExp(`import\\s*\\{\\s*${selected.handler}\\s*\\}\\s*from\\s*"\\$main/[^"]+";`);
		const import_match = routes_content.match(import_re);
		if (import_match) {
			routes_content = routes_content.replace(import_re, "");
			modified = true;
			console.log(`  ${color("✓", GREEN)} Removed import for ${selected.handler}`);
		} else {
			console.log(`  ${dim("  (no import line found)")}`);
		}
	}

	// 3. Remove nested child CRUD entries (import + spread) whose import path lives under this route's folder
	const child_import_re = new RegExp(`import \\{ (\\w+) \\} from "\\$main/${url_path}/[^"]+";\\n?`, "g");
	const child_crud_names: string[] = [];
	let child_match: RegExpExecArray | null;
	while ((child_match = child_import_re.exec(routes_content)) !== null) {
		if (child_match[1]) child_crud_names.push(child_match[1]);
	}

	if (child_crud_names.length > 0) {
		routes_content = routes_content.replace(child_import_re, "");
		for (const child_crud_name of child_crud_names) {
			const spread_re = new RegExp(`\\t*\\.\\.\\.${child_crud_name},\\n?`);
			routes_content = routes_content.replace(spread_re, "");
			console.log(`  ${color("✓", GREEN)} Removed nested child CRUD entry: ${child_crud_name}`);
		}
		modified = true;
	}

	if (modified) {
		routes_content = routes_content.replace(/\n{3,}/g, "\n\n");
		await Bun.write(routes_path, routes_content);
		console.log(`  ${color("✓", GREEN)} Updated routes.ts`);
	}

	// 4. Delete route folder
	const route_dir = join(process.cwd(), MAIN_APP, url_path);

	if (existsSync(route_dir)) {
		// force:true only suppresses "path does not exist" - a locked file (e.g.
		// EPERM from a live watcher/import holding a handle, common on Windows)
		// still throws, but can also leave the directory partially deleted
		// without throwing at all. Verify afterward rather than trust the call.
		try {
			rmSync(route_dir, { recursive: true, force: true });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`Failed to delete folder ${route_dir}: ${message} (a running process may have a file open in this folder - stop the dev server and retry)`);
		}
		if (existsSync(route_dir)) {
			throw new Error(`Folder ${route_dir} still exists after deletion - a running process likely has a file open in it (stop the dev server and retry)`);
		}
		console.log(`  ${color("✓", GREEN)} Deleted folder: ${route_dir}`);
	} else {
		console.log(`  ${dim("  (folder not found on disk)")}`);
	}

	// 5. Clean up route translations from DB
	const namespace = selected.url.replace(
		/^\//,
		""
	).replace(
		/\//g,
		"."
	);
	const child_namespace_note = child_crud_names.length > 0 ? ` (and its ${child_crud_names.length} nested child namespace${child_crud_names.length > 1 ? "s" : ""})` : "";
	console.log(`\n  Route namespace: ${color(namespace || "(global)", CYAN)}${child_namespace_note}`);
	void del_translations_opt;
	void force;
	const del_translations = true;
	console.log(`  ${color("✓", GREEN)} Co-located translations were removed with namespace "${namespace || "(global)"}"${child_namespace_note}`);
	if (notify_server) await notify_server_reload();

	console.log(`\n  ${color("✓ Done", GREEN)} Route "${selected.url}" removed.`);
	const cli_args = [selected.url, "--force"];
	if (del_translations) cli_args.push("--delete-translations");
	await show_cli_tip(`bun reeman remove-route ${cli_args.join(" ")}`, `Removed route: ${selected.url}`);
}

/**
 * Detect route folders on disk that have no corresponding entry in routes.ts.
 * These are "half-generated" CRUD routes - schema/ folder exists but the
 * generator failed before writing the route entry.
 *
 * Only scans top-level routes/ entries (not nested under prefixes). Nested
 * orphans are cleaned up by remove_prefix_folder which deletes the entire
 * prefix tree.
 */
async function find_orphaned_route_folders(registered_urls: Set<string>): Promise<{ url: string; module: string; }[]> {
	const routes_dir = join(process.cwd(), MAIN_APP);
	if (!existsSync(routes_dir)) return [];

	const orphans: { url: string; module: string; }[] = [];
	const entries = readdirSync(routes_dir);

	for (const entry of entries) {
		if (PROTECTED_PREFIXES.includes(entry)) continue;

		const entry_path = join(routes_dir, entry);
		if (!statSync(entry_path).isDirectory()) continue;

		// A route folder has generated schema metadata or generated .ree/.ts files.
		const has_schema = existsSync(join(entry_path, "schema.generated.ts")) || existsSync(join(entry_path, "config.ts"));
		const has_index_ree = existsSync(join(entry_path, "index.ree"));
		if (!has_schema && !has_index_ree) continue;

		const url = `/${entry}`;
		if (registered_urls.has(url)) continue;

		orphans.push({ url, module: "orphan" });
	}

	return orphans;
}

/**
 * List the routes that can be removed (non-system, non-root), with the module they belong to.
 * Includes orphaned route folders on disk that have no entry in routes.ts.
 * Exported for the reeman web UI so its route picker matches the CLI exactly.
 */
export async function list_removable_routes(): Promise<{ url: string; module: string; }[]> {
	const routes_path = join(process.cwd(), MAIN_APP, "routes.ts");
	const raw = await Bun.file(routes_path).text();
	const sys_modules = ["system"];
	const entries = parse_entries(raw);
	const registered = entries
		.filter((e) => !sys_modules.includes(e.module) && e.url !== "/")
		.map((e) => ({ url: e.url, module: e.module }));

	const registered_urls = new Set(registered.map((r) => r.url));
	const orphans = await find_orphaned_route_folders(registered_urls);

	return [...registered, ...orphans];
}

/**
 * Remove one or more registered routes (folder, imports, nav, optionally translations).
 * @param url - route URL to remove (e.g. "/recipes"). When omitted, prompts for selection
 *   (multi-select when called with no URL and no explicit single route).
 * @param force - skip the deletion confirmation prompt (for non-interactive CLI use).
 * @param del_translations_opt - delete DB translation entries for this route's namespace.
 *   When omitted, prompts interactively; under force without this set, translations are preserved.
 * @param notify_server - trigger the app route reload after removal. Web callers
 *   defer this until after their redirect response is prepared.
 */
export async function remove_route(url?: string, force: boolean = false, del_translations_opt?: boolean, notify_server: boolean = true): Promise<void> {
	const routes_path = join(process.cwd(), MAIN_APP, "routes.ts");
	const raw = await Bun.file(routes_path).text();
	const sys_modules = ["system"];

	const entries = parse_entries(raw);
	const removable = entries.filter((e) => !sys_modules.includes(e.module) && e.url !== "/");

	if (removable.length === 0) {
		console.log(`  ${color("No removable routes found (all routes are system routes).", YELLOW)}`);
		return;
	}

	if (url) {
		const selected = removable.find((e) => e.url === url);
		if (!selected) {
			console.log(`  ${color(`Route "${url}" not found or not removable (system routes cannot be removed).`, RED)}`);
			return;
		}

		console.log(`\n  ${color("✓", GREEN)} Selected: ${color(BOLD + selected.url, CYAN)}`);

		const proceed = force || (await confirm(`Delete route "${selected.url}" and its folder on disk? This cannot be undone.`, "n"));
		if (!proceed) {
			console.log(`  ${color("Cancelled.", YELLOW)}`);
			return;
		}

		// Orphaned routes have no routes.ts entry - just delete the folder.
		if (selected.module === "orphan") {
			await remove_orphan_folder(selected, del_translations_opt, force, notify_server);
		} else {
			await remove_single_route(selected, del_translations_opt, force, notify_server);
		}
		return;
	}

	header("Select routes to remove");

	const items = removable.map((e) => ({
		value: e.url,
		label: `${e.url}${e.module ? ` (${e.module})` : ""} ${String.fromCharCode(8212)} ${e.handler}`,
	}));

	const selected_urls = await multi_select("Select routes (arrows + space + enter)", items);

	if (selected_urls.length === 0) {
		console.log(`  ${color("No routes selected.", YELLOW)}`);
		return;
	}

	const selected_entries = selected_urls
		.map((u) => removable.find((e) => e.url === u))
		.filter((e): e is ParsedEntry => e !== undefined);

	console.log(`\n  ${color("✓", GREEN)} Selected ${selected_entries.length} route(s): ${color(BOLD + selected_entries.map((e) => e.url).join(", "), CYAN)}`);

	const proceed = await confirm(
		selected_entries.length === 1
			? `Delete route "${selected_entries[0]!.url}" and its folder on disk? This cannot be undone.`
			: `Delete ${selected_entries.length} routes and their folders on disk? This cannot be undone.`,
		"n"
	);
	if (!proceed) {
		console.log(`  ${color("Cancelled.", YELLOW)}`);
		return;
	}

	for (const entry of selected_entries) {
		console.log(`\n${color("-".repeat(50), CYAN)}`);
		console.log(`  ${color("Removing:", BOLD)} ${color(BOLD + entry.url, CYAN)}`);
		console.log(`${color("-".repeat(50), CYAN)}`);
		if (entry.module === "orphan") {
			await remove_orphan_folder(entry, del_translations_opt, force, notify_server);
		} else {
			await remove_single_route(entry, del_translations_opt, force, notify_server);
		}
	}
}

/**
 * Delete an orphaned route folder - one that exists on disk but has no entry
 * in routes.ts (half-generated CRUD). Just removes the folder and optionally
 * its translations.
 */
async function remove_orphan_folder(entry: { url: string; module: string; }, del_translations_opt: boolean | undefined, force: boolean, notify_server: boolean): Promise<void> {
	const url_path = entry.url.replace(/^\//, "");
	const route_dir = join(process.cwd(), MAIN_APP, url_path);

	// Delete the folder
	if (existsSync(route_dir)) {
		rmSync(route_dir, { recursive: true, force: true });
		console.log(`  ${color("✓", GREEN)} Deleted orphaned folder: ${route_dir}`);
	} else {
		console.log(`  ${dim("  (folder not found on disk)")}`);
	}

	// Clean up translations
	const namespace = url_path.replace(/\//g, ".");
	void del_translations_opt;
	void force;
	console.log(`  ${color("✓", GREEN)} Co-located translations were removed with namespace "${namespace}"`);
	if (notify_server) await notify_server_reload();

	console.log(`\n  ${color("✓ Done", GREEN)} Orphaned folder "${entry.url}" removed.`);
	await show_cli_tip(`bun reeman remove-route ${entry.url} --force`, `Removed orphaned folder: ${entry.url}`);
}
