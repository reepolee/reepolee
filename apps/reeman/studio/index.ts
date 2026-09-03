import { navigation } from "./config";
import type { RouteDefinition } from "$lib/route_builder";

import { post_adapt_schema, post_copy_table, post_delete_table, post_delete_view, post_generate_view, post_new_table, post_preview, post_save_table, post_undo } from "./handlers";
import { get_studio_page } from "./page";

const studio_routes = {
	"/studio": { GET: get_studio_page },
	"/studio/table/save": { POST: post_save_table },
	"/studio/table/new": { POST: post_new_table },
	"/studio/table/copy": { POST: post_copy_table },
	"/studio/table/delete": { POST: post_delete_table },
	"/studio/view/generate": { POST: post_generate_view },
	"/studio/view/delete": { POST: post_delete_view },
	"/studio/preview": { POST: post_preview },
	"/studio/undo": { POST: post_undo },
	"/studio/schema/adapt": { POST: post_adapt_schema },
};

export const route_definitions: RouteDefinition[] = [
	{
		url: "/studio",
		crud: studio_routes,
		nav_title_key: "reeman.studio",
		module: "system",
		nav_module: null,
		nav_section_key: navigation.section_key,
		nav_section_order: navigation.section_order,
		nav_item_order: navigation.item_order,
		nav_group_order: navigation.group_order,
		nav_final_order: navigation.final_order,
		// Draw a horizontal rule under Studio in the nav sidebar (issue #24) -
		// restores the separator between the generator core pages and the
		// data/admin pages that the removed /generate route used to carry.
		nav_rule_after: true,
	},
];
