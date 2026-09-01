import { make_toast } from "$lib/cookies";
import { build_pagination_urls, get_limit_numeric, get_limit_options, parse_pagination_params } from "$lib/pagination";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import { localized_url, resolve_locale } from "$lib/route";
import type { RouteDefinition } from "$lib/route_builder";
import type { BunRequest } from "bun";

import { delete_items, get_item_by_id, search_items, update_item } from "./store";

const BASE_PATH = "/environment";
const DEFAULT_LIMIT = 20;
const SORT_OPTIONS = [
	{ value: "native::asc", field: "native_order", direction: "" },
	{ value: "key::asc", field: "key", direction: "asc" },
	{ value: "key::desc", field: "key", direction: "desc" },
	{ value: "description::asc", field: "description", direction: "asc" },
	{ value: "description::desc", field: "description", direction: "desc" },
];

function toast_redirect(req: BunRequest, target: string, message: string, type: "green" | "red" = "green"): Response {
	const location = localized_url(target, resolve_locale(req));
	const headers = new Headers({ Location: location });
	const toast = make_toast("toast-environment", { message, type, duration: 5000 });
	headers.append("Set-Cookie", toast.toString());
	return new Response(null, { status: 303, headers });
}

export async function get_environment_index(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const pagination = parse_pagination_params(req.url, DEFAULT_LIMIT);
	const limit_numeric = get_limit_numeric(pagination.limit);
	const order_by = pagination.order_by === "id::asc" ? "native::asc" : pagination.order_by;
	const result = await search_items(pagination.query, pagination.offset, limit_numeric, order_by);
	const pagination_urls = build_pagination_urls(
		BASE_PATH,
		pagination.offset,
		limit_numeric,
		result.total,
		pagination.query,
		order_by,
	);

	return render("index", {
		data: {
			records: result.items,
			query: pagination.query,
			limit: pagination.limit,
			offset: pagination.offset,
			order_by,
			total: result.total,
			limit_options: get_limit_options(pagination.limit),
			sort_options: SORT_OPTIONS,
			...pagination_urls,
		},
		ctx,
		debug_redact_keys: ["records"],
	});
}

export async function get_environment_edit(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const key = req.params.key ?? "";
	const record = await get_item_by_id(key);

	if (!record) return render("notfound", { data: { title: "404 Not Found" }, status: 404, ctx });

	return render("form", {
		data: { record, form_error: "" },
		ctx,
		debug_redact_keys: ["record"],
	});
}

export async function post_environment_edit(req: BunRequest): Promise<Response> {
	const key = req.params.key ?? "";
	const form_data = await req.formData();
	const value = form_data.get("value");

	if (typeof value !== "string") {
		return toast_redirect(req, `${BASE_PATH}/${encodeURIComponent(key)}/edit`, "The environment value is required.", "red");
	}

	try {
		const updated = await update_item(key, value);
		if (!updated) return toast_redirect(req, BASE_PATH, `Environment key ${key} was not found.`, "red");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return toast_redirect(req, `${BASE_PATH}/${encodeURIComponent(key)}/edit`, message, "red");
	}

	return toast_redirect(req, BASE_PATH, `${key} saved. The main development server will restart automatically.`);
}

export async function post_environment_bulk_delete(req: BunRequest): Promise<Response> {
	const form_data = await req.formData();
	const selected_values = form_data.getAll("ids");
	const ids = selected_values.filter((value): value is string => typeof value === "string");

	if (ids.length === 0) return toast_redirect(req, BASE_PATH, "Select at least one environment key.", "red");

	try {
		const deleted_count = await delete_items(ids);
		return toast_redirect(req, BASE_PATH, `${deleted_count} environment key(s) deleted. The main development server will restart automatically.`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return toast_redirect(req, BASE_PATH, message, "red");
	}
}

export const environment_crud = {
	"/environment": { GET: get_environment_index },
	"/environment/bulk-delete": { POST: post_environment_bulk_delete },
	"/environment/:key/edit": { GET: get_environment_edit, POST: post_environment_edit },
};

export const route_definitions: RouteDefinition[] = [
	{
		url: "/environment",
		crud: environment_crud,
		nav_title_key: "reeman.environment",
		module: "system",
		nav_module: null,
		nav_section_key: "reeman.nav.generator",
		nav_section_order: 10,
		nav_item_order: 50,
	},
];
