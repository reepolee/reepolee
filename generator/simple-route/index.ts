import { db } from "$config/db";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";

const DEFAULT_FIELDS: string[] = [__fields.array__];
const TABLE_NAME = "__table.name__";
const DEFAULT_WHERE = "__where.clause__";
const DEFAULT_ORDER_BY = "__order_by.clause__";

// Escape a string value for SQL (double single quotes).
function escape_sql(val: string): string {
	return val.replace(/'/g, "''");
}

// Build WHERE clause from a combination of static default + URL query params.
function build_where(params: URLSearchParams): string {
	const parts: string[] = [];

	// Static default WHERE from generator config
	if (DEFAULT_WHERE) { parts.push(DEFAULT_WHERE); }

	// Dynamic WHERE from URL: any param that isn't a reserved key
	// Prefix value with "==" for exact match, otherwise uses LIKE substring match
	const reserved = new Set(["fields", "sort", "dir"]);
	for (const [key, value] of params) {
		if (reserved.has(key)) continue;
		if (!value) continue;
		if (value.startsWith("==")) {
			const exact = value.slice(2);
			parts.push(`${key} = '${escape_sql(exact)}'`);
		} else { parts.push(`${key} LIKE '%${escape_sql(value)}%'`); }
	}

	if (parts.length === 0) return "";
	return ` WHERE ${parts.join(" AND ")}`;
}

// Build ORDER BY from URL params or fall back to static default.
function build_order(params: URLSearchParams): string {
	const sort = params.get("sort");
	if (sort) {
		const dir = params.get("dir")?.toUpperCase() === "DESC" ? "DESC" : "ASC";
		return ` ORDER BY ${sort} ${dir}`;
	}
	return DEFAULT_ORDER_BY;
}

// Get display fields from URL or fall back to defaults.
function get_fields(params: URLSearchParams): string[] {
	const raw = params.get("fields");
	if (raw) {
		return raw
			.split(",")
			.map((f) => f.trim())
			.filter(Boolean);
	}
	return DEFAULT_FIELDS;
}

export async function get_data_from_db(params: URLSearchParams) {
	try {
		const fields = get_fields(params);
		const field_names = fields.join(", ");
		const where_clause = build_where(params);
		const order_clause = build_order(params);
		const sql = `SELECT ${field_names} FROM ${TABLE_NAME}${where_clause}${order_clause} LIMIT 100`;
		const records = await db.unsafe(sql);
		return { records, fields };
	} catch (error) {
		return { records: [], fields: DEFAULT_FIELDS };
	}
}

export async function __handler.name__(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const url = new URL(req.url);
	const { records, fields } = await get_data_from_db(url.searchParams);
	const query_params = Object.fromEntries(url.searchParams.entries());
	const current_path = url.pathname;

	// Build sort URLs that preserve existing filter params
	const sort_urls: Record<string, { asc: string; desc: string }> = {};
	const baseParams = new URLSearchParams();
	for (const [key, value] of url.searchParams) {
		if (key === "sort" || key === "dir") continue;
		baseParams.append(key, value);
	}
	for (const field of fields) {
		const ascParams = new URLSearchParams(baseParams);
		ascParams.set("sort", field);
		ascParams.set("dir", "asc");
		const descParams = new URLSearchParams(baseParams);
		descParams.set("sort", field);
		descParams.set("dir", "desc");
		sort_urls[field] = {
			asc: `${current_path}?${ascParams.toString()}`,
			desc: `${current_path}?${descParams.toString()}`,
		};
	}

	const current_sort = url.searchParams.get("sort") || "";
	const current_dir = url.searchParams.get("dir")?.toLowerCase() || "asc";

	if (req.headers.get("Accept") === "application/json") { return Response.json({ data: records, fields }); }

	return render("index", { ctx, data: { records, fields, query_params, current_path, sort_urls, current_sort, current_dir } });
}
