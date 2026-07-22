import type { RouteDefinition } from "$lib/route_builder";

import {
	get_modules_edit,
	get_modules_index,
	get_modules_new,
	post_modules_bulk_delete,
	post_modules_edit,
	post_modules_index,
	post_modules_validate,
} from "./handlers";

export const system_modules_crud = {
	"/modules": { GET: get_modules_index, POST: post_modules_index },
	"/modules/new": get_modules_new,
	"/modules/validate": { POST: post_modules_validate },
	"/modules/:id/edit": { GET: get_modules_edit, POST: post_modules_edit },
	"/modules/bulk-delete": { POST: post_modules_bulk_delete },
};

export const route_definitions: RouteDefinition[] = [
	{
		url: "/system/modules",
		crud: system_modules_crud,
		nav_title_key: "system.modules",
		module: "system",
	},
];
