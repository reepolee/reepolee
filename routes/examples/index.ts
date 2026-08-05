import type { RouteDefinition } from "$lib/route_builder";

import { signals_page } from "./signals";
import { kitchen_sink_page } from "./kitchen_sink";

export const route_definitions: RouteDefinition[] = [
	{
		url: "/examples/kitchen-sink",
		resource: kitchen_sink_page,
		nav_title_key: "examples.kitchen_sink",
	},
	{ url: "/examples/signals", handler: signals_page, nav_title_key: "examples.signals" },
];
