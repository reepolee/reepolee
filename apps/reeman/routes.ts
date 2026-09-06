import { build_nav_routes, build_routes, type RouteDefinition } from "$lib/route_builder";
import { feature_enabled } from "$lib/helpers";
import { mount_route_modules_from_dir } from "$lib/route_module";

import { auth_crud } from "$platform/auth";

// Mount every top-level module folder under apps/reeman/ by default. Each
// folder with an index.ts becomes a route module named after the folder, so
// its templates resolve through the mount root and its translation namespace
// resolves under reeman (apps/reeman/users -> "reeman/users"). New modules
// dropped into apps/reeman/ work without any wiring here.
const mounted_definitions = await mount_route_modules_from_dir(import.meta.dir, "reeman");

// Preserve the historical feature gating for the sysadmin extras: rate-limits
// requires RATE_LIMITING and cache requires CACHE_ENABLED. The folders stay
// mounted either way (the pages render a friendly disabled state), only their
// routes are not registered when the feature is off.
const filtered_definitions = mounted_definitions.filter((d) => {
	const url = d.url ?? "";
	if (url.startsWith("/rate-limits")) return feature_enabled("RATE_LIMITING");
	if (url.startsWith("/cache")) return feature_enabled("CACHE_ENABLED");
	return true;
});

const route_definitions: RouteDefinition[] = filtered_definitions;

export const nav_routes = build_nav_routes(route_definitions);

export const routes = {
	...build_routes(route_definitions),
	...auth_crud,
};
