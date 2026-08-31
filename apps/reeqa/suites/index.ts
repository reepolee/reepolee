import { localized_url, resolve_locale } from "$lib/route";
import type { RouteDefinition } from "$lib/route_builder";
import type { BunRequest } from "bun";

import { post_start_suite } from "../command_checks";

export function get_suites_redirect(req: BunRequest): Response {
	const locale = resolve_locale(req);
	const target = localized_url("/command-checks", locale);
	return Response.redirect(target, 308);
}

export const suites_crud = {
	"/suites": { GET: get_suites_redirect },
	"/suites/start": { POST: post_start_suite },
};

export const route_definitions: RouteDefinition[] = [
	{
		url: "/suites",
		crud: suites_crud,
		module: "system",
		nav_module: null,
		is_menu_entry: false,
	},
];
