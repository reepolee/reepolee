import { build_nav_routes, build_routes, type RouteDefinition } from "$lib/route_builder";
import { mount_route_modules_from_dir, reset_route_module_mounts, try_load_routes } from "$lib/route_module";
import { home_page } from "$main/home";

import { auth_crud } from "$platform/auth";

reset_route_module_mounts();

const route_definitions: RouteDefinition[] = [
	// Pages
	{ url: "/", handler: home_page },
	...await try_load_routes(import.meta.resolve("./examples")),

	// GEN:MODULES

	// GEN:ROUTES
];

export const nav_routes = build_nav_routes(route_definitions);

export const routes = {
	...build_routes(route_definitions),
	...auth_crud,
	// GEN:ROUTES:CHILD:START
	// GEN:ROUTES:CHILD:END
	// GEN:ROUTES:JSON:START
	// GEN:ROUTES:JSON:END
};
// [reload 1785020620642,zxuqgqsusnc]
