import { default_language } from "$config/supported_languages";
import { get_lang_from_request, localized_url } from "$lib/route";
import { get_rate_limit_status, reset_rate_limits } from "$lib/middleware";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import type { RouteDefinition } from "$lib/route_builder";
import type { BunRequest } from "bun";

export const route_definitions: RouteDefinition[] = [
	{
		url: "/system/rate-limits",
		handler: get_system_rate_limits,
		nav_title_key: "system.rate_limits",
		module: "system",
	},
	{ url: "/system/rate-limits/reset", methods: { POST: post_reset_limits }, module: "system" },
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

	return render("form", { data: { scope_list, total_keys: status?.total_keys ?? 0, error }, ctx });
}

export async function post_reset_limits(req: BunRequest): Promise<Response> {
	const lang = get_lang_from_request(req) || default_language;

	try {
		await reset_rate_limits();
		return Response.redirect(localized_url("/system/rate-limits", lang), 303);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return Response.json({ error: msg }, { status: 500 });
	}
}
