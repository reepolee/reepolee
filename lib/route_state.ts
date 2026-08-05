/**
 * Route State - shared route-table rebuilding used by both the cold-start
 * bootstrap path and the --hot reload path.
 *
 * Extracted from server.ts and lib/bootstrap.ts to eliminate the duplication
 * where both paths reconstructed nav groups, route maps, middleware wrapping,
 * and state synchronization independently.
 */

import { active_locales, default_locale } from "$config/supported_locales";
import { translations } from "$lib/i18n";
import { csrf_mw, rate_limit_mw, set_locale, wrap_all_routes } from "$lib/middleware";
import type { RouteTable } from "$lib/middleware/types";
import type { NavRoute } from "$lib/route_builder";
import { build_route_maps, expand_route_aliases_from_maps } from "$lib/route_map";
import { build_nav_groups, set_nav_groups, set_nav_routes, set_route_table } from "$lib/route_table";

export async function rebuild_routes_and_state(nav_routes: NavRoute[], routes: RouteTable, is_agent: boolean) {
	// Re-initialize translations if the i18n module was re-evaluated
	// (hot reload path: checking one locale is sufficient - all are loaded together).
	const need_translation_reinit = !translations.get(default_locale);
	if (need_translation_reinit) { await translations.initialize(); }

	const nav_groups = build_nav_groups(nav_routes);

	build_route_maps(translations.all, routes, active_locales);

	const expanded_routes = expand_route_aliases_from_maps(routes, active_locales);

	const agent_middlewares = [rate_limit_mw(), set_locale(active_locales)];
	if (!is_agent) { agent_middlewares.push(csrf_mw()); }

	const routed = wrap_all_routes(expanded_routes, ...agent_middlewares);

	set_route_table(routed);
	set_nav_routes(nav_routes);
	set_nav_groups(nav_groups);

	return { nav_groups, routed };
}
