import type { Handler, Method, Middleware, RouteHandler, RouteTable } from "./types";

// Compose middlewares around a handler (right-to-left).
export function with_middleware(handler: Handler, ...mws: Middleware[]): Handler { return mws.reduceRight<Handler>((next, mw) => (req) => mw(req, next), handler); }

/**
 * Apply `wrap` to a route entry - a plain handler or a per-method map.
 * Non-function junk passes through untouched.
 */
function map_route_handler(route: RouteHandler, wrap: (h: Handler) => Handler): RouteHandler {
	if (typeof route === "function") { return wrap(route); }

	if (route && typeof route === "object") {
		const wrapped: Partial<Record<Method, Handler>> = {};
		for (const method of Object.keys(route) as Method[]) {
			const h = route[method];
			if (typeof h === "function") { wrapped[method] = wrap(h); }
		}
		return wrapped;
	}

	return route;
}

/**
 * Wrap all route handlers (functions and method maps) with the given middlewares.
 *
 * NOTE: Trailing-slash normalization is handled at runtime by the fetch handlers
 * (dev: match_route() strips trailing / before lookup; prod: 301 redirect).
 * We don't duplicate route entries here - the route table stays at N entries,
 * not 2N.
 */
export function wrap_all_routes<T extends RouteTable>(routes: T, ...mws: Middleware[]): T {
	const out: Record<string, RouteHandler> = {};

	for (const [path, route] of Object.entries(routes)) {
		out[path] = map_route_handler(route, (h) => with_middleware(h, ...mws));
	}

	return out as T;
}

/**
 * Mount a route table under a URL prefix, optionally wrapping each handler
 * with middlewares.
 *
 * Example:
 * mount_prefix("/admin", admin_crud, require_module_mw("admin"))
 * -> "/admin/users", "/admin/users/new", etc.
 */
export function mount_prefix(prefix: string, routes: RouteTable, ...mws: Middleware[]): RouteTable {
	// Guard: prefix must be "" or start with "/" and not end with "/"
	// Reject "/" as well since it would produce "//path" on concatenation
	if (prefix !== "" && !prefix.startsWith("/")) { throw new Error(`mount_prefix: prefix "${prefix}" must start with "/"`); }
	if (prefix.length > 1 && prefix.endsWith("/")) { throw new Error(`mount_prefix: prefix "${prefix}" must not end with "/"`); }
	if (prefix === "/") {
		throw new Error(
			`mount_prefix: prefix "/" is not allowed - would produce "//path"`,
		);
	}

	const out: Record<string, RouteHandler> = {};

	for (const [path, route] of Object.entries(routes)) {
		if (!path.startsWith("/")) { throw new Error(`mount_prefix: route path "${path}" must start with "/"`); }
		out[prefix + path] = mws.length > 0 ? map_route_handler(route, (h) => with_middleware(h, ...mws)) : route;
	}

	return out;
}
