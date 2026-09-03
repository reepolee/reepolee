/**
 * Reload routes - authenticated endpoint used after generators change the
 * main route registry on disk.
 */

import { reload_live_routes } from "$lib/route_state";

import { require_admin_auth } from "./require_admin_auth";

/** Handle POST /__reload-routes. */
export async function handle_reload_routes(req: Request): Promise<Response> {
	const auth = require_admin_auth(req, "reload-routes");
	if (!auth.ok) return auth.response;

	console.log("[reload-routes] Rebuilding routes from disk...");
	try {
		await reload_live_routes();
		console.log(`[reload-routes] Routes rebuilt: ${auth.caller}`);
		return new Response("OK", { status: 200 });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[reload-routes] Failed: ${message}`);
		return new Response("Route reload failed", { status: 500 });
	}
}
