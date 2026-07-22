import { feature_enabled } from "$lib/helpers";
import type { RouteDefinition } from "$lib/route_builder";

import { route_definitions as cache_definitions } from "./cache";
import { route_definitions as global_scopes_definitions } from "./global_scopes";
import { route_definitions as images_definitions } from "./images";
import { route_definitions as modules_definitions } from "./modules";
import { route_definitions as queues_definitions } from "./queues";
import { route_definitions as rate_limit_definitions } from "./rate_limits";
import { route_definitions as translations_definitions } from "./translations";
import { route_definitions as users_definitions } from "./users";

export const route_definitions: RouteDefinition[] = [
	...queues_definitions,
	...users_definitions,
	...images_definitions,
	...global_scopes_definitions,
	...translations_definitions,
	...modules_definitions,
	...(feature_enabled("RATE_LIMITING") ? rate_limit_definitions : []),
	...(feature_enabled("CACHE_ENABLED") ? cache_definitions : []),
];
