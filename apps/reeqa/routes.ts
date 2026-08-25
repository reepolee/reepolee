import { build_nav_routes, build_routes, type RouteDefinition } from "$lib/route_builder";
import { mount_route_modules_from_dir, reset_route_module_mounts } from "$lib/route_module";
import { auth_crud } from "$platform/auth";

import { start_scheduler } from "./lib/schedule";

reset_route_module_mounts();
start_scheduler();

const mounted_definitions = await mount_route_modules_from_dir(import.meta.dir, "reeqa");
const nav_order = ["/", "/projects", "/run-tests", "/command-checks"];
const nav_order_index = new Map(nav_order.map((url, index) => [url, index]));

const route_definitions: RouteDefinition[] = [...mounted_definitions];
route_definitions.sort((left, right) => {
	const left_index = nav_order_index.get(left.url);
	const right_index = nav_order_index.get(right.url);
	if (left_index !== undefined && right_index !== undefined) return left_index - right_index;
	if (left_index !== undefined) return -1;
	if (right_index !== undefined) return 1;
	return 0;
});

export const nav_routes = build_nav_routes(route_definitions);

export const routes = {
	...build_routes(route_definitions),
	...auth_crud,
};
