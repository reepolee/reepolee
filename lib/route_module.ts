import type { RouteDefinition } from "$lib/route_builder";

export async function try_load_routes(path: string): Promise<RouteDefinition[]> {
	try {
		const mod = await import(path);
		return mod.route_definitions ?? [];
	} catch {
		return [];
	}
}
