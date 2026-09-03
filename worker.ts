// worker.ts - Standalone queue worker process
//
// Runs outside the main HTTP server so it can be restarted independently.
// Processes enqueued jobs against the configured queue store (Redis when it
// is enabled - REDIS_ENABLED=true and a real REDIS_URL - the SQL database
// otherwise).
//
// Usage:
// bun run worker.ts              # production
// bun --hot worker.ts            # development (auto-restart on file changes)

import { locale_names } from "$config/supported_locales";
import { derive_image_variants } from "$lib/image_processor/variants";
import { generate_localized_values } from "$lib/localized_copy";
import { invalidate_all_locales } from "$lib/locale_write";
import { notify_server_reload } from "$lib/server_notify";
import { send_mail } from "$lib/smtp";
import { read_namespace_file, write_namespace_file } from "$lib/translation_files";
import { apply_translations, count_leaves, log_translation_result, sort_object } from "$lib/translation_merge";
import {
	close_queue,
	get_failed_job_ids,
	init_queue,
	is_queue_available,
	is_worker_alive,
	queue_length,
	reap_orphans,
	scan_queue_names,
	set_worker_heartbeat,
	start_worker,
	start_workers,
	stop_workers,
	worker_state,
	type JobHandler,
} from "$queue/index";

import { translate_json } from "./generator/translator";

import { reeqa_workers } from "$reeqa/workers";

// The heartbeat interval, signal handlers, and instance generation are tracked
// on globalThis so a `bun --hot` re-evaluation can clear/replace the previous
// instance's state instead of leaking timers and process listeners per reload
// (the queue lifecycle uses the same globalThis trick).
declare global {
	var __worker_heartbeat: ReturnType<typeof setInterval> | undefined;
	var __worker_reaper: ReturnType<typeof setInterval> | undefined;
	var __worker_signal_handlers: Array<{ signal: string; handler: () => void }> | undefined;
	var __worker_instance: number | undefined;
}

// A `bun --hot` re-evaluation re-runs this module top-to-bottom, and
// process.on() accumulates listeners - remove any the previous instance
// registered before registering this instance's own. (No-op on first boot.)
for (const { signal, handler } of globalThis.__worker_signal_handlers ?? []) {
	process.off(signal, handler);
}
globalThis.__worker_signal_handlers = undefined;

// Bump the instance generation so a shutdown() that began under a previous
// instance cannot close the shared queue store or exit after a newer instance
// has taken over.
const instance = (globalThis.__worker_instance ?? 0) + 1;
globalThis.__worker_instance = instance;

// Graceful shutdown: stop claiming new jobs, let in-flight handlers finish,
// then exit. A second signal mid-drain hard-exits (an operator pressing
// Ctrl-C twice means "now"). Registered up front so there is no window (first
// boot or a reload's drain) in which a signal would bypass the drain.
let shutting_down = false;

async function shutdown(sig: string): Promise<void> {
	if (shutting_down) {
		console.error(`[worker] ${sig} received again - forcing exit.`);
		process.exit(1);
	}
	shutting_down = true;
	console.log(`[worker] ${sig} received, draining…`);
	if (globalThis.__worker_heartbeat) {
		clearInterval(globalThis.__worker_heartbeat);
		globalThis.__worker_heartbeat = undefined;
	}
	if (globalThis.__worker_reaper) {
		clearInterval(globalThis.__worker_reaper);
		globalThis.__worker_reaper = undefined;
	}
	await stop_workers();
	// A hot reload may have started a newer instance while we drained; it owns
	// the process (and the shared queue store), so stop here without closing or
	// exiting under it.
	if (globalThis.__worker_instance !== instance) {
		console.log("[worker] Newer worker instance is running - not exiting.");
		return;
	}
	await close_queue();
	console.log("[worker] Drained, exiting.");
	process.exit(0);
}

const sigint_handler = () => { void shutdown("SIGINT"); };
const sigterm_handler = () => { void shutdown("SIGTERM"); };
process.on("SIGINT", sigint_handler);
process.on("SIGTERM", sigterm_handler);
globalThis.__worker_signal_handlers = [
	{ signal: "SIGINT", handler: sigint_handler },
	{ signal: "SIGTERM", handler: sigterm_handler },
];

// Bootstrap

await init_queue();

// `bun --hot` re-executes this module while the previous consume loops may
// still be running. The lifecycle state survives on globalThis, so a
// re-evaluation sees the previous instance and drains it before registering
// and starting fresh - one set of fibers, never two.
if (worker_state() !== "stopped") {
	console.log("[worker] Previous worker instance detected - draining…");
	if (globalThis.__worker_heartbeat) {
		clearInterval(globalThis.__worker_heartbeat);
		globalThis.__worker_heartbeat = undefined;
	}
	if (globalThis.__worker_reaper) {
		clearInterval(globalThis.__worker_reaper);
		globalThis.__worker_reaper = undefined;
	}
	await stop_workers();
}

if (!is_queue_available()) {
	console.log("🧑‍🏭 Queue worker not started - queue store unavailable. Emails are sent directly via SMTP from the server.");
	process.exit(0);
}

// How often to sweep for orphaned jobs. Shorter than reap_orphans()'s own
// 5-minute staleness floor, so a job becomes eligible and is picked up on the
// next sweep rather than waiting for a worker restart.
const REAPER_SWEEP_MS = 60_000;

// Recover any jobs orphaned by a previous worker crash before starting fresh
const reaped = await reap_orphans();
if (reaped > 0) { console.log(`[worker] Re-enqueued ${reaped} orphaned job(s) from previous lifecycle`); }

// Show pending jobs in each queue (BEFORE starting worker loops)

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

// ---------------------------------------------------------------------------
// Worker registrations
// ---------------------------------------------------------------------------
//
// Handlers are declared next to their resource in `<app>/<resource>/workers.ts`
// (see .agents/PLAN_worker_registration.md); resource-scoped modules are spread
// into `registrations` below. Core, non-resource handlers live here in
// `core_workers`. A handler file must never import its sibling `index.ts` - the
// worker process must not pull in the server's render/i18n/CRUD dependency chain.

type WorkerRegistration = {
	type: string;
	queue?: string;
	concurrency?: number;
	handler: JobHandler;
};

const core_workers: WorkerRegistration[] = [
	{
		// Sends emails enqueued by the invite flow and any future email producers.
		type: "send_email",
		concurrency: 1,
		handler: async (job) => {
			const { to, cc, bcc, subject, body, html } = job.payload;
			await send_mail({ to, cc, bcc, subject, body, html: html || body });
		},
	},
	{
		// AI-generates first-draft translations of one record's localized fields.
		// Enqueued by generated CRUD routes (`.../generate-locale`). The result
		// carries copy provenance, so stale-copy notices work exactly as for a
		// manual copy.
		type: "translate_record",
		concurrency: 2,
		handler: async (job) => {
			const { table_name, record_id, field_names, from_locale, to_locale } = job.payload;
			const generated = await generate_localized_values(table_name, record_id, field_names, from_locale, to_locale);
			await invalidate_all_locales(table_name);
			console.log(`✅ Generated ${generated} translation(s) for ${table_name} #${record_id} (${from_locale} → ${to_locale})`);
		},
	},
	{
		// Derives an uploaded image's variant set (thumbnail + responsive WebP
		// re-encodes) from its stored primary. Enqueued by the image upload
		// pipeline after the primary is stored, so uploads return without the
		// derivation work on the request path.
		type: "image_variants",
		concurrency: 2,
		handler: async (job) => {
			const { storage_key, format, source_width } = job.payload;
			const variants = await derive_image_variants(storage_key, format, source_width);
			console.log(`✅ Derived ${variants.length} variant(s) for ${storage_key}: ${variants.join(", ")}`);
		},
	},
	{
		// Translates untranslated keys for one language in one namespace. Enqueued
		// by `bun reeman sync-translations --translate`.
		type: "translate_batch",
		concurrency: 2,
		handler: async (job) => {
			const { namespace, locale, untranslated } = job.payload;

			const display = namespace || "(global)";
			console.log(`📄 Translating: ${display} / ${locale}`);

			// Read current translations + call AI translation in parallel
			const target_lang_name = locale_names[locale] ?? locale;
			const num_keys = count_leaves(untranslated);
			console.log(`🌍 Translating English → ${target_lang_name} (${num_keys} keys)...`);

			const read_current = read_namespace_file(namespace, locale);

			const [current, translated] = await Promise.all([read_current, translate_json(untranslated, target_lang_name, { source_lang: "English" })]);
			log_translation_result("English", target_lang_name, translated, untranslated);

			// Apply AI translations to current state, preserving already-translated keys
			const merged = apply_translations(current, translated);

			// Write back to the locale file with consistent key ordering
			const final_obj = sort_object(merged);
			await write_namespace_file(namespace, locale, final_obj);

			// Notify the main app after the file write completes. The worker shares a
			// checkout with the main app in dev, but across a split deployment it is
			// a separate process - pass MAIN_APP_URL explicitly (falls back to
			// SERVER_NAME:PORT when unset) so the freshly-written locale files reach
			// the running main app.
			await notify_server_reload(false, Bun.env.MAIN_APP_URL);

			console.log(`✅ Translated ${num_keys} keys into ${target_lang_name} - ${display}`);
		},
	},
];

const registrations: WorkerRegistration[] = [...core_workers, ...reeqa_workers];

// Register every handler with the queue engine.
for (const reg of registrations) {
	start_worker(reg.type, reg.handler, { concurrency: reg.concurrency ?? 1 });
}

// Startup assertion: warn on any queue that has pending jobs but no registered
// handler. The `type` string is the only contract between enqueue() and the
// handler, and a typo would otherwise leave jobs pending forever with no error
// reported anywhere.
console.log(`[worker] Registered: ${registrations.map((reg) => reg.type).join(", ")}`);
{
	const registered_queues = new Set(registrations.map((reg) => reg.queue ?? reg.type));
	const unhandled: { queue: string; count: number; }[] = [];
	for (const name of await scan_queue_names()) {
		const count = await queue_length(name);
		if (count > 0 && !registered_queues.has(name)) unhandled.push({ queue: name, count });
	}
	for (const { queue, count } of unhandled) {
		console.warn(`[worker] WARNING: queue "${queue}" has ${count} pending jobs and no handler`);
	}
}

// Start the consume loops for every registered handler.
await start_workers();

// Check if another worker is already running (before overwriting its PID)
if (await is_worker_alive()) { console.log("⚠️  [worker] Another worker PID detected - multiple instances may be running"); }

// Record our PID in the queue store so the server dashboard can verify we're alive
await set_worker_heartbeat();

// Refresh the PID periodically as a safety net in case the key gets evicted
globalThis.__worker_heartbeat = setInterval(() => set_worker_heartbeat(), 60_000);

// Reap orphans on a timer, not only at startup. A worker that is killed while a
// handler is in flight leaves its job in "running" forever: the claim query only
// selects "pending", so no other worker will ever pick it up. Recovering only at
// startup means a long-lived production worker never recovers those jobs at all,
// and a dev worker recovers them only if it happens to restart more than
// REAPER_TIMEOUT_MS after the crash - which is why an orphaned translation would
// sometimes appear after a restart and sometimes never.
globalThis.__worker_reaper = setInterval(async () => {
	try {
		const periodic_reaped = await reap_orphans();
		if (periodic_reaped > 0) { console.log(`[worker] Reaper re-enqueued ${periodic_reaped} orphaned job(s)`); }
	} catch (err) {
		console.error("[worker] Reaper sweep failed:", err instanceof Error ? err.message : String(err));
	}
}, REAPER_SWEEP_MS);

console.log("🧑‍🏭 Queue worker ready. Waiting for jobs…");
