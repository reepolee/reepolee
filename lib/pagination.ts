/**
 * Shared pagination helpers for CRUD route handlers.
 *
 * Each CRUD route used to duplicate parse_pagination_params() and
 * build_pagination_urls(). This module consolidates them into a single source.
 *
 * Supports base params (query, offset, limit, order_by), extra params
 * (scope, etc.), and filter extraction (filter_ and filter_not_ prefixes).
 */

const MAX_LIMIT = 10_000;

export function parse_pagination_params(url: string, default_limit = 20, extra_params: string[] = []): {
	query: string;
	offset: number;
	limit: number | "all";
	order_by: string;
	filters: Record<string, string>;
	filter_not: Record<string, string>;
	[key: string]: string | number | Record<string, string>;
} {
	const url_obj = new URL(
		url,
		"http://localhost",
	);
	const query = url_obj.searchParams.get("query") || "";
	const offset = Math.max(0, parseInt(url_obj.searchParams.get("offset") || "0", 10));
	const limit_param = url_obj.searchParams.get("limit") || String(default_limit);
	const order_by = url_obj.searchParams.get("order_by") || "id::asc";

	let limit: number | "all" = default_limit;
	if (limit_param === "all") {
		limit = "all";
	} else {
		const parsed = parseInt(limit_param, 10);
		limit = !Number.isNaN(parsed) ? Math.min(parsed, MAX_LIMIT) : default_limit;
	}

	const filters: Record<string, string> = {};
	const filter_not: Record<string, string> = {};
	for (const [key, value] of url_obj.searchParams.entries()) {
		if (key.startsWith("filter_not_")) {
			const fkey = key.slice(11);
			filter_not[fkey] = value;
		} else if (key.startsWith("filter_")) {
			const fkey = key.slice(7);
			if (filters[fkey]) {
				filters[fkey] += `,${value}`;
			} else {
				filters[fkey] = value;
			}
		}
	}

	const result: Record<string, any> = { query, offset, limit, order_by, filters, filter_not };

	for (const ep of extra_params) {
		result[ep] = url_obj.searchParams.get(ep) || "";
	}

	return result;
}

export function get_limit_options(current_limit: number | "all", allowed_limits: number[] = [
	5,
	10,
	20,
	30,
	50,
	100,
]): (number | "all")[] {
	const options = [...allowed_limits];
	if (current_limit !== "all" && !options.includes(current_limit as number)) {
		options.push(current_limit as number);
		options.sort((a, b) => (a as number) - (b as number));
	}
	options.push("all");
	return options;
}

export function get_limit_numeric(limit: number | "all", max_limit = MAX_LIMIT): number { return limit === "all" ? max_limit : limit; }

export function build_pagination_urls(
	base_path: string,
	current_offset: number,
	limit_numeric: number,
	total: number,
	query: string,
	order_by: string,
	scope: string = "",
	filters: Record<string, string> = {},
	filter_not: Record<string, string> = {},
): {
	prev_url: string | null;
	next_url: string | null;
	first_url: string | null;
	last_url: string | null;
} {
	const query_param = query ? `&query=${encodeURIComponent(query)}` : "";
	const limit_param = `limit=${limit_numeric}`;
	const order_param = `&order_by=${encodeURIComponent(order_by)}`;
	const scope_param = scope ? `&scope=${encodeURIComponent(scope)}` : "";
	const filter_qs = build_filter_param(filters, filter_not);

	const extra_qs = `${scope_param}${filter_qs}`;

	const prev_offset = Math.max(0, current_offset - limit_numeric);
	const prev_url = current_offset > 0 ? `${base_path}?offset=${prev_offset}&${limit_param}${query_param}${order_param}${extra_qs}` : null;

	const next_offset = current_offset + limit_numeric;
	const next_url = next_offset < total ? `${base_path}?offset=${next_offset}&${limit_param}${query_param}${order_param}${extra_qs}` : null;

	const last_offset = total > 0 ? Math.max(0, Math.ceil(total / limit_numeric) * limit_numeric - limit_numeric) : 0;
	const first_url = current_offset > 0 ? `${base_path}?offset=0&${limit_param}${query_param}${order_param}${extra_qs}` : null;
	const last_url = total > 0 && current_offset < last_offset ? `${base_path}?offset=${last_offset}&${limit_param}${query_param}${order_param}${extra_qs}` : null;

	return { prev_url, next_url, first_url, last_url };
}

export function build_filter_param(filters: Record<string, string>, filter_not: Record<string, string> = {}): string {
	const parts = Object.entries(filters).map(([key, value]) => `filter_${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
	for (const [key, value] of Object.entries(filter_not)) {
		parts.push(`filter_not_${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
	}
	return parts.length > 0 ? `&${parts.join("&")}` : "";
}

// ---------------------------------------------------------------------------
// Cursor (keyset) pagination - same param model the cursor CRUD strategy uses
// ---------------------------------------------------------------------------

export function parse_cursor_pagination_params(url: string, default_limit = 20): {
	query: string;
	after: string | null;
	before: string | null;
	is_last: boolean;
	limit: number | "all";
	order_by: string;
	scope: string;
	filters: Record<string, string>;
	filter_not: Record<string, string>;
} {
	const base = parse_pagination_params(url, default_limit, ["scope"]);
	const url_obj = new URL(url, "http://localhost");

	return {
		query: base.query,
		after: url_obj.searchParams.get("after") || null,
		before: url_obj.searchParams.get("before") || null,
		is_last: url_obj.searchParams.has("last"),
		limit: base.limit,
		order_by: base.order_by,
		scope: base.scope as string,
		filters: base.filters,
		filter_not: base.filter_not,
	};
}

export function build_cursor_pagination_urls(
	base_path: string,
	after_cursor: string | null,
	before_cursor: string | null,
	has_next: boolean,
	has_prev: boolean,
	query: string,
	order_by: string,
	limit_numeric: number,
	scope: string = "",
	filters: Record<string, string> = {},
	filter_not: Record<string, string> = {},
): {
	prev_url: string | null;
	next_url: string | null;
	first_url: string | null;
	last_url: string | null;
} {
	const query_param = query ? `&query=${encodeURIComponent(query)}` : "";
	const limit_param = `limit=${limit_numeric}`;
	const order_param = `&order_by=${encodeURIComponent(order_by)}`;
	const scope_param = scope ? `&scope=${encodeURIComponent(scope)}` : "";
	const filter_param = build_filter_param(filters, filter_not);
	const extra_qs = `${order_param}${scope_param}${filter_param}`;

	// Prev: use before cursor pointing to first record
	const prev_url = has_prev && before_cursor ? `${base_path}?before=${encodeURIComponent(before_cursor)}&${limit_param}${query_param}${extra_qs}` : null;

	// Next: use after cursor pointing to last record
	const next_url = has_next && after_cursor ? `${base_path}?after=${encodeURIComponent(after_cursor)}&${limit_param}${query_param}${extra_qs}` : null;

	// First: clear all cursors
	const first_url = has_prev ? `${base_path}?${limit_param}${query_param}${extra_qs}` : null;

	// Last: use ?last flag
	const last_url = has_next ? `${base_path}?last&${limit_param}${query_param}${extra_qs}` : null;

	return { prev_url, next_url, first_url, last_url };
}
