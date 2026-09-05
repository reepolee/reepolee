import { navigation } from "./config";
import { localized_url, resolve_locale } from "$lib/route";
import type { RouteDefinition } from "$lib/route_builder";
import type { BunRequest } from "bun";

import { post_create_page_set, post_delete_page_set, post_set_active_page_set, post_update_page_set } from "../projects";

export function get_page_sets_redirect(req: BunRequest): Response {
	const locale = resolve_locale(req);
	const target = localized_url("/projects", locale);
	return Response.redirect(target, 308);
}

export const page_sets_crud = {
	"/page-sets": { GET: get_page_sets_redirect },
	"/page-sets/active": { POST: post_set_active_page_set },
	"/page-sets/create": { POST: post_create_page_set },
	"/page-sets/update": { POST: post_update_page_set },
	"/page-sets/delete": { POST: post_delete_page_set },
};

export const route_definitions: RouteDefinition[] = [
	{
		url: "/page-sets",
		crud: page_sets_crud,
		module: "system",
		nav_module: null,
		nav_section_key: navigation.section_key,
		nav_item_order: navigation.item_order,
		nav_section_order: navigation.section_order,
		nav_group_order: navigation.group_order,
		nav_final_order: navigation.final_order,
	},
];
