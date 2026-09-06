import type { RouteDefinition } from "$lib/route_builder";

import { signals_page } from "./signals";
import { kitchen_sink_page } from "./kitchen_sink";
import { index_template_page } from "./index_template";
// AGENT NOTE: The list and detail resources are registered separately. The
// detail route is hidden from navigation but remains reachable from each row.
import { record_details_page } from "./index_template/record_details";

export const route_definitions: RouteDefinition[] = [
	{
		url: "/examples/kitchen-sink",
		resource: kitchen_sink_page,
		nav_title_key: "examples.kitchen_sink",
	},
	{ url: "/examples/signals", handler: signals_page, nav_title_key: "examples.signals" },
	// LIST ROUTE: change this URL and BASE_PATH in index_template/index.ts
	// together if the example is moved.
	{
		url: "/examples/index-template",
		resource: index_template_page,
		nav_title_key: "examples.index_template",
	},
	// DETAIL ROUTE: is_menu_entry=false prevents a duplicate sidebar item.
	{
		url: "/examples/index-template/record-details",
		resource: record_details_page,
		is_menu_entry: false,
	},
];
