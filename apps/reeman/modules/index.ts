import type { RouteDefinition } from "$lib/route_builder";

import {
	get_modules_edit,
	get_modules_index,
	get_modules_new,
	post_modules_bulk_archive,
	post_modules_edit,
	post_modules_index,
	post_modules_validate,
} from "./handlers";

export const system_modules_crud = {
	"/modules": { GET: get_modules_index, POST: post_modules_index },
	"/modules/new": get_modules_new,
	"/modules/validate": { POST: post_modules_validate },
	"/modules/:id/edit": { GET: get_modules_edit, POST: post_modules_edit },
	"/modules/bulk-archive": { POST: post_modules_bulk_archive },
};

export const route_definitions: RouteDefinition[] = [
	{
		url: "/modules",
		crud: system_modules_crud,
		nav_title_key: "reeman.modules",
		module: "system",
		nav_module: null,
	},
];
