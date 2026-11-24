import { build_nav_routes, build_routes, type RouteDefinition } from "$lib/route_builder";
import { mount_route_modules_from_dir, reset_route_module_mounts } from "$lib/route_module";
import { auth_crud } from "$platform/auth";

import { start_scheduler } from "./lib/schedule";

reset_route_module_mounts();
start_scheduler();

const mounted_definitions = await mount_route_modules_from_dir(import.meta.dir, "reeqa");
const route_definitions: RouteDefinition[] = [...mounted_definitions];

export const nav_routes = build_nav_routes(route_definitions);

export const routes = {
	...build_routes(route_definitions),
	...auth_crud,
};
