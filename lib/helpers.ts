/**
 * Residual helpers without a better home yet.
 *
 * The old re-export barrel is retired - import directly from the module
 * that owns the function:
 * - $lib/cookies  -> get_cookie, get_cookies_by_prefix, create_toast_cookie
 * - $lib/format   -> display_currency, currency_no_cents, decimal, percent,
 *   display_percent, plural, format_bulk_delete_message
 * - $lib/object   -> deep_merge, updated_diff, merge_fields, get_nested
 * - $lib/route    -> route_namespace_from_dir, normalize_prefix,
 *   localized_url, get_lang_from_request
 *
 * Translation lookup lives on `ctx.translations`, resolved by `create_ctx()`
 * in `lib/request_context.ts` - not a standalone helper.
 */

export function get_table_name_from_dir(dir: string): string { return dir.replaceAll("\\", "/")
	.split("/")
	.pop()!; }

export function feature_enabled(name: string): boolean { return Bun.env[name]?.trim().toLowerCase() === "true"; }

export function feature_routes(enabled: boolean, routes: any[]) {
	return enabled ? routes : [];

}
