import { db } from "$config/db";

// Add custom queries here. This file is never overwritten by the generator.

/**
 * Repopulate db_routes from routes.ts + schema folders - rows are a
 * snapshot, never hand-edited, so a wholesale delete + reinsert before each
 * index read keeps the grid current with the actual generated routes.
 * Includes static simple routes (simple page / simple table page generators)
 * so every generated route shows up in the grid, not just CRUD ones.
 */
export async function refresh_db_routes(): Promise<void> {
	const [{ discover_routes_with_schema, discover_simple_routes }, { list_removable_routes }] = await Promise.all([
		import("$generator/reeman/utils/route_scan"),
		import("$generator/reeman/remove_route"),
	]);

	// Simple routes never carry a CRUD schema, so there is no overlap - but
	// dedupe by URL anyway to stay safe if a future generator mixes patterns.
	const routes = discover_routes_with_schema();
	const seen_urls = new Set(routes.map((r) => r.url));
	for (const route of discover_simple_routes()) {
		if (seen_urls.has(route.url)) continue;
		seen_urls.add(route.url);
		routes.push(route);
	}

	const removable = await list_removable_routes();
	const removable_urls = new Set(removable.map((r) => r.url));

	await db`DELETE FROM db_routes`;
	for (const route of routes) {
		await db`INSERT INTO db_routes (url, table_name, module, removable) VALUES (${route.url}, ${route.table}, ${route.prefix}, ${removable_urls.has(route.url) ? 1 : 0})`;
	}
}
