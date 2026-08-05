/**
 * Notify the running server to reload after generators write to disk/DB.
 *
 * Used by generator/*.ts and worker.ts.
 *
 * Two paths:
 * restart=true  (CRUD / route generators) - appends a reload stamp to
 * routes.ts so Bun --watch detects the change, kills the
 * old process, and starts a fresh one that reads all
 * routes/nav from disk.
 * restart=false (worker)                  - POST /__reload-translations
 * reloads in-memory translations without a restart.
 *
 * Errors are caught and logged - the caller should never throw from this.
 */

import { join } from "node:path";

async function notify_reload_translations(): Promise<void> {
	const protocol = "http";
	const host = Bun.env.SERVER_NAME || "localhost";
	const port = Bun.env.PORT || "2338";
	const url = `${protocol}://${host}:${port}/__reload-translations`;

	try {
		const headers: Record<string, string> = {};
		const reload_secret = Bun.env.RELOAD_SECRET;
		if (reload_secret) { headers["X-Reload-Secret"] = reload_secret; }

		const res = await fetch(url, { method: "POST", headers });

		if (res.ok) {
			console.log(`  🔄 Translations reloaded`);
		} else {
			console.log(`  ⚠️  Server reload returned ${res.status}: ${await res.text().catch(() => "")}`);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.log(`  ℹ️  Server reload skipped (server not reachable: ${message})`);
	}
}

async function trigger_server_restart(): Promise<void> {
	try {
		const stamp = `// [reload ${Date.now()},${Math.random().toString(36).slice(2)}]\n`;
		const routes_path = join(process.cwd(), "routes", "routes.ts");
		const content = await Bun.file(routes_path).text();
		await Bun.write(routes_path, content.replace(/^\/\/ \[reload .*\]\n?/gm, "") + stamp);

		console.log(`  🔄 Server restart triggered`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.log(`  ℹ️  Server restart trigger skipped (${message})`);
	}
}

export async function notify_server_reload(restart: boolean = true): Promise<void> {
	if (restart) {
		await trigger_server_restart();
	} else {
		await notify_reload_translations();
	}
}
