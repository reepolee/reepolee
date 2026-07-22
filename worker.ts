// worker.ts - Standalone Redis queue worker process
//
// Runs outside the main HTTP server so it can be restarted independently.
// Connects to the same Redis as server.ts and processes enqueued jobs.
//
// Usage:
// bun run worker.ts              # production
// bun --hot worker.ts            # development (auto-restart on file changes)

// Early exit if Redis is not configured
if (!Bun.env.REDIS_URL) {
	console.error("🧑‍🏭 Queue worker not started - REDIS_URL not set.");
	console.error("   Emails are sent directly via SMTP from the server.");
	process.exit(0);
}

import { language_names } from "$config/supported_languages";
import { notify_server_reload } from "$lib/server_notify";
import { send_mail } from "$lib/smtp";
import { apply_translations, count_leaves, log_translation_result, sort_object } from "$lib/translation_merge";
import {
	get_failed_job_ids,
	init_queue,
	is_queue_available,
	is_worker_alive,
	queue_length,
	reap_orphans,
	set_worker_heartbeat,
	start_worker,
} from "$queue/index";

import { translate_json } from "./generator/translator";

// Bootstrap

await init_queue();

if (!is_queue_available()) {
	console.log("🧑‍🏭 Queue worker not started - Redis unavailable. Emails are sent directly via SMTP from the server.");
	process.exit(0);
}

// Recover any jobs orphaned by a previous worker crash before starting fresh
const reaped = await reap_orphans();
if (reaped > 0) { console.log(`[worker] Re-enqueued ${reaped} orphaned job(s) from previous lifecycle`); }

// Show pending jobs in each queue (BEFORE starting BRPOP loops)

const known_queues = ["send_email", "translate_batch"];
const queue_stats = await Promise.all(known_queues.map(async (queue) => {
	const [pending, failed_ids] = await Promise.all([queue_length(queue), get_failed_job_ids(queue, 1)]);
	return { queue, pending, failed_ids };
}));

for (const { queue, pending, failed_ids } of queue_stats) {
	if (pending > 0 || failed_ids.length > 0) {
		const parts: string[] = [];
		if (pending > 0) parts.push(`${pending} pending`);
		if (failed_ids.length > 0) parts.push(`${failed_ids.length} failed`);
		console.log(`[queue] ${queue}: ${parts.join(", ")}`);
	}
}

// Register the "send_email" worker.
// Processes emails sent via routes/email.
start_worker("send_email", async (job) => {
	const { to, cc, bcc, subject, body, html } = job.payload;
	await send_mail({ to, cc, bcc, subject, body, html: html || body });
}, { concurrency: 1 });

// Register the "translate_batch" worker.
// Processes translation jobs enqueued by generator/sync_translations.ts.
// Each job translates untranslated keys for one language in one namespace.
start_worker(
	"translate_batch",
	async (job) => {
		const { namespace, lang, untranslated } = job.payload;

		const display = namespace || "(global)";
		console.log(`📄 Translating: ${display} / ${lang}`);

		// 1. Lazy import DB
		let db: any = null;
		try {
			db = (await import("$config/db")).db;
		} catch {
			console.error("❌ DB not available - cannot process translation job");
			return;
		}

		// 2. Read current translations + call AI translation in parallel
		const target_lang_name = language_names[lang];
		const num_keys = count_leaves(untranslated);
		console.log(`🌍 Translating English → ${target_lang_name} (${num_keys} keys)...`);

		const read_current = (async (): Promise<any> => {
			const current: any = {};
			try {
				const rows = (await db`SELECT key_path, translation FROM translations WHERE namespace = ${namespace} AND lang = ${lang}`) as {
					key_path: string;
					translation: string;
				}[];

				// Reconstruct nested object from flattened key_paths
				for (const row of rows) {
					const parts = row.key_path.split(".");
					let target = current;
					for (let i = 0; i < parts.length - 1; i++) {
						if (!target[parts[i]] || typeof target[parts[i]] !== "object") { target[parts[i]] = {}; }
						target = target[parts[i]];
					}
					target[parts[parts.length - 1]] = row.translation;
				}
			} catch {
				// Table may not exist yet - start fresh
			}
			return current;
		})();

		const [current, translated] = await Promise.all([read_current, translate_json(untranslated, target_lang_name, { sourceLang: "English" })]);
		log_translation_result("English", target_lang_name, translated, untranslated);

		// Apply AI translations to current state, preserving already-translated keys
		const merged = apply_translations(current, translated);

		// 3. Write back to DB with consistent key ordering
		const final_obj = sort_object(merged);
		await write_flat_to_db(db, namespace, lang, final_obj);

		// 4. Notify server to reload in-memory translations (after DB write completes - ordering matters)
		await notify_server_reload(false);

		console.log(`✅ Translated ${num_keys} keys into ${target_lang_name} - ${display}`);

		async function write_flat_to_db(db: any, ns: string, lg: string, obj: any) {
			// Flatten the object
			const flat: [string, string][] = [];
			function flatten(o: any, prefix: string = "") {
				for (const key of Object.keys(o)) {
					const val = o[key];
					const path = prefix ? `${prefix}.${key}` : key;
					if (val && typeof val === "object" && !Array.isArray(val)) {
						flatten(val, path);
					} else if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
						flat.push([path, String(val)]);
					}
				}
			}
			flatten(obj);

			if (flat.length === 0) return;

			// Use a reserved connection to batch writes on a single connection
			// instead of N individual autocommit round-trips through the pool.
			const conn = await db.reserve();
			try {
				for (const [key_path, value] of flat) {
					try {
						await conn`DELETE FROM translations WHERE lang = ${lg} AND namespace = ${ns} AND key_path = ${key_path}`;
						await conn`INSERT INTO translations (lang, namespace, key_path, translation) VALUES (${lg}, ${ns}, ${key_path}, ${value})`;
					} catch {
						// Skip errors
					}
				}
			} finally {
				conn.release();
			}
		}
	},
	{ concurrency: 2 }
);

// Check if another worker is already running (before overwriting its PID)
if (await is_worker_alive()) { console.log("⚠️  [worker] Another worker PID detected - multiple instances may be running"); }

// Record our PID in Redis so the server dashboard can verify we're alive
await set_worker_heartbeat();

// Refresh the PID periodically as a safety net in case the key gets evicted
setInterval(() => set_worker_heartbeat(), 60_000);

console.log("🧑‍🏭 Queue worker ready. Waiting for jobs…");

// Graceful shutdown

process.on("SIGINT", () => {
	console.log("\n[worker] SIGINT received, shutting down…");
	process.exit(0);
});

process.on("SIGTERM", () => {
	console.log("[worker] SIGTERM received, shutting down…");
	process.exit(0);
});
