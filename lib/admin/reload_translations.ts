/**
 * Reload Translations - admin endpoint extracted from server.ts
 *
 * POST /__reload-translations
 * Called by sync script or worker after writing translated values to the DB.
 */

import { active_languages } from "$config/supported_languages";
import { emit_translations } from "$lib/emit_translations";
import { translations } from "$lib/i18n";
import { clients, notify_clients } from "$lib/livereload";
import { reload_route_maps } from "$lib/route_map";
import { routes } from "$routes/routes";

import { require_admin_auth } from "./require_admin_auth";

/**
 * Handle POST /__reload-translations
 */
export async function handle_reload_translations(req: Request): Promise<Response> {
	const auth = require_admin_auth(req, "reload");
	if (!auth.ok) return auth.response;

	console.log("[reload] Reloading translations...");
	await translations.reload();
	reload_route_maps(translations.all, routes, active_languages);
	const translation_count = Object.keys(translations.all).length;
	console.log(`[reload] Translations reloaded (${translation_count} languages): ${auth.caller}`);

	const is_dev = Bun.argv.includes("--dev");
	if (is_dev) {
		// Refresh the ree-templates ghost-value files with the reloaded trees.
		await emit_translations(translations.all);

		const client_count = clients.size;
		notify_clients();
		console.log(`[reload] Notified ${client_count} client(s) to reload`);
	}

	return new Response("OK", { status: 200 });
}
