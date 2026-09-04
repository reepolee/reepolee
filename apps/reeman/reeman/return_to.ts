// Pages a reeman form may redirect back to. Any other return_to is ignored
// by the open-redirect guard and falls back to the dashboard.
const REEMAN_PAGES = new Set(["/", "/refresh", "/database", "/routes", "/logs", "/tables", "/locales"]);
const ROUTE_DETAIL_PATTERN = /^\/routes\/\d+$/;
const ROUTE_EDIT_PATTERN = /^\/routes\/edit\?url=%2F[\w%.-]+$/;

export function safe_return_to(raw: string): string {
	const trimmed = (raw ?? "").trim();
	const clean = trimmed.replace(/\/+$/, "");
	const normalized = clean === "" ? "/" : clean;
	if (REEMAN_PAGES.has(normalized)) return normalized;
	if (ROUTE_DETAIL_PATTERN.test(normalized)) return normalized;
	if (ROUTE_EDIT_PATTERN.test(normalized)) return normalized;
	return "/";
}
