const feature = get_table_name_from_dir(import.meta.dir);
const route_prefix = "__route_prefix__";
const DEFAULT_LIMIT = 20;
const SORT_OPTIONS = __sort.options__;

const { base_path, entity_path } = feature_paths(route_prefix, feature);
const get_redirect_from_referer = (req: BunRequest) => redirect_from_referer(req, base_path());
const parse_pagination_params = (url: string) => parse_offset_pagination_params(url, DEFAULT_LIMIT, ["scope"]);
const build_pagination_urls = (
	current_offset: number,
	limit_numeric: number,
	total: number,
	query: string,
	order_by: string,
	scope: string = "",
	filters: Record<string, string> = {},
	filter_not: Record<string, string> = {},
) => build_offset_pagination_urls(base_path(), current_offset, limit_numeric, total, query, order_by, scope, filters, filter_not);
