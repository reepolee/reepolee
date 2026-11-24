/**
 * Content negotiation for the read API.
 *
 * Every JSON-capable route decides the same way whether a caller wants JSON
 * back, so the test lives here once. An exact `Accept === "application/json"`
 * comparison is too strict for real clients: a bare `fetch()` sends
 * "application/json, text/plain, star/star" and browsers append quality
 * weights, so an exact match silently falls through to HTML.
 */

/**
 * Whether the request asks for a JSON response.
 *
 * True when the Accept header lists a JSON media type, or when the URL carries
 * `?format=json`. A bare wildcard does not count - browsers send it on every
 * navigation, and treating that as an API request would replace ordinary pages
 * with JSON.
 */
export function wants_json(req: Request): boolean {
	const url = new URL(req.url);
	const format_param = url.searchParams.get("format");
	if (format_param === "json") return true;

	const accept = req.headers.get("Accept") || "";
	const accept_lower = accept.toLowerCase();
	if (accept_lower.includes("application/json")) return true;
	if (accept_lower.includes("text/json")) return true;
	return accept_lower.includes("+json");
}
