import { navigation } from "./config";
import { default_locale } from "$config/supported_locales";
import { get_locale_from_request, localized_url } from "$lib/route";
import { get_rate_limit_status, reset_rate_limits } from "$lib/middleware";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import type { RouteDefinition } from "$lib/route_builder";
import type { BunRequest } from "bun";

// crud-style so build_routes() applies require_module_mw("system") to every
// handler (plain handler/methods defs bypass the module gate).
export const route_definitions: RouteDefinition[] = [
	{
		url: "/rate-limits",
		crud: {
			"/rate-limits": { GET: get_system_rate_limits },
			"/rate-limits/reset": { POST: post_reset_limits },
		},
		nav_title_key: "reeman.rate_limits",
		module: "system",
		nav_module: null,
		nav_section_key: navigation.section_key,
		nav_section_order: navigation.section_order,
		nav_item_order: navigation.item_order,
		nav_group_order: navigation.group_order,
		nav_final_order: navigation.final_order,
	},
];

export async function get_system_rate_limits(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);

	let status: any = null;
	let error: string | null = null;

	try {
		status = await get_rate_limit_status();
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	}

	// Flatten scopes into an array so the template can iterate without Object.entries()
	const scope_list: Array<{
		name: string;
		limit: number;
		window_s: number;
		unique_identities: number;
		entries: any[];
	}> = [];
	if (status?.scopes) {
		for (const name of Object.keys(status.scopes)) {
			scope_list.push({ name, ...status.scopes[name] });
		}
	}

	return render("form", { data: { page_title: ctx.translations.ui?.title, scope_list, total_keys: status?.total_keys ?? 0, error }, ctx });
}

export async function post_reset_limits(req: BunRequest): Promise<Response> {
	const locale = get_locale_from_request(req) || default_locale;

	try {
		await reset_rate_limits();
		return Response.redirect(localized_url("/rate-limits", locale), 303);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return Response.json({ error: msg }, { status: 500 });
	}
}
