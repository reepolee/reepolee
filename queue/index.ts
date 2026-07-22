// queue/index.ts - Redis-backed job queue using Bun.RedisClient
//
// Redis data layout:
// job:{id}                     HASH    - full job metadata (24h TTL)
// queue:{name}                 LIST    - pending job IDs
// queue:{name}:delayed         ZSET    - scheduled job IDs (score = timestamp ms)
// queue:{name}:failed          ZSET    - permanently failed job IDs (score = timestamp ms)
// queue:running                SET     - job IDs currently being processed (for orphan reaping)

import { now_epoch_ms } from "$lib/temporal";
import { uuid_v7 } from "$lib/uuid";
import { RedisClient } from "bun";

import {
	clear_all_queues as _clear_all_queues,
	clear_queue_all as _clear_queue_all,
	clear_queue_delayed as _clear_queue_delayed,
	clear_queue_failed as _clear_queue_failed,
	clear_queue_pending as _clear_queue_pending,
} from "./clearing";
import { hget_job, hset_job, hset_job_fields, type Job } from "./job";

export type { Job };
export type JobHandler = (job: Job) => Promise<void>;

// Thin wrappers that inject redis + availability from module state

export async function clear_queue_pending(queue: string): Promise<number> {
	if (!queue_available) return 0;
	return _clear_queue_pending(get_redis(), queue);
}

export async function clear_queue_failed(queue: string): Promise<number> {
	if (!queue_available) return 0;
	return _clear_queue_failed(get_redis(), queue);
}

export async function clear_queue_delayed(queue: string): Promise<number> {
	if (!queue_available) return 0;
	return _clear_queue_delayed(get_redis(), queue);
}

export async function clear_queue_all(queue: string): Promise<{ pending: number; failed: number; delayed: number; running: number; }> {
	if (!queue_available) return { pending: 0, failed: 0, delayed: 0, running: 0 };
	return _clear_queue_all(get_redis(), queue, queue_available);
}

export async function clear_all_queues(): Promise<{
	queues: number;
	pending: number;
	failed: number;
	delayed: number;
	running: number;
}> {
	if (!queue_available) return { queues: 0, pending: 0, failed: 0, delayed: 0, running: 0 };
	return _clear_all_queues(get_redis(), queue_available, scan_queue_names);
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let redis: any = null;
let queue_available = false;
let redis_url: string | null = null;

// Whether the Redis-backed queue is available.
export function is_queue_available(): boolean { return queue_available; }

function get_redis(): any { return redis; }

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Connect to Redis and verify connectivity.
 * Must be called once before any other queue operations.
 * Reads REDIS_URL env var. If REDIS_URL is not set, skips Redis entirely
 * and all queue functions return sensible defaults (empty arrays, zero counts).
 *
 * If Redis is not available, logs a warning and continues - the queue
 * functions will return sensible defaults (empty arrays, zero counts)
 * and enqueue will throw so callers can fall back to direct execution.
 */
export async function init_queue(url?: string): Promise<void> {
	const resolved_url = url || Bun.env.REDIS_URL || null;

	if (!resolved_url) {
		console.error("\u001b[31m[queue] REDIS_URL not set - queue features disabled\u001b[0m");
		console.error("\u001b[31m[queue] Email will be sent directly via SMTP instead of queued.\u001b[0m");
		queue_available = false;
		return;
	}

	redis_url = resolved_url;
	console.log(`[queue] Connecting to Redis: ${resolved_url}`);

	try {
		redis = new RedisClient(redis_url);

		// Bun's RedisClient connects lazily - send PING to verify connectivity with timeout
		await Promise.race([redis.ping(), new Promise((_, reject) => setTimeout(() => reject(new Error("Connection timeout after 3s")), 3000))]);

		queue_available = true;
		console.log("[queue] Redis connected successfully");
	} catch (err) {
		console.warn(`[queue] Redis not available - queue features disabled: ${err instanceof Error ? err.message : String(err)}`);
		console.warn("[queue] Email will be sent directly via SMTP instead of queued.");
		queue_available = false;
	}
}

export async function enqueue(params: {
	type: string;
	payload: any;
	queue?: string;
	max_attempts?: number;
	scheduled_for?: Temporal.Instant;
}): Promise<string> {
	if (!queue_available) { throw new Error("Queue unavailable (Redis not connected)"); }
	const r = get_redis();
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

	// Store full job metadata as a Redis hash, auto-expire after 24h
	await hset_job(r, job_id, job);
	await r.expire(`job:${job_id}`, 86400);

	// Route to the appropriate queue data structure
	if (job.scheduled_for > 0) {
		// Delayed job - sorted set, score = target timestamp
		await r.zadd(`queue:${queue_name}:delayed`, job.scheduled_for, job_id);
	} else {
		// Immediate job - push onto the list
		await r.lpush(`queue:${queue_name}`, job_id);
	}

	return job_id;
}

/**
 * Start a background worker loop.
 *
 * Spawns `concurrency` concurrent fibres that block on BRPOP waiting for
 * jobs of the given type.  Each dequeued job is passed to `handler`.
 *
 * Workers run forever and survive transient errors internally.
 */
export function start_worker(type: string, handler: JobHandler, options?: { queue?: string; concurrency?: number; }): void {
	if (!queue_available) {
		console.warn(`[queue] Cannot start worker for "${type}": Redis not available`);
		return;
	}
	const queue_name = options?.queue || type;
	const concurrency = options?.concurrency ?? 1;
	const base_url = redis_url || Bun.env.REDIS_URL || "redis://localhost:6379";

	console.log(`[queue] Starting worker: type=${type} queue=${queue_name} concurrency=${concurrency}`);

	for (let i = 0; i < concurrency; i++) {
		const worker_id = `${type}#${i + 1}`;
		// Each fiber needs its own Redis connection - BRPOP blocks the connection
		// until data arrives, so sharing a single connection across fibers would
		// prevent all but the first BRPOP from ever reaching Redis.
		const wr = new RedisClient(base_url);
		(async function loop () {
			while (true) {
				try {
					// BRPOP blocks until a job is available (timeout 0 = forever).
					// Returns [queue_name, job_id] or null on timeout.
					const result = await wr.brpop(`queue:${queue_name}`, 0);
					if (!result) continue;

					// result is an array like ["queue:send_email", "uuid-here"]
					const job_id: string = result[1];

					// Fetch full job metadata from the hash and deserialise it
					const job = await hget_job(wr, job_id);
					if (!job) continue;

					console.log(`[queue] ${worker_id} took job ${job_id.slice(0, 8)} (${job.type})`);

					// Mark as running - track the job so the reaper can find orphans
					const now = now_epoch_ms();
					job.status = "running";
					job.last_run_at = now;
					await hset_job_fields(wr, job_id, { status: "running", last_run_at: String(now) });
					await wr.sadd("queue:running", job_id);

					// Execute the user's handler
					try {
						await handler(job);
						job.status = "completed";
						await hset_job_fields(wr, job_id, { status: "completed" });
						await wr.srem("queue:running", job_id);
						// TTL will clean up the hash eventually
					} catch (handler_err) {
						job.attempts++;
						const error_msg = handler_err instanceof Error ? handler_err.message : String(handler_err);

						if (job.attempts < job.max_attempts) {
							// Retry - push back to the queue
							job.status = "pending";
							await hset_job_fields(wr, job_id, {
								status: "pending",
								attempts: String(job.attempts),
								error_message: error_msg,
							});
							await wr.srem("queue:running", job_id);
							await wr.lpush(`queue:${queue_name}`, job_id);
							console.log(`[queue] ${worker_id} job ${job_id} failed, retry ${job.attempts}/${job.max_attempts}: ${error_msg}`);
						} else {
							// Dead letter - move to failed set
							job.status = "failed";
							await hset_job_fields(wr, job_id, { status: "failed", error_message: error_msg });
							await wr.srem("queue:running", job_id);
							await wr.zadd(`queue:${queue_name}:failed`, now_epoch_ms(), job_id);
							console.error(`[queue] ${worker_id} job ${job_id} failed permanently: ${error_msg}`);
						}
					}
				} catch (loop_err) {
					// Top-level safety net - never crash the loop
					console.error(`[queue] ${worker_id} unexpected error:`, loop_err instanceof Error ? loop_err.message : String(loop_err));
					await new Promise((resolve) => setTimeout(resolve, 1000));
				}
			}
		})();
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
 * failed set.
 */
export async function reap_orphans(timeout_ms: number = 300_000): Promise<number> {
	if (!queue_available) return 0;
	const r = get_redis();
	const running_raw = await r.smembers("queue:running");
	const running_ids: string[] = running_raw ?? [];
	if (running_ids.length === 0) return 0;

	const now = now_epoch_ms();
	let reaped = 0;

	for (const job_id of running_ids) {
		try {
			const job = await hget_job(r, job_id);
			if (!job) {
				// Hash expired or was cleaned up - remove stale tracking entry
				await r.srem("queue:running", job_id);
				continue;
			}

			if (job.status !== "running") {
				// Status changed since we last read; clean up tracking
				await r.srem("queue:running", job_id);
				continue;
			}

			const elapsed = now - job.last_run_at;
			if (elapsed < timeout_ms) {
				// Still within grace period - leave it alone
				continue;
			}

			// Orphan found - re-enqueue
			const queue_name = job.queue || job.type || "default";

			// Bump attempts so it won't loop forever if the handler keeps crashing
			job.attempts++;
			job.status = "pending";
			const prior_error = job.error_message ? `; prior: ${job.error_message}` : "";
			job.error_message = `Re-enqueued by reaper after ${elapsed}ms in running state${prior_error}`;

			await hset_job_fields(r, job_id, {
				status: "pending",
				attempts: String(job.attempts),
				error_message: job.error_message,
			});
			await r.srem("queue:running", job_id);
			await r.lpush(`queue:${queue_name}`, job_id);

			console.log(`[queue] Reaper re-enqueued job ${job_id} (${job.type}), attempt ${job.attempts}/${job.max_attempts}`);
			reaped++;
		} catch (err) {
			console.error(`[queue] Reaper error processing job ${job_id}:`, err instanceof Error ? err.message : String(err));
		}
	}

	return reaped;
}

// ---------------------------------------------------------------------------
// Utilities (for future admin UI, testing)
// ---------------------------------------------------------------------------

// Fetch a single job's metadata by id.
export async function get_job(job_id: string): Promise<Job | null> {
	if (!queue_available) return null;
	const r = get_redis();
	return await hget_job(r, job_id);
}

// List failed job ids for a given queue (newest first).
export async function get_failed_job_ids(queue: string = "default", limit: number = 100): Promise<string[]> {
	if (!queue_available) return [];
	const r = get_redis();
	const failed_raw = await r.zrange(`queue:${queue}:failed`, 0, limit - 1);
	// zrange without withScores returns just the member strings, no scores.
	return failed_raw ?? [];
}

// List pending job IDs for a given queue (newest first).
export async function get_pending_job_ids(queue: string = "default", limit: number = 100): Promise<string[]> {
	if (!queue_available) return [];
	const r = get_redis();
	const ids_raw: string[] | null = await r.lrange(`queue:${queue}`, 0, limit - 1);
	return ids_raw ?? [];
}

// Count of pending jobs in a queue.
export async function queue_length(queue: string = "default"): Promise<number> {
	if (!queue_available) return 0;
	const r = get_redis();
	return await r.llen(`queue:${queue}`);
}

/**
 * Retry a failed job - resets its status to "pending" and pushes it back
 * onto its queue so a worker picks it up again.
 */
export async function retry_job(job_id: string): Promise<boolean> {
	if (!queue_available) return false;
	const r = get_redis();
	const job = await hget_job(r, job_id);
	if (!job) return false;

	const queue_name = job.queue || job.type || "default";

	job.attempts = 0;
	job.status = "pending";
	job.error_message = `Retried manually (was: ${job.error_message ?? ""})`;

	// Remove from failed set
	await r.zrem(`queue:${queue_name}:failed`, job_id);

	// Update hash and push back to its queue
	await hset_job_fields(r, job_id, {
		status: "pending",
		attempts: "0",
		error_message: job.error_message,
	});
	await r.lpush(`queue:${queue_name}`, job_id);

	console.log(`[queue] Retrying job ${job_id} (${job.type})`);
	return true;
}

/**
 * Discover active queue names by scanning for keys matching `queue:*`
 * that don't have a sub-key suffix (e.g. `queue:send_email` but not
 * `queue:send_email:failed`).
 *
 * Bun.RedisClient scan() takes positional string/buffer arguments:
 * scan(cursor, "MATCH", pattern, "COUNT", count): Promise<[string, string[]]>
 * The cursor returned is a string, so comparisons must use string "0".
 */
export async function scan_queue_names(): Promise<string[]> {
	if (!queue_available) return [];
	const r = get_redis();
	const names = new Set();
	let cursor = "0";

	do {
		const result: [string, string[]] = await r.scan(cursor, "MATCH", "queue:*", "COUNT", 100);
		cursor = result[0];
		const keys = result[1] ?? [];
		for (const key of keys) {
			const name = key.replace(/^queue:/, "");
			// Only include top-level queue names (no colon in the remainder),
			// exclude the special "running" SET which is not a queue list
			if (!name.includes(":") && name !== "running") { names.add(name); }
		}
	} while (cursor !== "0");

	const sorted = Array.from(names).sort();
	// Fallback if SCAN found nothing
	if (sorted.length === 0) { sorted.push("send_email", "default"); }
	return sorted;
}

// ---------------------------------------------------------------------------
// Worker PID heartbeat
// ---------------------------------------------------------------------------

const PID_KEY = "queue:worker:pid";

/**
 * Record the worker's PID in Redis.
 * Called once on startup (and periodically as a safety net in case the key
 * is evicted).
 */
export async function set_worker_heartbeat(): Promise<void> {
	if (!queue_available) return;
	const r = get_redis();
	await r.set(PID_KEY, String(process.pid));
}

/**
 * Check whether a worker process is currently alive by reading its PID from
 * Redis and verifying the process is still running via `kill -0`.
 *
 * This is instant - no TTL window to wait through after the worker dies.
 * Returns false if Redis is unavailable, no PID is stored, or the PID
 * doesn't correspond to a running process.
 */
export async function is_worker_alive(): Promise<boolean> {
	if (!queue_available) return false;
	const r = get_redis();
	const pid_str: string | null = await r.get(PID_KEY);
	if (!pid_str) return false;

	const pid = Number(pid_str);
	if (!Number.isFinite(pid) || pid <= 0) return false;

	// Verify the process is actually running (signal 0 = existence check, no signal sent)
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// Remove the Redis connection (for graceful shutdown).
export async function close_queue(): Promise<void> {
	if (!queue_available) return;
	const r = get_redis();
	await r.close();
	redis = null;
	queue_available = false;
}
