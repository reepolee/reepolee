import type { RouteSchema } from "$generator/reeman/utils/route_scan";

export interface DbRouteSnapshot {
	id: number;
	url: string;
	table_name: string;
	module: string;
	removable: number;
	template_hash_status: "clean" | "modified" | "untracked" | null;
	display: string;
}

/** Discover the current generated routes without persisting a metadata snapshot. */
export async function refresh_db_routes(): Promise<DbRouteSnapshot[]> {
	const [{ discover_routes_with_schema, discover_simple_routes }, { list_removable_routes }] = await Promise.all([
		import("$generator/reeman/utils/route_scan"),
		import("$generator/reeman/remove_route"),
	]);

	const routes = discover_routes_with_schema();
	const seen_urls = new Set(routes.map((route) => route.url));
	for (const route of discover_simple_routes()) {
		if (seen_urls.has(route.url)) continue;
		seen_urls.add(route.url);
		routes.push(route);
	}

	const removable_urls = new Set((await list_removable_routes()).map((route) => route.url));
	return routes.map((route, index) => to_snapshot(route, index + 1, removable_urls));
}

function to_snapshot(route: RouteSchema, id: number, removable_urls: Set<string>): DbRouteSnapshot {
	return {
		id,
		url: route.url,
		table_name: route.table,
		module: route.prefix,
		removable: removable_urls.has(route.url) ? 1 : 0,
		template_hash_status: route.template_hash_status ?? null,
		display: route.url,
	};
}

export async function get_route_record_by_url(url: string): Promise<DbRouteSnapshot | undefined> {
	return (await refresh_db_routes()).find((record) => record.url === url);
}
