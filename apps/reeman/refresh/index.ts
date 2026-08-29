import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import type { RouteDefinition } from "$lib/route_builder";
import type { BunRequest } from "bun";

import { post_add_locale, post_sync_locale_tables, post_sync_translations } from "../reeman/handlers";
import { load_reeman_data, type PageOverrides } from "../reeman/page";

export async function get_refresh_page(req: BunRequest, overrides: PageOverrides = {}): Promise<Response> {
	const data = await load_reeman_data({ refresh_routes: false });
	const ctx = await create_ctx(req, import.meta.dir);

	return render("index", {
		data: {
			locales_info: data.locales_info,
			busy: data.busy,
			form_error: overrides.form_error ?? "",
		},
		ctx,
		status: overrides.status ?? 200,
	});
}

export const refresh_crud = {
	"/refresh": { GET: get_refresh_page },
	"/sync-translations": { POST: post_sync_translations },
	"/sync-locale-tables": { POST: post_sync_locale_tables },
	"/add-locale": { POST: post_add_locale },
};

export const route_definitions: RouteDefinition[] = [
	{
		url: "/refresh",
		crud: refresh_crud,
		nav_title_key: "reeman.refresh",
		module: "system",
		nav_module: null,
	},
];
