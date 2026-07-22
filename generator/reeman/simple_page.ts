#!/usr/bin/env bun
/**
 * Simple Page generator (no DB, reads data.json)
 */

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { normalize_prefix } from "$lib/route";

import { color, dim, GREEN, RED } from "./ui";
import { finalize_routes_update, sync_nav_translation, sync_prefix_title } from "./utils/nav_sync";
import { add_static_route_definitions } from "./utils/routes_writer";

export async function generate_simple_page(prefix: string, folder_name: string): Promise<void> {
	const { clean: clean_prefix, route: route_prefix } = normalize_prefix(prefix);
	const route_dir = clean_prefix ? join(process.cwd(), "routes", clean_prefix, folder_name) : join(process.cwd(), "routes", folder_name);

	const template_dir = join(process.cwd(), "generator", "simple-page");

	if (!existsSync(template_dir)) {
		console.log(`\n  ${color(`Template directory not found: ${template_dir}`, RED)}`);
		process.exit(1);
	}

	mkdirSync(route_dir, { recursive: true });

	const handler_name = `${folder_name.replace(/-/g, "_")}_page`;

	const template_files = readdirSync(template_dir);

	for (const file of template_files) {
		const source_path = join(template_dir, file);
		const stat = statSync(source_path);

		if (!stat.isFile()) continue;

		let content = await Bun.file(source_path).text();
		content = content.replaceAll("simple-page", folder_name);
		content = content.replaceAll("simple_page_page", handler_name);

		if (file === "index.ts") {
			content = content.replace(`render("${folder_name}"`, `render("index"`);
			const route_url = `${route_prefix}/${folder_name}`;
			const nav_key = clean_prefix ? `${clean_prefix}.${folder_name}` : folder_name;
			const module_prop = clean_prefix ? `, module: "${clean_prefix}"` : "";
			const routedef_import = `import type { RouteDefinition } from "$lib/route_builder";`;
			if (!content.includes(routedef_import)) {
				const lines = content.split("\n");
				const last_import = lines.findLastIndex((l) => l.trim().startsWith("import "));
				lines.splice(last_import + 1, 0, routedef_import);
				content = lines.join("\n");
			}
			content += `\nexport const route_definitions: RouteDefinition[] = [\n\t{ url: "${route_url}", handler: ${handler_name}, nav_title_key: "${nav_key}"${module_prop} },\n];\n`;
		}

		const target_path = join(route_dir, file);
		await Bun.write(target_path, content);
		console.log(`  ${color("✓", GREEN)} Created ${file}`);
	}

	// Update routes.ts via shared helpers
	const routes_path = join(process.cwd(), "routes", "routes.ts");
	const routes_exists = await Bun.file(routes_path).exists();
	let _deferred_routes_content: string | null = null;

	if (routes_exists) {
		let routes_content = await Bun.file(routes_path).text();
		let routes_modified = false;

		const import_path = clean_prefix ? `${clean_prefix}/${folder_name}` : `${folder_name}`;
		const load_result = add_static_route_definitions(routes_content, import_path);
		routes_content = load_result.content;
		if (load_result.modified) routes_modified = true;

		if (routes_modified) {
			_deferred_routes_content = routes_content;
		} else {
			console.log(`  ${dim("  (routes.ts already up to date)")}`);
		}
	}

	// Sync nav translation + prefix title to DB
	const nav_key = clean_prefix ? `${clean_prefix}.${folder_name}` : folder_name;
	const nav_label = folder_name.replace(/_/g, " ").replace(/-/g, " ");
	const label_capitalized = nav_label.charAt(0).toUpperCase() + nav_label.slice(1);

	await Promise.all([sync_nav_translation(nav_key, label_capitalized), sync_prefix_title(clean_prefix)]);

	// Write deferred routes.ts and reload server
	await finalize_routes_update(routes_path, _deferred_routes_content);

	console.log(`\n  ${color("✓ Done", GREEN)} Simple page "${folder_name}" created at ${route_dir}`);
	console.log(`  ${dim("Route translations are synced to the DB by the generator. Edit via system/translations admin UI.")}`);
}
