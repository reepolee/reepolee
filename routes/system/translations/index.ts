import type { RouteDefinition } from "$lib/route_builder";

import {
	post_translations_add_group,
	post_translations_add_namespace,
	post_translations_bulk_delete,
	post_translations_delete_key,
	post_translations_delete_namespace,
	post_translations_inline_save,
} from "./handlers";
import { get_translations_edit, post_translations_edit } from "./edit_page";
import { get_translations_index } from "./index_page";

// Exports

export const system_translations_crud = {
	"/translations": { GET: get_translations_index },
	"/translations/add-namespace": { POST: post_translations_add_namespace },
	"/translations/delete-namespace": { POST: post_translations_delete_namespace },
	"/translations/add-group": { POST: post_translations_add_group },
	"/translations/:namespace/:parent/edit": { GET: get_translations_edit },
	"/translations/edit": { POST: post_translations_edit },
	"/translations/bulk-delete": { POST: post_translations_bulk_delete },
	"/translations/delete-key": { POST: post_translations_delete_key },
	"/translations/inline-save": { POST: post_translations_inline_save },
};

export const route_definitions: RouteDefinition[] = [
	{
		url: "/system/translations",
		crud: system_translations_crud,
		nav_title_key: "system.translations",
		module: "system",
	},
];
