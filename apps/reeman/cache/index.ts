import { default_locale } from "$config/supported_locales";
import { cache } from "$lib/cache";
import { get_locale_from_request, localized_url } from "$lib/route";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import type { RouteDefinition } from "$lib/route_builder";
import type { BunRequest } from "bun";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const base_url = "/cache";

// crud-style so build_routes() applies require_module_mw("system") to every
// handler (plain handler/methods defs bypass the module gate).
export const route_definitions: RouteDefinition[] = [
	{
		url: "/cache",
		crud: {
			"/cache": { GET: get_system_cache },
			"/cache/invalidate": { POST: post_system_cache_invalidate },
			"/cache/reset": { POST: post_system_cache_reset },
		},
		nav_title_key: "reeman.cache",
		module: "system",
		nav_module: null,
		nav_section_key: "reeman.nav.data",
		nav_section_order: 20,
		nav_item_order: 10,
	},
];

// ---------------------------------------------------------------------------
// GET /cache - Cache status dashboard
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
// POST /cache/invalidate - Invalidate a specific table
// ---------------------------------------------------------------------------

export async function post_system_cache_invalidate(req: BunRequest): Promise<Response> {
	const locale = get_locale_from_request(req) || default_locale;

	try {
		const body = await req.text();
		const params = new URLSearchParams(body);
		const table = params.get("table")?.trim();

		if (!table) {
			return Response.json({ error: "Missing table parameter" }, { status: 400 });
		}

		await cache.invalidate(table);
		return Response.redirect(localized_url(base_url, locale), 303);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return Response.json({ error: msg }, { status: 500 });
	}
}

// ---------------------------------------------------------------------------
// POST /cache/reset - Invalidate ALL cache entries
// ---------------------------------------------------------------------------

export async function post_system_cache_reset(req: BunRequest): Promise<Response> {
	const locale = get_locale_from_request(req) || default_locale;

	try {
		await cache.invalidate_all();
		return Response.redirect(localized_url(base_url, locale), 303);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return Response.json({ error: msg }, { status: 500 });
	}
}
