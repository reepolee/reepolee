import { build_pagination_urls, get_limit_options, parse_pagination_params } from "$lib/pagination";
import { enrich_filter_definitions, type FilterDef } from "$lib/table_filters";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import type { BunRequest } from "bun";

// AGENT NOTE: This file is a complete hand-written example of a Reeman-like
// index page whose source is not a database table. Keep the route handler and
// template together while experimenting, then split reusable pieces only when
// the real application needs them.

type Owner = {
	id: number;
	name: string;
};

// AGENT EXTENSION POINT: Change this type to match the shape returned by the
// API, SDK, filesystem reader, queue, or other non-table source being displayed.
// The `id` field is used by the detail route; it does not have to be a DB ID.
type LocalRecord = {
	id: number;
	method: string;
	path: string;
	status: number;
	owner_id: number;
	last_checked: string;
};

// DATA SOURCE EXAMPLE
//
// This is deliberately an in-memory data source. Replace these arrays with
// data from an API, a service, or another non-table source in a real app.
// Keep lookup data separate from rows when the source exposes foreign-key-like
// IDs. That makes this example mirror a generated CRUD page without requiring
// an actual `owners` table.
export const owners: Owner[] = [
	{ id: 1, name: "Web" },
	{ id: 2, name: "Platform" },
	{ id: 3, name: "Identity" },
	{ id: 4, name: "Projects" },
	{ id: 5, name: "Analytics" },
	{ id: 6, name: "Commerce" },
	{ id: 7, name: "Messaging" },
];

// DISPLAY MAPPING
// Build the lookup once instead of scanning `owners` for every table cell.
// AGENT EXTENSION POINT: Add more maps/helpers here for other related values
// (for example status codes, categories, regions, or user IDs).
const owner_by_id = new Map(owners.map((owner) => [owner.id, owner]));
const owner_name = (owner_id: number): string => owner_by_id.get(owner_id)?.name || "Unknown";

// ROW DATA
// AGENT EXTENSION POINT: Replace this constant with the result of your local
// data loader. The rest of the index flow can remain unchanged if it returns
// the same `LocalRecord` shape.
const records: LocalRecord[] = [
	{ id: 1, method: "GET", path: "/", status: 200, owner_id: 1, last_checked: "2026-08-08" },
	{ id: 2, method: "GET", path: "/api/health", status: 200, owner_id: 2, last_checked: "2026-08-08" },
	{ id: 3, method: "POST", path: "/api/auth/login", status: 201, owner_id: 3, last_checked: "2026-08-07" },
	{ id: 4, method: "GET", path: "/api/users", status: 200, owner_id: 3, last_checked: "2026-08-07" },
	{ id: 5, method: "GET", path: "/api/users/:id", status: 200, owner_id: 3, last_checked: "2026-08-06" },
	{ id: 6, method: "PATCH", path: "/api/users/:id", status: 200, owner_id: 3, last_checked: "2026-08-06" },
	{ id: 7, method: "DELETE", path: "/api/users/:id", status: 204, owner_id: 3, last_checked: "2026-08-05" },
	{ id: 8, method: "GET", path: "/api/projects", status: 200, owner_id: 4, last_checked: "2026-08-05" },
	{ id: 9, method: "POST", path: "/api/projects", status: 201, owner_id: 4, last_checked: "2026-08-04" },
	{ id: 10, method: "GET", path: "/api/projects/:id", status: 200, owner_id: 4, last_checked: "2026-08-04" },
	{ id: 11, method: "PUT", path: "/api/projects/:id", status: 200, owner_id: 4, last_checked: "2026-08-03" },
	{ id: 12, method: "GET", path: "/api/activity", status: 200, owner_id: 5, last_checked: "2026-08-03" },
	{ id: 13, method: "GET", path: "/api/metrics", status: 200, owner_id: 5, last_checked: "2026-08-02" },
	{ id: 14, method: "POST", path: "/api/reports", status: 202, owner_id: 5, last_checked: "2026-08-02" },
	{ id: 15, method: "GET", path: "/api/reports/:id", status: 200, owner_id: 5, last_checked: "2026-08-01" },
	{ id: 16, method: "GET", path: "/api/catalog", status: 200, owner_id: 6, last_checked: "2026-07-31" },
	{ id: 17, method: "POST", path: "/api/orders", status: 201, owner_id: 6, last_checked: "2026-07-31" },
	{ id: 18, method: "GET", path: "/api/orders/:id", status: 200, owner_id: 6, last_checked: "2026-07-30" },
	{ id: 19, method: "POST", path: "/api/webhooks/stripe", status: 202, owner_id: 6, last_checked: "2026-07-30" },
	{ id: 20, method: "GET", path: "/api/notifications", status: 200, owner_id: 7, last_checked: "2026-07-29" },
	{ id: 21, method: "POST", path: "/api/notifications/send", status: 202, owner_id: 7, last_checked: "2026-07-29" },
	{ id: 22, method: "GET", path: "/api/search", status: 200, owner_id: 2, last_checked: "2026-07-28" },
	{ id: 23, method: "GET", path: "/api/files/:id", status: 200, owner_id: 2, last_checked: "2026-07-28" },
	{ id: 24, method: "POST", path: "/api/files", status: 201, owner_id: 2, last_checked: "2026-07-27" },
];

// DETAIL LOOKUP
// The nested record-details route imports this helper so it uses the exact same
// source as the list. In a real app this could call an API lookup instead.
export function get_index_template_record(id: number): (LocalRecord & { owner: string }) | undefined {
	const record = records.find((item) => item.id === id);
	return record ? { ...record, owner: owner_name(record.owner_id) } : undefined;
}

// SORTING
// Each value is the URL value used by the shared `navigate_to` helper. Add one
// asc/desc pair here and update `compare_records` if the field needs custom
// comparison logic (dates, mapped labels, numeric strings, and so on).
const SORT_OPTIONS = [
	{ value: "id::asc", field: "id", direction: "asc" },
	{ value: "id::desc", field: "id", direction: "desc" },
	{ value: "method::asc", field: "method", direction: "asc" },
	{ value: "method::desc", field: "method", direction: "desc" },
	{ value: "path::asc", field: "path", direction: "asc" },
	{ value: "path::desc", field: "path", direction: "desc" },
	{ value: "status::asc", field: "status", direction: "asc" },
	{ value: "status::desc", field: "status", direction: "desc" },
	{ value: "owner_id::asc", field: "owner_id", direction: "asc" },
	{ value: "owner_id::desc", field: "owner_id", direction: "desc" },
	{ value: "last_checked::asc", field: "last_checked", direction: "asc" },
	{ value: "last_checked::desc", field: "last_checked", direction: "desc" },
] as const;

type SortOption = typeof SORT_OPTIONS[number];
const SORT_FIELDS = new Map<string, SortOption>(SORT_OPTIONS.map((option) => [option.value, option]));
// FILTERING
// `FilterDef`/`enrich_filter_definitions` provide the same selection UI used by
// generated CRUD pages. They do not execute SQL here: the selected IDs are
// applied to the local array in `get_index_template` below.
// AGENT EXTENSION POINT: Add another definition and option list for each local
// selection filter, then apply it in the in-memory filtering step.
const OWNER_FILTERS: FilterDef[] = [{ key: "owner_id", type: "fk", label: "Owner", fk_table: "owners", fk_column: "id", fk_text_field: "name" }];
const OWNER_OPTIONS = { owner_id: owners.map((owner) => ({ option_value: owner.id, option_text: owner.name })) };
// Status uses the shared FK-style checkbox renderer because this example has
// no database domain metadata. AGENT EXTENSION POINT: Replace these derived
// options with the status enum/catalog from the real non-table source.
const STATUS_VALUES = [...new Set(records.map((record) => record.status))].sort((a, b) => a - b);
const STATUS_FILTERS: FilterDef[] = [{ key: "status", type: "fk", label: "Status" }];
const STATUS_OPTIONS = { status: STATUS_VALUES.map((status) => ({ option_value: status, option_text: String(status) })) };

// PAGINATION / ROUTE CONSTANTS
// Keep BASE_PATH in sync with the route definition and every generated URL.
const DEFAULT_LIMIT = 20;
const BASE_PATH = "/examples/index-template";

// Compare two rows according to the validated URL sort value. Mapped owner
// labels are used for owner sorting so the UI behaves like a joined CRUD view.
function compare_records(a: LocalRecord, b: LocalRecord, order_by: string): number {
	const option = SORT_FIELDS.get(order_by) || SORT_OPTIONS[0];
	const left = option.field === "owner_id" ? owner_name(a.owner_id) : a[option.field];
	const right = option.field === "owner_id" ? owner_name(b.owner_id) : b[option.field];
	const comparison = typeof left === "number" && typeof right === "number"
		? left - right
		: String(left).localeCompare(String(right));
	return option.direction === "asc" ? comparison : -comparison;
}

// ROUTE RESOURCE
// This object is mounted by apps/main/examples/index.ts. It intentionally exposes
// only the list endpoint here; the detail resource is registered separately.
export const index_template_page = {
	"/examples/index-template": get_index_template,
};

// GET /examples/index-template
// The sequence below is intentionally explicit for agents to adapt:
// 1. Parse shared list controls from the URL.
// 2. Normalize sort/page-size inputs.
// 3. Filter and sort the non-DB rows.
// 4. Slice the current page.
// 5. Build URLs and filter props for the generated-style template.
export async function get_index_template(req: BunRequest): Promise<Response> {
	// create_ctx supplies locale, translations, session/toast state, and route
	// directory information required by the shared layout renderer.
	const ctx = await create_ctx(req, import.meta.dir);
	const { query, offset, limit, order_by, filters, filter_not } = parse_pagination_params(req.url, DEFAULT_LIMIT);
	const sort_option = SORT_FIELDS.get(order_by) || SORT_OPTIONS[0];
	const normalized_order_by = sort_option.value;
	const effective_limit = limit === "all" ? "all" : Math.max(1, limit);
	const limit_numeric = effective_limit === "all" ? records.length || 1 : effective_limit;
	const normalized_query = query.trim().toLowerCase();
	// Filter values arrive as comma-separated URL parameters, exactly like the
	// generated table filter component emits. Convert once to a Set for lookup.
	const selected_owner_ids = new Set((filters.owner_id || "").split(",").filter(Boolean).map(Number));
	const has_owner_filter = selected_owner_ids.size > 0;
	const is_owner_filter_negated = filter_not.owner_id === "1";
	const selected_statuses = new Set((filters.status || "").split(",").filter(Boolean).map(Number));
	const has_status_filter = selected_statuses.size > 0;
	const is_status_filter_negated = filter_not.status === "1";

	// Apply local filters first, then the free-text search. Include the mapped
	// owner label in search so searching for "Platform" finds its rows too.
	const filtered_records = records
		.filter((record) => {
			const owner_matches = !has_owner_filter || selected_owner_ids.has(record.owner_id);
			const status_matches = !has_status_filter || selected_statuses.has(record.status);
			const owner_result = has_owner_filter && is_owner_filter_negated ? !owner_matches : owner_matches;
			const status_result = has_status_filter && is_status_filter_negated ? !status_matches : status_matches;
			return owner_result && status_result;
		})
		.filter((record) => !normalized_query || [
			...Object.values(record),
			owner_name(record.owner_id),
		].some((value) => String(value).toLowerCase().includes(normalized_query)))
		.sort((a, b) => compare_records(a, b, normalized_order_by));
	// Pagination is performed after filtering/sorting so total and page boundaries
	// describe the visible result set rather than the original array.
	const total = filtered_records.length;
	const page_records = (effective_limit === "all" ? filtered_records : filtered_records.slice(offset, offset + limit_numeric))
		.map((record) => ({ ...record, owner: owner_name(record.owner_id) }));
	const { prev_url, next_url, first_url, last_url } = build_pagination_urls(BASE_PATH, offset, limit_numeric, total, query, normalized_order_by, "", filters, filter_not);
	// Enrichment adds checked state and option buckets expected by <ree-filters>.
	// `filter_params`/`filter_not_params` are also passed to preserve state in
	// pagination URLs and to make future custom filter controls possible.
	const filter_definitions = enrich_filter_definitions(
		[...OWNER_FILTERS, ...STATUS_FILTERS],
		ctx.translations.labels || {},
		filters,
		filter_not,
		{ ...OWNER_OPTIONS, ...STATUS_OPTIONS },
	);

	return render("index", {
		data: {
			title: "Index Template",
			records: page_records,
			query,
			limit: effective_limit,
			offset,
			order_by: normalized_order_by,
			total,
			limit_options: get_limit_options(effective_limit),
			sort_options: SORT_OPTIONS,
			prev_url,
			next_url,
			first_url,
			last_url,
			filter_definitions,
			filter_params: filters,
			filter_not_params: filter_not,
			active_filter_count: (has_owner_filter || is_owner_filter_negated ? 1 : 0) + (has_status_filter || is_status_filter_negated ? 1 : 0),
			ui: ctx.translations.ui,
		},
		ctx,
	});
}

// AGENT EXTENSION POINT: For JSON consumers, add a wants_json branch before
// render() and return the same filtered/page_records data as Response.json().
// Keep the HTML path and JSON path based on the same filtering pipeline.
