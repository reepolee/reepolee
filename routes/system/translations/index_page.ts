/**
 * Translations admin - index page.
 *
 * The list view: namespace/group filtering (single-select dropdown +
 * ree-filters multi-select), search, SQL-level pagination over distinct
 * keys, and per-language value columns. Split from handlers.ts to keep
 * both files near the ~300-line convention.
 */

import { languages } from "$config/supported_languages";
import { get_cookie } from "$lib/cookies";
import { feature_paths } from "$lib/crud_routes";
import { get_table_name_from_dir } from "$lib/helpers";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import { enrich_filter_definitions, type FilterDef } from "$lib/table_filters";
import { type BunRequest, Cookie } from "bun";

import { flatten_to_keys, namespace_templates } from "./helpers";
import { count_translation_rows, get_namespace_groups, get_translations_page, type NamespaceGroup } from "./sql";

const feature = get_table_name_from_dir(import.meta.dir);
const route_prefix = "/system";

const { base_path } = feature_paths(route_prefix, feature);

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 10_000;

// Index

const ALLOWED_LIMITS = [5, 10, 20, 30, 50, 100];
const SORT_OPTIONS = [
	{ value: "namespace::asc", label: "Namespace (Ascending)" },
	{ value: "namespace::desc", label: "Namespace (Descending)" },
	{ value: "parent_path::asc", label: "Group (Ascending)" },
	{ value: "parent_path::desc", label: "Group (Descending)" },
];

/**
 * Build dropdown options from namespace groups.
 * Format: value="namespace::parent_path", label="namespace" or "namespace.group"
 */
function build_ns_options(groups: NamespaceGroup[]): { value: string; label: string; }[] {
	const options: { value: string; label: string; }[] = [];

	// Group by namespace, then sort groups within each namespace
	const ns_map = new Map();
	for (const g of groups) {
		if (!ns_map.has(g.namespace)) ns_map.set(g.namespace, []);
		ns_map.get(g.namespace)?.push(g.parent_path);
	}

	// Sort namespaces alphabetically
	const sorted_ns = Array.from(ns_map.keys()).sort();

	for (const ns of sorted_ns) {
		const pps = ns_map.get(ns)!;
		// Sort parent_paths: empty first, then alphabetical
		pps.sort((a, b) => {
			if (a === "" && b === "") return 0;
			if (a === "") return -1;
			if (b === "") return 1;
			return a.localeCompare(b);
		});

		for (const pp of pps) {
			const value = `${ns}::${pp}`;
			const label = pp ? `${ns}.${pp}` : ns;
			options.push({ value, label });
		}
	}

	return options;
}

export async function get_translations_index(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);

	// Parse ns_group param: format "namespace::parent_path"
	// e.g. "examples.email::labels" -> namespace=examples.email, group=labels
	// e.g. "examples::" -> namespace=examples, group="" (no group filter)
	// Falls back to old "namespace" param or cookie for backward compatibility.
	// When ns_group is explicitly in the URL (even empty), it takes priority over cookie.
	const url = new URL(req.url);
	const has_ns_param = url.searchParams.has("ns_group");
	const old_ns = url.searchParams.get("namespace");
	const cookie_val = get_cookie(req, "ns_filter") || "";

	let ns_param: string;
	if (has_ns_param) {
		// Explicit ns_group in URL - even empty means "clear filter"
		ns_param = url.searchParams.get("ns_group") || "";
	} else if (old_ns) {
		// Fallback to old namespace param
		ns_param = `${old_ns}::`;
	} else {
		// Fallback to cookie
		ns_param = cookie_val;
	}

	let namespace_filter = "";
	let group_filter = "";
	let ns_group_value = "";

	if (ns_param) {
		ns_group_value = ns_param;
		const delim = ns_param.indexOf("::");
		if (delim >= 0) {
			namespace_filter = ns_param.slice(0, delim);
			group_filter = ns_param.slice(delim + 2);
		} else {
			namespace_filter = ns_param;
		}
	}

	// Build filter definitions for ree-filters integration
	// Note: browsers send multiple values for checkbox groups as separate params
	// (e.g. filter_ns_group=admin::&filter_ns_group=examples::). We accumulate
	// them as comma-separated values so the handler can parse them.
	const filter_params: Record<string, string> = {};
	const filter_not_params: Record<string, string> = {};
	for (const [key, value] of url.searchParams.entries()) {
		if (key.startsWith("filter_not_")) {
			const fkey = key.slice(11);
			if (filter_not_params[fkey]) {
				filter_not_params[fkey] += `,${value}`;
			} else {
				filter_not_params[fkey] = value;
			}
		} else if (key.startsWith("filter_")) {
			const fkey = key.slice(7);
			if (filter_params[fkey]) {
				filter_params[fkey] += `,${value}`;
			} else {
				filter_params[fkey] = value;
			}
		}
	}

	// Parse multi-select ns_group filter from ree-filters checkboxes
	const filter_ns_group_raw = filter_params.ns_group || "";
	const multi_ns_groups: { namespace: string; parent_path: string; }[] = [];
	if (filter_ns_group_raw) {
		for (const raw of filter_ns_group_raw.split(",").filter(Boolean)) {
			const delim = raw.indexOf("::");
			if (delim >= 0) {
				const ns = raw.slice(0, delim);
				const pp = raw.slice(delim + 2);
				if (ns) multi_ns_groups.push({ namespace: ns, parent_path: pp });
			}
		}
	}

	// Parse pagination params
	const query = url.searchParams.get("query") || "";
	const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10));
	const limit_param = url.searchParams.get("limit") || String(DEFAULT_LIMIT);
	const order_by = url.searchParams.get("order_by") || "namespace::asc";

	const limit = limit_param === "all" ? MAX_LIMIT : Math.max(1, parseInt(limit_param, 10) || DEFAULT_LIMIT);

	// Special value "__global__" filters to only root-level (namespace='root') keys
	const is_global_filter = ns_group_value === "__global__" || (!ns_group_value && namespace_filter === "__global__");
	const db_ns_filter = is_global_filter ? "root" : namespace_filter;
	const db_group_filter = is_global_filter ? "" : group_filter;

	const ns_groups = await get_namespace_groups();

	// Build filter options for ree-filters checkboxes from all namespace groups
	const ns_options = build_ns_options(ns_groups);
	const ns_group_filter_options = ns_groups.map((g) => ({
		option_value: `${g.namespace}::${g.parent_path}`,
		option_text: g.parent_path ? `${g.namespace}.${g.parent_path}` : g.namespace,
	}));

	// Build filter_definitions - fk type renders checkboxes in ree-filters
	const raw_filter_definitions: FilterDef[] = [
		{
			key: "ns_group",
			type: "fk",
			label: "Namespace",
			fk_table: "translations",
			fk_column: "namespace",
		},
	];
	const filter_definitions = enrich_filter_definitions(
		raw_filter_definitions,
		{},
		filter_params,
		filter_not_params,
		{ ns_group: ns_group_filter_options }
	);
	const active_filter_count = filter_ns_group_raw ? 1 : 0;

	// Extract unique namespace names for the Add Group dialog
	const namespaces = [...new Set(ns_groups.map((g) => g.namespace))].sort();

	// SQL-level pagination: count distinct keys and load the current page
	const search_query = is_global_filter ? "" : query;

	// Use multi-select ns_group if present, otherwise fall back to single ns_group
	const use_multi = multi_ns_groups.length > 0;
	const negate_multi = filter_not_params.ns_group === "1";

	const [total, rows] = await Promise.all([
		count_translation_rows(
			db_ns_filter,
			db_group_filter,
			search_query,
			use_multi ? multi_ns_groups : [],
			negate_multi
		),
		get_translations_page(
			db_ns_filter,
			db_group_filter,
			search_query,
			use_multi ? multi_ns_groups : [],
			negate_multi,
			offset,
			limit === MAX_LIMIT ? MAX_LIMIT : limit
		),
	]);

	// Flatten to one entry per distinct key with all language values
	const flat_keys = flatten_to_keys(rows);

	// Sort
	const sort_parts = order_by.split("::");
	const sort_field = sort_parts[0] || "namespace";
	const sort_dir = sort_parts[1]?.toLowerCase() === "desc" ? -1 : 1;
	flat_keys.sort((a, b) => {
		let cmp: number;
		if (sort_field === "parent_path") {
			cmp = a.parent_path.localeCompare(b.parent_path);
		} else {
			cmp = a.namespace.localeCompare(b.namespace);
		}
		if (cmp === 0) cmp = a.key_path.localeCompare(b.key_path);
		return cmp * sort_dir;
	});

	// If empty page, redirect to first page
	if (flat_keys.length === 0 && offset > 0) {
		const params = new URLSearchParams();
		params.set("limit", String(limit));
		if (query) params.set("query", query);
		if (order_by !== "namespace::asc") params.set("order_by", order_by);
		if (ns_group_value && !use_multi) params.set("ns_group", ns_group_value);
		if (filter_ns_group_raw) params.set("filter_ns_group", filter_ns_group_raw);
		const qs = params.toString();
		return new Response(null, {
			status: 302,
			headers: { Location: qs ? `${base_path()}?${qs}` : base_path() },
		});
	}

	// Pagination - limit maps to number of distinct keys
	const limit_numeric = limit === MAX_LIMIT ? Math.max(total, 1) : limit;

	// Build pagination URLs
	const bp = base_path();
	const qp = query ? `&query=${encodeURIComponent(query)}` : "";
	const lp = `limit=${limit === MAX_LIMIT ? "all" : limit}`;
	const op = order_by !== "namespace::asc" ? `&order_by=${encodeURIComponent(order_by)}` : "";
	const nsp = ns_group_value && !use_multi ? `&ns_group=${encodeURIComponent(ns_group_value)}` : "";
	const fpp = filter_ns_group_raw ? `&filter_ns_group=${encodeURIComponent(filter_ns_group_raw)}` : "";

	const prev_offset = Math.max(0, offset - limit_numeric);
	const prev_url = offset > 0 ? `${bp}?offset=${prev_offset}&${lp}${qp}${op}${nsp}${fpp}` : null;

	const next_offset = offset + limit_numeric;
	const has_next = next_offset < total;
	const next_url = has_next ? `${bp}?offset=${next_offset}&${lp}${qp}${op}${nsp}${fpp}` : null;

	const last_offset = total > 0 ? Math.max(0, Math.ceil(total / limit_numeric) * limit_numeric - limit_numeric) : 0;
	const first_url = offset > 0 ? `${bp}?offset=0&${lp}${qp}${op}${nsp}${fpp}` : null;
	const last_url = total > 0 && has_next && offset < last_offset ? `${bp}?offset=${last_offset}&${lp}${qp}${op}${nsp}${fpp}` : null;

	// Limit options
	const limit_options_list: (number | "all")[] = [...ALLOWED_LIMITS];
	const current_limit = limit === MAX_LIMIT ? "all" : limit;
	if (current_limit !== "all" && !limit_options_list.includes(current_limit as number)) {
		limit_options_list.push(current_limit as number);
		limit_options_list.sort((a, b) => (a as number) - (b as number));
	}
	limit_options_list.push("all");

	const page_key_count = flat_keys.length;

	// Build current query string to pass to edit form for "Back" navigation
	const current_query = new URLSearchParams();
	if (ns_group_value && !use_multi) current_query.set("ns_group", ns_group_value);
	if (filter_ns_group_raw) current_query.set("filter_ns_group", filter_ns_group_raw);
	if (query) current_query.set("query", query);
	if (current_limit !== DEFAULT_LIMIT) current_query.set("limit", String(current_limit));
	if (order_by !== "namespace::asc") current_query.set("order_by", order_by);
	if (offset > 0) current_query.set("offset", String(offset));
	const current_query_string = current_query.toString();

	// Build dynamic grid columns: checkbox(10ch) + namespace(auto) + group(auto) + key(auto) + each language(1fr)
	const grid_cols = `10ch auto auto auto ${languages.map(() => "1fr").join(" ")}`;

	const response = await render("index", {
		data: {
			title: "Translations",
			flat_keys,
			page_key_count,
			grid_cols,
			ns_options,
			ns_group_value,
			current_query_string,
			namespaces,
			namespace_filter,
			group_filter,
			namespace_templates,
			languages,
			query,
			offset,
			filter_definitions,
			active_filter_count,
			limit: current_limit,
			order_by,
			total,
			limit_options: limit_options_list,
			sort_options: SORT_OPTIONS,
			prev_url,
			next_url,
			first_url,
			last_url,
		},
		ctx,
	});

	// Persist namespace filter in cookie (only for single-select ns_group, not multi-select)
	if (!use_multi) {
		const filter_cookie = new Cookie({
			name: "ns_filter",
			value: ns_group_value || namespace_filter,
			path: base_path(),
			maxAge: ns_group_value ? 86400 * 30 : 0,
		});
		response.headers.append("Set-Cookie", filter_cookie.toString());
	}

	return response;
}
