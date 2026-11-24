// queue/index.ts - job queue policy; storage is delegated to a QueueStore.
//
// The store is selected by config, mirroring the rate limiter and session
// store resolvers: Redis when it is available (REDIS_ENABLED=true and a real
// REDIS_URL), SQL otherwise. Policy - retry and max_attempts decisions,
// dead-letter routing, reaper timeout, worker loop and concurrency - lives
// here and is store-agnostic.

import { now_epoch_ms } from "$lib/temporal";
import { uuid_v7 } from "$lib/uuid";
import { redis_available } from "$config/env_vars";

import type { Job, JobHandler } from "./job";
import type { ClearResult, QueueStore } from "./store";
import { sql_store } from "./store_sql";
import { create_redis_store } from "./store_redis";

export type { Job };
export type { JobHandler };

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

// The resolved store lives on globalThis so a `bun --hot` re-evaluation reuses
// it instead of opening (and leaking) a second Redis connection per reload -
// the same reason the lifecycle state lives on globalThis.
declare global {
	var __queue_store: QueueStore | undefined;
}

// Defaults to the SQL store: the DB is always configured, so the queue is
// always available unless the developer opted into Redis and it is unreachable.
// Reuse the store a previous re-evaluation resolved, if any.
let store: QueueStore = globalThis.__queue_store ?? sql_store;

// Whether the queue is usable (always true for SQL; true for Redis only after
// a successful connection).
export function is_queue_available(): boolean { return store.available; }

// Whether the queue is currently backed by Redis (used to gate the TTL sweep).
export function is_queue_redis_backed(): boolean { return store.name === "redis"; }

function get_store(): QueueStore { return store; }

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the queue store.
 *
 * Uses Redis when it is available (`redis_available()`: REDIS_ENABLED=true
 * and a real REDIS_URL) and connects to verify connectivity; otherwise uses
 * the SQL-backed store, which is always available. If Redis is configured but
 * unreachable, logs a warning and keeps the store unavailable so callers can
 * fall back to direct execution (enqueue throws, the same contract as
 * before). An explicit `url` always re-resolves against Redis.
 */
export async function init_queue(url?: string): Promise<void> {
	// Idempotent across `bun --hot` re-evaluations (which call init_queue() with
	// no explicit url): reuse the already-resolved store instead of opening - and
	// leaking - a second connection. An explicit url always re-resolves.
	if (!url && globalThis.__queue_store) {
		store = globalThis.__queue_store;
		return;
	}

	const resolved_url = url || (redis_available() ? (Bun.env.REDIS_URL ?? "").trim() : null);

	// Re-resolving (explicit url override): close the previous store first so its
	// connection does not leak.
	if (globalThis.__queue_store) {
		await globalThis.__queue_store.close();
		globalThis.__queue_store = undefined;
	}

	if (!resolved_url) {
		// No Redis configured - the SQL store is the default and always available.
		store = sql_store;
	} else {
		store = await create_redis_store(resolved_url);
	}
	globalThis.__queue_store = store;
}

/**
 * Enqueue a job. Returns the generated job ID (UUID v7).
 */
export async function enqueue(params: {
	type: string;
	payload: any;
	queue?: string;
	max_attempts?: number;
	scheduled_for?: Temporal.Instant;
}): Promise<string> {
	if (!store.available) { throw new Error("Queue unavailable (Redis not connected)"); }
	const job_id = uuid_v7();
	const queue_name = params.queue || params.type || "default";
	const now = now_epoch_ms();

	const job: Job = {
		id: job_id,
		type: params.type,
		queue: queue_name,
		payload: params.payload,
		status: "pending",
		attempts: 0,
		max_attempts: params.max_attempts ?? 3,
		error_message: null,
		created_at: now,
		last_run_at: 0,
		scheduled_for: params.scheduled_for ? params.scheduled_for.epochMilliseconds : 0,
	};

	await store.insert(job);

	return job_id;
}

/**
 * Register a worker for one job type.
 *
 * Registration is declarative: the consume loops are spawned by
 * `start_workers()`. If the worker is already running, this type's fibers
 * start immediately. Re-registering the same type (a hot reload re-executes
 * worker.ts, which re-registers every handler) replaces the previous spec
 * rather than duplicating it.
 *
 * `handler` errors are caught, logged, and the job is retried or
 * dead-lettered per max_attempts - workers survive transient errors.
 */
export function start_worker(type: string, handler: JobHandler, options?: { queue?: string; concurrency?: number; poll_interval_ms?: number; }): void {
	if (!store.available) {
		console.warn(`[queue] Cannot start worker for "${type}": queue store unavailable`);
		return;
	}
	const spec: WorkerSpec = { type, handler, ...options };
	const existing = worker_specs.findIndex((item) => item.type === type);
	if (existing >= 0) worker_specs[existing] = spec;
	else worker_specs.push(spec);

	// Already running (e.g. start_worker called after start_workers) - spawn
	// this type's fibers against the live controller. A re-registration of a
	// type that already has fibers keeps those fibers (it replaces the spec
	// for the next start) instead of double-spawning.
	const lc = lifecycle();
	if (lc.state === "running" && lc.controller) {
		const queue_name = spec.queue || type;
		const already_consuming = (lc.fibers.get(queue_name)?.length ?? 0) > 0;
		if (!already_consuming) start_spec_fibers(spec, lc.controller.signal);
	}
}

/**
 * Start every registered worker. Idempotent: a second call while running is a
 * no-op, so a double invocation (e.g. a hot reload re-running worker.ts while
 * the previous instance is still active) cannot double-spawn fibers.
 */
export function start_workers(): void {
	const lc = lifecycle();
	if (lc.state === "running") return;
	if (!store.available) {
		console.warn("[queue] Cannot start workers: queue store unavailable");
		return;
	}
	lc.controller = new AbortController();
	lc.state = "running";
	for (const spec of worker_specs) start_spec_fibers(spec, lc.controller.signal);
}

/**
 * Stop every worker: abort the controller (loops stop claiming new jobs),
 * let in-flight handlers finish, then resolve. Bounded by `timeout_ms` - a
 * wedged handler must not block a deploy forever; on timeout the still-busy
 * queues are logged and we return anyway (the reaper recovers their jobs
 * later).
 */
export async function stop_workers(timeout_ms: number = 30_000): Promise<void> {
	const lc = lifecycle();
	if (lc.state === "stopped" || !lc.controller) return;
	// Capture the controller we are draining. A newer start_workers() may run
	// while this drain is awaiting (two rapid hot reloads interleaving); it
	// installs a fresh controller, and this finalization must not clobber it.
	const controller = lc.controller;
	lc.state = "draining";
	controller.abort();

	const busy = [...lc.fibers.values()].flat();
	if (busy.length > 0) {
		const settled = await Promise.race([
			Promise.allSettled(busy),
			new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeout_ms)),
		]);
		if (settled === "timeout") {
			// A wedged handler must not block a deploy forever. Drop the still-pending
			// fibers from tracking (their jobs are recovered by the reaper) so a later
			// start_workers() does not inherit a dead fiber; log which queues were busy.
			const busy_set = new Set(busy);
			const still_busy: string[] = [];
			for (const [queue, ps] of lc.fibers) {
				const remaining = ps.filter((p) => !busy_set.has(p));
				const dropped = ps.length - remaining.length;
				if (dropped > 0) {
					still_busy.push(`${queue} (${dropped})`);
					if (remaining.length === 0) lc.fibers.delete(queue);
					else lc.fibers.set(queue, remaining);
				}
			}
			console.warn(`[queue] Drain timeout after ${timeout_ms}ms - still busy: ${still_busy.join(", ")}`);
		}
	}
	// Finalize only if no newer start_workers() has taken over mid-drain.
	if (lc.controller === controller) {
		lc.state = "stopped";
		lc.controller = null;
	}
}

/** Current worker lifecycle state. */
export function worker_state(): "running" | "draining" | "stopped" {
	return lifecycle().state;
}

// ---------------------------------------------------------------------------
// Worker lifecycle internals
// ---------------------------------------------------------------------------
//
// The lifecycle (controller, state, fibers) lives on globalThis so it survives
// `bun --hot` re-evaluations: a reload re-executes worker.ts (and this module)
// while the previous consume loops are still running, and the new instance
// must be able to see - and drain - the old ones.

type WorkerSpec = {
	type: string;
	queue?: string;
	concurrency?: number;
	poll_interval_ms?: number;
	handler: JobHandler;
};

type LifecycleState = {
	controller: AbortController | null;
	state: "running" | "draining" | "stopped";
	/** consume-loop promises per queue, so stop_workers can await them and name busy queues. */
	fibers: Map<string, Promise<void>[]>;
};

declare global {
	var __queue_lifecycle: LifecycleState | undefined;
}

function lifecycle(): LifecycleState {
	if (!globalThis.__queue_lifecycle) {
		globalThis.__queue_lifecycle = { controller: null, state: "stopped", fibers: new Map() };
	}
	return globalThis.__queue_lifecycle;
}

// Registrations are module state: they are re-declared (and replaced by type)
// on every re-evaluation, so a hot reload picks up edited handlers.
const worker_specs: WorkerSpec[] = [];

function start_spec_fibers(spec: WorkerSpec, signal: AbortSignal): void {
	const queue_name = spec.queue || spec.type;
	const concurrency = spec.concurrency ?? 1;
	const poll_interval_ms = spec.poll_interval_ms ?? 500;
	const lc = lifecycle();

	console.log(`[queue] Starting worker: type=${spec.type} queue=${queue_name} concurrency=${concurrency}`);

	const queue_fibers = lc.fibers.get(queue_name) ?? [];
	lc.fibers.set(queue_name, queue_fibers);
	for (let i = 0; i < concurrency; i++) {
		const worker_id = `${spec.type}#${i + 1}`;
		const on_job = async (job: Job): Promise<void> => {
			console.log(`[queue] ${worker_id} took job ${job.id.slice(0, 8)} (${job.type})`);

			try {
				await spec.handler(job);
				await store.complete(job.id);
			} catch (handler_err) {
				job.attempts++;
				const error_msg = handler_err instanceof Error ? handler_err.message : String(handler_err);

				if (job.attempts < job.max_attempts) {
					// Retry - the store re-queues it
					await store.requeue(job, job.attempts, error_msg);
					console.log(`[queue] ${worker_id} job ${job.id} failed, retry ${job.attempts}/${job.max_attempts}: ${error_msg}`);
				} else {
					// Dead letter
					await store.fail(job, job.attempts, error_msg);
					console.error(`[queue] ${worker_id} job ${job.id} failed permanently: ${error_msg}`);
				}
			}
		};
		const fiber = store.consume(queue_name, on_job, { poll_interval_ms, signal });
		queue_fibers.push(fiber);
		fiber.finally(() => {
			const current = lc.fibers.get(queue_name);
			if (current) {
				const index = current.indexOf(fiber);
				if (index >= 0) current.splice(index, 1);
				if (current.length === 0) lc.fibers.delete(queue_name);
			}
		}).catch(() => {});
	}
}

// ---------------------------------------------------------------------------
// Orphan reaper
// ---------------------------------------------------------------------------

/**
 * Re-enqueue jobs that have been stuck in "running" status for longer than
 * `timeout_ms` (default 5 minutes).
 *
 * Call this once at worker startup to recover jobs that were orphaned by a
 * previous worker crash during processing.
 *
 * If the old handler crashes repeatedly, the reaper + retry logic will bring
 * the job back up to max_attempts before finally sending it to the dead-letter
 * failed state.
 */
/**
 * Jobs currently in "running" state, newest claim first.
 *
 * The dashboard reports pending and failed only, so a job orphaned mid-handler
 * (claimed, then its worker died) is invisible there: it is no longer pending
 * and not yet failed. Surfacing running jobs makes that state observable
 * instead of looking like an empty queue.
 */
export async function get_running_jobs(): Promise<Job[]> {
	if (!store.available) return [];
	// stale_running(before) returns running jobs whose last_run_at < before;
	// "now" therefore matches every running job.
	const running = await store.stale_running(now_epoch_ms());
	return running.sort((left, right) => right.last_run_at - left.last_run_at);
}

export async function reap_orphans(timeout_ms: number = 300_000): Promise<number> {
	if (!store.available) return 0;
	const before = now_epoch_ms() - timeout_ms;
	const orphans = await store.stale_running(before);

	let reaped = 0;
	for (const job of orphans) {
		try {
			// Bump attempts so it won't loop forever if the handler keeps crashing
			job.attempts++;
			const prior_error = job.error_message ? `; prior: ${job.error_message}` : "";
			job.error_message = `Re-enqueued by reaper after ${now_epoch_ms() - job.last_run_at}ms in running state${prior_error}`;

			await store.requeue(job, job.attempts, job.error_message);

			console.log(`[queue] Reaper re-enqueued job ${job.id} (${job.type}), attempt ${job.attempts}/${job.max_attempts}`);
			reaped++;
		} catch (err) {
			console.error(`[queue] Reaper error processing job ${job.id}:`, err instanceof Error ? err.message : String(err));
		}
	}

	return reaped;
}

// ---------------------------------------------------------------------------
// Utilities (admin UI, testing)
// ---------------------------------------------------------------------------

// Fetch a single job's metadata by id.
export async function get_job(job_id: string): Promise<Job | null> {
	return get_store().get(job_id);
}

// List failed job ids for a given queue (newest first).
export async function get_failed_job_ids(queue: string = "default", limit: number = 100): Promise<string[]> {
	return get_store().failed_ids(queue, limit);
}

// List pending job IDs for a given queue (newest first).
export async function get_pending_job_ids(queue: string = "default", limit: number = 100): Promise<string[]> {
	return get_store().pending_ids(queue, limit);
}

// Count of pending jobs in a queue.
export async function queue_length(queue: string = "default"): Promise<number> {
	return get_store().length(queue);
}

/**
 * Retry a failed job - resets its status to "pending" so a worker picks it up
 * again. Returns false when the job doesn't exist (or isn't retryable).
 */
export async function retry_job(job_id: string): Promise<boolean> {
	const job = await get_store().get(job_id);
	if (!job) return false;

	const error_message = `Retried manually (was: ${job.error_message ?? ""})`;
	const ok = await get_store().retry(job_id, error_message);

	console.log(`[queue] Retrying job ${job_id} (${job.type})`);
	return ok;
}

/**
 * Delete a job entirely (any status - failed, pending, running, completed).
 * Returns false when the job doesn't exist. Used by the admin UI to drop
 * failed (or otherwise stuck) jobs that can't be retried.
 */
export async function delete_job(job_id: string): Promise<boolean> {
	const job = await get_store().get(job_id);
	if (!job) return false;

	const ok = await get_store().remove(job_id);
	console.log(`[queue] Deleted job ${job_id} (${job.type})`);
	return ok;
}

/**
 * Discover active queue names from the store. Empty stores fall back to the
 * template's canonical queues so the admin UI always has something to show.
 */
export async function scan_queue_names(): Promise<string[]> {
	const names = await get_store().queue_names();
	if (names.length === 0) { return ["send_email", "default"]; }
	return names;
}

// ---------------------------------------------------------------------------
// Queue clearing
// ---------------------------------------------------------------------------

export async function clear_queue_pending(queue: string): Promise<number> {
	if (!store.available) return 0;
	return get_store().clear_pending(queue);
}

export async function clear_queue_failed(queue: string): Promise<number> {
	if (!store.available) return 0;
	return get_store().clear_failed(queue);
}

export async function clear_queue_delayed(queue: string): Promise<number> {
	if (!store.available) return 0;
	return get_store().clear_delayed(queue);
}

export async function clear_queue_all(queue: string): Promise<ClearResult> {
	if (!store.available) return { pending: 0, failed: 0, delayed: 0, running: 0 };
	return get_store().clear_queue_all(queue);
}

export async function clear_all_queues(): Promise<{ queues: number } & ClearResult> {
	if (!store.available) return { queues: 0, pending: 0, failed: 0, delayed: 0, running: 0 };
	return get_store().clear_all_queues();
}

// ---------------------------------------------------------------------------
// Worker PID heartbeat
// ---------------------------------------------------------------------------

/**
 * Record the worker's PID and lifecycle state in the store. Called once on
 * startup (and periodically as a safety net in case the key is evicted), so
 * the admin UI can distinguish running / draining / stopped / dead.
 */
export async function set_worker_heartbeat(): Promise<void> {
	if (!store.available) return;
	await get_store().set_heartbeat(process.pid, lifecycle().state);
}

/** The lifecycle state the last heartbeat recorded, or null when never set. */
export async function get_worker_state(): Promise<string | null> {
	if (!store.available) return null;
	return get_store().get_heartbeat_state();
}

// ---------------------------------------------------------------------------
// Operator pause
// ---------------------------------------------------------------------------

/**
 * Pause or resume the worker: a paused worker polls without claiming jobs.
 * The flag lives in the store (not process memory) because the server and
 * worker are separate processes - the admin UI sets it, and it survives a
 * worker restart, which is what an operator wants when they paused because a
 * downstream service is down.
 */
export async function set_worker_paused(paused: boolean): Promise<void> {
	if (!store.available) return;
	await get_store().set_paused(paused);
}

export async function is_worker_paused(): Promise<boolean> {
	if (!store.available) return false;
	return get_store().is_paused();
}

/**
 * Check whether a worker process is currently alive by reading its PID from
 * the store and verifying the process is still running via `kill -0`.
 *
 * Returns false if the store is unavailable, no PID is stored, or the PID
 * doesn't correspond to a running process. The PID check is only meaningful
 * when worker and server share a host - already true for Redis in practice,
 * and unconditionally true for the SQL store.
 */
export async function is_worker_alive(): Promise<boolean> {
	if (!store.available) return false;
	const pid = await get_store().get_heartbeat();
	if (pid === null || !Number.isFinite(pid) || pid <= 0) return false;

	// Verify the process is actually running (signal 0 = existence check, no signal sent)
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Sweep jobs past their 24 h expiry. Only meaningful for the SQL store
 * (Redis expires hashes natively) - the bootstrap gates the sweep on
 * is_queue_redis_backed().
 */
export async function cleanup_expired_jobs(): Promise<number> {
	if (!store.available) return 0;
	return get_store().cleanup_expired();
}

// Close the store connection (for graceful shutdown).
export async function close_queue(): Promise<void> {
	await get_store().close();
	globalThis.__queue_store = undefined;
}
