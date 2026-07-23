import { build_nav_routes, build_routes, type RouteDefinition } from "$lib/route_builder";
import { try_load_routes } from "$lib/route_module";
import { home_page } from "$routes/home";

import { auth_crud } from "$routes/system/auth";
import { route_definitions as system_routes_definitions } from "$routes/system";

const route_definitions: RouteDefinition[] = [
	// Pages
	{ url: "/", handler: home_page },
	...await try_load_routes(import.meta.resolve("./examples")),

	// SYSTEM
	...system_routes_definitions,

	// GENERATED

];

export const nav_routes = build_nav_routes(route_definitions);

export const routes = {
	...build_routes(route_definitions),
	...auth_crud,
	// GENERATED CHILD CRUD:start
	// GENERATED CHILD CRUD:end
	// GENERATED JSON:start
	// GENERATED JSON:end
};
// [reload 1784839014172,h9062xgllfu]
