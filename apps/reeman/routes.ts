import { build_nav_routes, build_routes, type RouteDefinition } from "$lib/route_builder";
import { feature_enabled } from "$lib/helpers";
import { mount_route_modules_from_dir, reset_route_module_mounts } from "$lib/route_module";

import { auth_crud } from "$platform/auth";

reset_route_module_mounts();

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

// All reeman app pages are served at root URLs (e.g. /tables, /users) and
// gated by the "system" module. Explicit nav order: the reeman dashboard owns
// "/" on this origin and stays first, then the generator core pages, then
// the data/admin pages. Array#sort is stable, so entries without an explicit
// index keep their mount order (and feature-gated pages drop out cleanly).
// Files intentionally sits after Images (issue #13). The /generate page was
// removed (issue #21) - single-table CRUD generation now lives on /tables;
// Studio now carries the nav_rule_after flag so the layout still draws a
// horizontal rule under the generator core pages (issue #24).
const NAV_ORDER = [
	"/",
	"/tables",
	"/routes",
	"/database",
	"/project",
	"/environment",
	"/sync",
	"/studio",
	"/cache",
	"/global_scopes",
	"/images",
	"/files",
	"/logs",
	"/modules",
	"/queues",
	"/rate-limits",
	"/refresh",
	"/locales",
	"/translations",
	"/users",
];
const NAV_ORDER_INDEX = new Map(NAV_ORDER.map((url, index) => [url, index]));

const route_definitions: RouteDefinition[] = [...filtered_definitions].sort((a, b) => {
	const ia = NAV_ORDER_INDEX.get(a.url ?? "");
	const ib = NAV_ORDER_INDEX.get(b.url ?? "");
	if (ia !== undefined && ib !== undefined) return ia - ib;
	if (ia !== undefined) return -1;
	if (ib !== undefined) return 1;
	return 0;
});

export const nav_routes = build_nav_routes(route_definitions);

export const routes = {
	...build_routes(route_definitions),
	...auth_crud,
};
