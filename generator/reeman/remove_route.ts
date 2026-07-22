#!/usr/bin/env bun
/**
 * Remove route - delete a registered route (folder, imports, nav)
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { db_cli } from "$config/db_cli";
import { notify_server_reload } from "$lib/server_notify";

import { BOLD, color, confirm, CYAN, dim, GREEN, header, RED, select_from_list, YELLOW } from "./ui";

interface ParsedEntry {
	url: string;
	handler: string;
	line_idx: number;
	end_line: number;
	module: string;
}

function parse_entries(raw: string): ParsedEntry[] {
	const entries: ParsedEntry[] = [];
	const sys_modules = ["system"];
	const lines = raw.split("\n");

	let i = 0;
	while (i < lines.length) {
		const trimmed = lines[i].trim();

		if (!trimmed || trimmed.startsWith("//")) {
			i++;
			continue;
		}

		// Static route_definitions pattern: ...alias, with import { route_definitions as alias } at top
		const static_spread_match = trimmed.match(/^\.\.\.([\w]+),$/);
		if (static_spread_match) {
			const alias = static_spread_match[1];
			const import_match = raw.match(new RegExp(`import \\{ route_definitions as ${alias} \\} from "\\$routes/([^"]+)"`));
			if (import_match) {
				const route_path = import_match[1];
				const parts = route_path.split("/");
				const mod = parts.length > 1 ? parts[0] : "";
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
				url: single_match[1],
				handler: single_match[2],
				line_idx: i,
				end_line: i,
				module: module_match ? module_match[1] : "",
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
				const line = lines[i];
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
							url: url_match[1],
							handler: handler_match[1],
							line_idx: start_line,
							end_line: i,
							module: module_match ? module_match[1] : "",
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

export async function remove_route(): Promise<void> {
	const routes_path = join(process.cwd(), "routes", "routes.ts");
	const raw = await Bun.file(routes_path).text();
	const sys_modules = ["system"];

	const entries = parse_entries(raw);
	const removable = entries.filter((e) => !sys_modules.includes(e.module) && e.url !== "/");

	if (removable.length === 0) {
		console.log(`  ${color("No removable routes found (all routes are system routes).", YELLOW)}`);
		return;
	}

	header("Select route to remove");

	const items = removable.map((e) => ({
		value: e.url,
		label: `${e.url}${e.module ? ` (${e.module})` : ""} \u2014 ${e.handler}`,
	}));

	const selected_url = await select_from_list("Select route", items);
	const selected = removable.find((e) => e.url === selected_url);

	if (!selected) {
		console.log(`  ${color("Invalid choice.", RED)}`);
		return;
	}

	console.log(`\n  ${color("✓", GREEN)} Selected: ${color(BOLD + selected.url, CYAN)}`);

	const proceed = await confirm(`Delete route "${selected.url}" and its folder on disk? This cannot be undone.`, "n");

	if (!proceed) {
		console.log(`  ${color("Cancelled.", YELLOW)}`);
		return;
	}

	let routes_content = raw;
	let modified = false;
	const url_path = selected.url.replace(
		/^\//,
		""
	);

	// 1. Remove route_def lines (may span multiple lines for multi-line entries)
	// Must run before import removal - selected.line_idx/end_line were computed
	// against the original file, so removing lines above them first would shift
	// the indices and cause the splice below to hit the wrong lines.
	const num_lines = selected.end_line - selected.line_idx + 1;
	const content_lines = routes_content.split("\n");
	content_lines.splice(selected.line_idx, num_lines);
	routes_content = content_lines.join("\n");
	modified = true;
	console.log(`  ${color("✓", GREEN)} Removed route entry for ${selected.url} (${num_lines} line${num_lines > 1 ? "s" : ""})`);

	// 2. Remove import line
	const is_static_route_definitions = routes_content.includes(`route_definitions as ${selected.handler}`);
	if (is_static_route_definitions) {
		const import_re = new RegExp(`import \\{ route_definitions as ${selected.handler} \\} from "[^"]+";\\n?`);
		routes_content = routes_content.replace(import_re, "");
		modified = true;
		console.log(`  ${color("✓", GREEN)} Removed import for ${selected.handler}`);
	} else {
		// Legacy: import { handlerName } from "$routes/..."
		const import_re = new RegExp(`import\\s*\\{\\s*${selected.handler}\\s*\\}\\s*from\\s*"\\$routes/[^"]+";`);
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
	const child_import_re = new RegExp(`import \\{ (\\w+) \\} from "\\$routes/${url_path}/[^"]+";\\n?`, "g");
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
	const route_dir = join(process.cwd(), "routes", url_path);

	if (existsSync(route_dir)) {
		rmSync(route_dir, { recursive: true, force: true });
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
	const del_translations = await confirm(`Delete all translation entries for namespace "${namespace || "(global)"}"${child_namespace_note} from DB?`, "n");

	if (del_translations) {
		try {
			await db_cli`DELETE FROM translations WHERE namespace = ${namespace} OR namespace LIKE ${`${namespace}.%`}`;
			console.log(`  ${color("✓", GREEN)} Deleted translations for namespace "${namespace || "(global)"}"${child_namespace_note}`);
			await notify_server_reload();
		} catch (err) {
			console.log(`  ${color("✗ Failed to clean up translations:", RED)} ${err instanceof Error ? err.message : err}`);
		}
	} else {
		console.log(`  ${dim("  (translations preserved)")}`);
	}

	console.log(`\n  ${color("✓ Done", GREEN)} Route "${selected.url}" removed.`);
}
