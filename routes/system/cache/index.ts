import { default_language } from "$config/supported_languages";
import { cache } from "$lib/cache";
import { get_lang_from_request, localized_url } from "$lib/route";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import type { RouteDefinition } from "$lib/route_builder";
import type { BunRequest } from "bun";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const base_url = "/system/cache";

export const route_definitions: RouteDefinition[] = [
	{
		url: "/system/cache",
		handler: get_system_cache,
		nav_title_key: "system.cache",
		module: "system",
	},
	{
		url: "/system/cache/invalidate",
		methods: { POST: post_system_cache_invalidate },
		module: "system",
	},
	{ url: "/system/cache/reset", methods: { POST: post_system_cache_reset }, module: "system" },
];

// ---------------------------------------------------------------------------
// GET /system/cache - Cache status dashboard
// ---------------------------------------------------------------------------

export async function get_system_cache(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);

	const enabled = cache.is_enabled();

	let status: any = null;
	let error: string | null = null;

	if (enabled) {
		try {
			status = await cache.get_status();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
	}

	return render("index", { data: { title: "SQL Cache", enabled, status, error }, ctx });
}

// ---------------------------------------------------------------------------
// POST /system/cache/invalidate - Invalidate a specific table
// ---------------------------------------------------------------------------

export async function post_system_cache_invalidate(req: BunRequest): Promise<Response> {
	const lang = get_lang_from_request(req) || default_language;

	try {
		const body = await req.text();
		const params = new URLSearchParams(body);
		const table = params.get("table")?.trim();

		if (!table) {
			return Response.json({ error: "Missing table parameter" }, { status: 400 });
		}

		await cache.invalidate(table);
		return Response.redirect(localized_url(base_url, lang), 303);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return Response.json({ error: msg }, { status: 500 });
	}
}

// ---------------------------------------------------------------------------
// POST /system/cache/reset - Invalidate ALL cache entries
// ---------------------------------------------------------------------------

export async function post_system_cache_reset(req: BunRequest): Promise<Response> {
	const lang = get_lang_from_request(req) || default_language;

	try {
		await cache.invalidate_all();
		return Response.redirect(localized_url(base_url, lang), 303);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return Response.json({ error: msg }, { status: 500 });
	}
}
