/** Move one standalone CRUD route to a different module prefix. */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { generate_crud } from "../crud/main";
import { snapshot_route_translation_memory } from "../translation_memory";
import { default_locale, locales } from "$config/supported_locales";
import { normalize_prefix } from "$lib/route";
import { notify_server_reload } from "$lib/server_notify";
import { translation_file } from "$lib/translation_files";
import { MAIN_APP } from "$config/paths";

export type MoveRouteResult = { url: string; };

function namespace_for_url(url: string): string {
	return url.replace(/^\//, "").replaceAll("/", ".");
}

async function read_nondefault_translations(namespace: string): Promise<Map<string, string>> {
	const translations = new Map<string, string>();
	for (const locale of locales) {
		if (locale === default_locale) continue;
		const file = translation_file(namespace, locale);
		if (await Bun.file(file).exists()) translations.set(locale, await Bun.file(file).text());
	}
	return translations;
}

/**
 * Rebuild a standalone CRUD route under a new prefix from its current
 * config.ts, then remove the old generated route. Generated files are never
 * moved: their URLs, imports, templates, navigation and translations must be
 * produced again for the destination prefix.
 */
export async function move_route_to_prefix(source_url: string, raw_prefix: string): Promise<MoveRouteResult> {
	const { clean: target_prefix } = normalize_prefix(raw_prefix);
	const { discover_routes_with_schema } = await import("./utils/route_scan");
	const routes = discover_routes_with_schema();
	const route = routes.find((candidate) => candidate.url === source_url);
	if (!route) throw new Error(`Route not found: ${source_url}`);
	if (route.parent) throw new Error("Nested CRUD routes cannot change module independently.");
	if (routes.some((candidate) => candidate.url.startsWith(`${source_url}/`))) {
		throw new Error("A route with nested CRUD children cannot change module independently.");
	}
	if (route.prefix === target_prefix) return { url: source_url };

	const route_directory = route.route_name || route.table;
	const source_path = join(process.cwd(), MAIN_APP, ...(route.prefix ? [route.prefix] : []), route_directory);
	const destination_path = join(process.cwd(), MAIN_APP, ...(target_prefix ? [target_prefix] : []), route_directory);
	if (!existsSync(join(source_path, "config.ts"))) throw new Error(`Route config not found: ${source_path}`);
	if (existsSync(destination_path)) throw new Error(`Destination route already exists: ${destination_path}`);

	const source_config = await Bun.file(join(source_path, "config.ts")).text();
	const destination_url = target_prefix ? `/${target_prefix}/${route_directory}` : `/${route_directory}`;
	const source_namespace = namespace_for_url(source_url);
	const destination_namespace = namespace_for_url(destination_url);
	const source_translations = await read_nondefault_translations(source_namespace);
	const routes_path = join(process.cwd(), MAIN_APP, "routes.ts");
	const original_routes = await Bun.file(routes_path).text();
	let destination_generated = false;
	try {
		// Preserve existing localized values before generation creates the new
		// namespace. The CRUD translation sync then restores those values from
		// table-keyed memory at the destination.
		await snapshot_route_translation_memory(source_path);
		mkdirSync(dirname(destination_path), { recursive: true });
		// config.ts is the editable source of truth. Starting a clean destination
		// directory makes the generator recreate every generated .ree/.ts file
		// with the target prefix instead of carrying old URLs across modules.
		await Bun.write(join(destination_path, "config.ts"), source_config);
		// config.ts imports schema.generated.ts. Recreate that generated input at
		// the destination before loading config.ts for the full CRUD pass.
		const { invalidate_cache, load_ddl_cache } = await import("../ddl_cache");
		invalidate_cache();
		await load_ddl_cache({ force_refresh: true });
		const { generate_schema } = await import("../schema");
		const schema_generated = await generate_schema(route.table, {
			reload: false,
			prefix: target_prefix,
			route_name: route.route_name,
		});
		if (!schema_generated) throw new Error(`Schema regeneration failed for ${route.table}`);
		// Keep human translations as the target input. The full CRUD sync below
		// merges them against its fresh English source, retaining translations
		// when generated wording has harmless casing or punctuation changes.
		for (const [locale, translation] of source_translations) {
			await Bun.write(translation_file(destination_namespace, locale), translation);
		}

		const generated = await generate_crud(route.table, {
			reload: false,
			force: true,
			interactive: false,
			prefix: target_prefix,
			route_name: route.route_name,
		});
		if (!generated) throw new Error(`CRUD regeneration failed for ${route.table}`);
		destination_generated = true;

		const { remove_route } = await import("./remove_route");
		// The new route has been generated and registered. Remove the old one by
		// its normal route lifecycle so its registry entry and local translations
		// are cleaned up too. The route reload is intentionally deferred until the
		// entire move has completed.
		await remove_route(source_url, true, false);
		await notify_server_reload(false, Bun.env.MAIN_APP_URL);
		await notify_server_reload(true, Bun.env.MAIN_APP_URL);

		console.log(`✓ Moved route ${source_url} to ${destination_url}`);
		return { url: destination_url };
	} catch (error) {
		if (!destination_generated) {
			// The source remains untouched until its generated replacement succeeds.
			// Undo only a failed destination generation; once the new route exists,
			// never discard it merely because source cleanup reports an error.
			await Bun.write(routes_path, original_routes);
			if (existsSync(destination_path)) rmSync(destination_path, { recursive: true, force: true });
		}
		throw error;
	}
}
