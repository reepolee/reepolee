const feature = get_table_name_from_dir(import.meta.dir);
const route_prefix = "__route_prefix__";
const DEFAULT_LIMIT = 20;
const DEFAULT_ORDER_BY = "id::asc";
const SORT_OPTIONS = __sort.options__;

const { base_path, entity_path } = feature_paths(route_prefix, feature);
const get_redirect_from_referer = (req: BunRequest) => redirect_from_referer(req, base_path());
const parse_pagination_params = (url: string) => parse_cursor_pagination_params(url, DEFAULT_LIMIT);
const build_pagination_urls = (
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
) => build_cursor_pagination_urls(base_path(), after_cursor, before_cursor, has_next, has_prev, query, order_by, limit_numeric, scope, filters, filter_not);
