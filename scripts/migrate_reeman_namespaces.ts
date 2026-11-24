#!/usr/bin/env bun
/**
 * One-time dev-DB migration for the reeman app extraction (pre-1.0, no
 * backwards compatibility).
 *
 * The sysadmin pages moved from routes/system/<feature> (translation namespace
 * "system.<feature>") to apps/reeman/<feature> and are now mounted as flat
 * route modules named after their folder, so their translation namespace is
 * the folder name ("system.users" -> "users", etc.).
 *
 * `system.auth` is intentionally left alone here. Auth has since moved again,
 * to platform/auth/, which renamed its namespaces "system.auth.*" -> "auth.*";
 * that move carried the co-located locale files with it and needs no DB step.
 * The bare "system" module rows (route_name / nav_prefix_title) are kept.
 *
 * Run once against the dev database (reads DEV_CONNECTION_STRING from .env):
 *   bun scripts/migrate_reeman_namespaces.ts
 */
import { db } from "$config/db";

const MAPPINGS: Record<string, string> = {
	"system.cache": "cache",
	"system.files": "files",
	"system.global_scopes": "global_scopes",
	"system.images": "images",
	"system.modules": "modules",
	"system.queues": "queues",
	"system.rate_limits": "rate_limits",
	"system.translations": "translations",
	"system.users": "users",
};

let total = 0;
for (const [from, to] of Object.entries(MAPPINGS)) {
	const result = (await db`UPDATE translations SET namespace = ${to} WHERE namespace = ${from}`) as unknown as { changes: number; };
	const changed = result?.changes ?? 0;
	total += changed;
	console.log(`moved '${from}' -> '${to}' (${changed} rows)`);
}

console.log(`\nDone. ${total} translation rows re-keyed.`);
console.log("Restart the reeman server (or POST /__reload-translations) to pick up the change.");
