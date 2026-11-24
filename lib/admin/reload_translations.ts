/**
 * Reload Translations - admin endpoint extracted from server.ts
 *
 * POST /__reload-translations
 * Called by sync script or worker after writing translated values to the DB.
 */

import { translations } from "$lib/i18n";
import { clients, notify_clients } from "$lib/livereload";
import { reload_route_maps } from "$lib/route_map";

import { require_admin_auth } from "./require_admin_auth";

/**
 * Handle POST /__reload-translations
 */
export async function handle_reload_translations(req: Request): Promise<Response> {
	const auth = require_admin_auth(req, "reload");
	if (!auth.ok) return auth.response;

	console.log("[reload] Reloading translations...");
	await translations.reload();

	// Rebuild the route maps from whatever routes the live server last built
	// with - reload_route_maps() falls back to route_map's own cached_routes.
	//
	// Do not re-import $main/routes here, by either form. A static import is
	// bound when this module is first evaluated and never refreshes, so it can
	// hand back a table from before a route was generated and *remove* a route
	// the server is already serving. A cache-busting dynamic import re-evaluates
	// the whole downstream graph and yields a second copy of $lib/i18n and
	// $lib/route_map, so the rebuild writes into modules the live server never
	// reads and the reload silently does nothing.
	//
	// Route *structure* changes (a new or removed route) are therefore out of
	// scope here: they arrive via the process restart that lib/server_notify.ts
	// triggers by stamping routes.ts. This endpoint covers translation content
	// for routes the server already knows about.
	reload_route_maps(translations.all);

	const translation_count = Object.keys(translations.all).length;
	console.log(`[reload] Translations reloaded (${translation_count} languages): ${auth.caller}`);

	const is_dev = Bun.argv.includes("--dev");
	if (is_dev) {
		const client_count = clients.size;
		notify_clients();
		console.log(`[reload] Notified ${client_count} client(s) to reload`);
	}

	return new Response("OK", { status: 200 });
}
