/**
 * File System Watcher - detects non-TypeScript file changes and triggers updates.
 *
 * IMPORTANT: Bun's `--hot` flag handles TypeScript file re-evaluation automatically.
 * This watcher only handles non-TS files:
 * - .ree -> notify browser to reload (templates read from disk in dev)
 * - {locale}.json -> reload translations + route maps, then notify browser.
 *   Translation files are read into memory once at startup; without this the
 *   running server keeps serving stale strings until a manual
 *   POST /__reload-translations or a restart.
 * - static/app-dev.css -> Tailwind's own `--watch=always` process (run by
 *   scripts/dev_run.ts) rebuilds this file incrementally; we only watch for
 *   it changing and notify the browser once it does.
 * - route-local static .js -> notify browser to reload.
 * TypeScript changes are NOT handled here - `--hot` re-evaluates modules, which
 * triggers the hot-reload path in server.ts to rebuild routes and notify clients.
 *
 * NOTE: this watcher does NOT spawn `tailwindcss` itself. A one-shot
 * `tailwindcss` CLI invocation pays a ~1s cold start (config parse, full
 * project scan) on every save; `tailwindcss --watch`'s incremental engine
 * rebuilds in single-digit ms once warm. Spawning it once as a long-lived
 * process (in scripts/dev_run.ts) and just watching its output file keeps
 * template-edit-to-browser-reload latency low. The tradeoff: that process
 * also re-triggers itself on its own writes to static/app-dev.css (its
 * watcher can only subscribe to whole directories, not exclude one file
 * within one), producing extra rebuilds with no source change - each is
 * cheap (ms-level) though, so this is preferred over paying the one-shot
 * cold-start cost per real edit.
 */

import { watch } from "node:fs";
import { join } from "node:path";

import { translations } from "$lib/i18n";
import { reload_route_maps } from "$lib/route_map";
import { now_epoch_ms } from "$lib/temporal";

let watcher: ReturnType<typeof watch> | null = null;
const file_timestamps = new Map();
let reload_timeout: Timer | null = null;

function debounced_reload(work: () => void | Promise<void>, message: string) {
	if (reload_timeout) clearTimeout(reload_timeout);
	reload_timeout = setTimeout(async () => {
		console.log(message);
		await work();
	}, 100);
}

/**
 * Reload in-memory translations from the co-located JSON files and rebuild
 * the route maps (nav labels etc. come from translations). Mirrors what the
 * POST /__reload-translations admin endpoint does, minus the auth - this runs
 * in-process in dev only.
 */
async function reload_translations_and_notify(notify_clients: () => void) {
	await translations.reload();
	reload_route_maps(translations.all);
	notify_clients();
}

// Same filename shape as lib/translation_files.ts's locale_filename_pattern -
// `{locale}.json` where locale is lowercase BCP 47 (e.g. en-us.json,
// sl-si.json). Applied to the basename so only translation files match.
const locale_json_pattern = /^[a-z]{2,3}-[a-z0-9]{2,8}\.json$/;

export function start_watcher(notify_clients: () => void) {
	// Only start watcher once globally, close old one if exists
	if (watcher) { watcher.close(); }

	// Watch routes folder
	const project_root = join(import.meta.dir, "../");

	watcher = watch(project_root, { recursive: true }, async (eventType, filename) => {
		if (!filename) return;
		const normalized_filename = filename.replaceAll("\\", "/");

		// Ignore changes in node_modules and .git
		if (filename.includes("node_modules") || filename.includes(".git")) { return; }

		const now = now_epoch_ms();
		const last_event_time = file_timestamps.get(filename) || 0;

		// Ignore duplicate events within 250ms
		if (now - last_event_time < 250) { return; }

		file_timestamps.set(filename, now);

		const basename = normalized_filename.split("/").pop() ?? "";

		if (filename.includes(join("static", "app-dev.css"))) {
			debounced_reload(notify_clients, `🎨 CSS rebuilt: ${filename}`);
		} else if (filename.endsWith(".ree")) {
			debounced_reload(notify_clients, `🔄 Template changed: ${filename}`);
		} else if (locale_json_pattern.test(basename)) {
			debounced_reload(() => reload_translations_and_notify(notify_clients), `🌐 Translations changed: ${filename}`);
		} else {
			const is_javascript = normalized_filename.endsWith(".js");
			const is_static_file = normalized_filename.startsWith("static/") || normalized_filename.includes("/static/");
			if (is_javascript && is_static_file) {
				debounced_reload(notify_clients, `🔄 Static script changed: ${filename}`);
			}
		}
		// NOTE: .ts and non-static .js changes are NOT handled here.
		// Bun's --hot flag handles TypeScript re-evaluation automatically, which
		// triggers the hot-reload path in server.ts to rebuild routes
		// and notify clients.
	});

	console.log(`👀 Watching for changes...`);
}
