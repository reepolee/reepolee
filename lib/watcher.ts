/**
 * File System Watcher - detects non-TypeScript file changes and triggers updates.
 *
 * IMPORTANT: Bun's `--hot` flag handles TypeScript file re-evaluation automatically.
 * This watcher only handles non-TS files:
 * - .ree -> notify browser to reload (templates read from disk in dev)
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

import { now_epoch_ms } from "$lib/temporal";

let watcher: ReturnType<typeof watch> | null = null;
const file_timestamps = new Map();
let reload_timeout: Timer | null = null;

function debounced_reload(notify_clients: () => void, message: string) {
	if (reload_timeout) clearTimeout(reload_timeout);
	reload_timeout = setTimeout(() => {
		console.log(message);
		notify_clients();
	}, 100);
}

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

		if (filename.includes(join("static", "app-dev.css"))) {
			debounced_reload(notify_clients, `🎨 CSS rebuilt: ${filename}`);
		} else if (filename.endsWith(".ree")) {
			debounced_reload(notify_clients, `🔄 Template changed: ${filename}`);
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
