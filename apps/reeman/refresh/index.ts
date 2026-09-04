import { navigation } from "./config";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import type { RouteDefinition } from "$lib/route_builder";
import type { BunRequest } from "bun";

import { post_archive_live_translations, post_sync_locale_tables, post_sync_translations } from "../reeman/handlers";
import { load_reeman_data, type PageOverrides } from "../reeman/page";

export async function get_refresh_page(req: BunRequest, overrides: PageOverrides = {}): Promise<Response> {
	const data = await load_reeman_data({ refresh_routes: false });
	const ctx = await create_ctx(req, import.meta.dir);

	return render("index", {
		data: {
			page_title: ctx.translations.ui?.refresh_title,
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
	"/archive-live-translations": { POST: post_archive_live_translations },
	"/sync-locale-tables": { POST: post_sync_locale_tables },
};

export const route_definitions: RouteDefinition[] = [
	{
		url: "/refresh",
		crud: refresh_crud,
		nav_title_key: "reeman.refresh",
		module: "system",
		nav_module: null,
		nav_section_key: navigation.section_key,
		nav_section_order: navigation.section_order,
		nav_item_order: navigation.item_order,
		nav_group_order: navigation.group_order,
		nav_final_order: navigation.final_order,
	},
];
