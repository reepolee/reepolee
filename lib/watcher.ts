/**
 * File System Watcher - detects non-TypeScript file changes and triggers updates.
 *
 * IMPORTANT: Bun's `--hot` flag handles TypeScript file re-evaluation automatically.
 * This watcher only handles non-TS files:
 * - .ree -> notify browser to reload (templates read from disk in dev)
 * - .css -> notify browser to reload
 * TypeScript changes are NOT handled here - `--hot` re-evaluates modules, which
 * triggers the hot-reload path in server.ts to rebuild routes and notify clients.
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
	}, 300);
}

export function start_watcher(notify_clients: () => void) {
	// Only start watcher once globally, close old one if exists
	if (watcher) { watcher.close(); }

	// Watch routes folder
	const project_root = join(import.meta.dir, "../");

	watcher = watch(project_root, { recursive: true }, async (eventType, filename) => {
		if (!filename) return;

		// Ignore changes in node_modules and .git
		if (filename.includes("node_modules") || filename.includes(".git")) { return; }

		const now = now_epoch_ms();
		const last_event_time = file_timestamps.get(filename) || 0;

		// Ignore duplicate events within 250ms
		if (now - last_event_time < 250) { return; }

		file_timestamps.set(filename, now);

		if (filename.endsWith(".ree")) {
			debounced_reload(notify_clients, `🔄 Template changed: ${filename}`);
		} else if (filename.endsWith(".css")) {
			debounced_reload(notify_clients, `🎨 CSS changed: ${filename}`);
		}
		// NOTE: .ts changes are NOT handled here.
		// Bun's --hot flag handles TS re-evaluation automatically, which
		// triggers the hot-reload path in server.ts to rebuild routes
		// and notify clients.
	});

	console.log(`🔥 Live reload enabled!`);
	console.log(`👀 Watching for changes in ${project_root}`);
}
