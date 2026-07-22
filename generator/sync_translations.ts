#!/usr/bin/env bun

import { join, relative } from "node:path";

import { db_cli } from "$config/db_cli";
import { notify_server_reload } from "$lib/server_notify";
import { init_queue, is_queue_available, is_worker_alive } from "$queue/index";

import { sync_all_namespaces, sync_single_namespace } from "./translate_namespace";

// -------------------- HELPERS --------------------

function dir_to_namespace(dir: string, root_dir: string): string | null {
	const rel = relative(root_dir, dir).replace(/\\/g, "/");
	if (rel === "." || rel === "") return "root";
	if (rel.startsWith("..")) return null;
	return rel.split("/").join(".");
}

function parse_scope_namespaces(): string[] {
	// Collect positional args that aren't flags or flag values
	const namespaces: string[] = [];
	const routes_root = join(process.cwd(), "routes");

	for (let i = 2; i < Bun.argv.length; i++) {
		const a = Bun.argv[i];
		if (!a) continue;
		if (a === "--translate") continue;

		// Accept either a path (e.g. "routes/system/users") or a namespace (e.g. "system.users")
		const full_path = join(process.cwd(), a);
		const namespace = dir_to_namespace(full_path, routes_root);
		if (namespace !== null) {
			if (!namespaces.includes(namespace)) { namespaces.push(namespace); }
		} else {
			// Fallback: treat as namespace directly
			if (!namespaces.includes(a)) { namespaces.push(a); }
		}
	}

	return namespaces;
}

async function get_all_namespaces(): Promise<string[]> {
	try {
		const rows = (await db_cli`SELECT DISTINCT namespace FROM translations ORDER BY namespace`) as { namespace: string; }[];
		return rows.map((r) => r.namespace);
	} catch {
		return [""];
	}
}

async function main() {
	const scope_ns = parse_scope_namespaces();
	const translate = Bun.argv.includes("--translate");

	// Try to connect to Redis for queue-based translation
	await init_queue();

	const queue_mode = is_queue_available() && (await is_worker_alive()) && translate;

	// Determine namespaces to process
	// When "routes" (global namespace) is scoped, expand to ALL namespaces
	// (backward compat: "routes" meant sync everything in the old file-based code)
	const namespaces = scope_ns.includes("") ? await get_all_namespaces() : scope_ns.length > 0 ? scope_ns : await get_all_namespaces();

	console.log(`🚀 Syncing translations in ${namespaces.length} namespace(s) (translate: ${translate})${scope_ns.length > 0 ? ` [scoped]` : ``}...`);
	if (queue_mode) { console.log(`📦 Redis available - translation jobs will be processed by queue worker.`); }

	// When --translate is set, delegate to sync_all_namespaces() which scans the DB directly
	if (translate) {
		await sync_all_namespaces();
	} else {
		// Non-translate mode: use original scope-based flow (just structure sync, no AI)
		for (const namespace of namespaces) {
			await sync_single_namespace(namespace, false);
		}
	}

	if (queue_mode) {
		const GREEN = "\u001b[32m";
		const RESET = "\u001b[0m";
		console.log();
		console.log(`${GREEN}✅ All namespaces synced. ${namespaces.length > 0 ? `Translation jobs enqueued - check /system/queues for progress.` : ``}${RESET}`);
	}
}

main().then(async () => {
	await notify_server_reload();
	process.exit(0);
});
