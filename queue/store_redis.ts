/**
 * Redis-backed queue store.
 *
 * Keeps the Redis data layout and BRPOP worker loop exactly as they were
 * before the SQL store existed, so existing Redis deployments see no change:
 *
 *   job:{id}                    HASH    - full job metadata (24 h TTL)
 *   queue:{name}                LIST    - pending job IDs
 *   queue:{name}:delayed        ZSET    - scheduled job IDs (score = target ms)
 *   queue:{name}:failed         ZSET    - permanently failed job IDs
 *   queue:running               SET     - in-flight IDs, for orphan reaping
 */
import { now_epoch_ms } from "$lib/temporal";
import { RedisClient } from "bun";

import type { Job } from "./job";
import type { QueueStore } from "./store";

// ---------------------------------------------------------------------------
// Job hash serialisation (Redis stores everything as strings)
// ---------------------------------------------------------------------------

function job_to_hash(job: Job): Record<string, string> {
	return {
		id: job.id,
		type: job.type,
		queue: job.queue,
		payload: JSON.stringify(job.payload),
		status: job.status,
		attempts: String(job.attempts),
		max_attempts: String(job.max_attempts),
		error_message: job.error_message ?? "",
		created_at: String(job.created_at),
		last_run_at: String(job.last_run_at),
		scheduled_for: String(job.scheduled_for),
	};
}

function hash_to_job(hash: Record<string, string>): Job {
	return {
		id: hash.id!,
		type: hash.type!,
		queue: hash.queue!,
		payload: hash.payload ? JSON.parse(hash.payload) : {},
		status: (hash.status as Job["status"]) ?? "pending",
		attempts: Number(hash.attempts ?? 0),
		max_attempts: Number(hash.max_attempts ?? 3),
		error_message: hash.error_message || null,
		created_at: Number(hash.created_at ?? 0),
		last_run_at: Number(hash.last_run_at ?? 0),
		scheduled_for: Number(hash.scheduled_for ?? 0),
	};
}

async function hset_job(r: any, job_id: string, job: Job): Promise<void> {
	await r.hset(`job:${job_id}`, job_to_hash(job));
}

async function hset_job_fields(r: any, job_id: string, fields: Record<string, string>): Promise<void> {
	await r.hset(`job:${job_id}`, fields);
}

async function hget_job(r: any, job_id: string): Promise<Job | null> {
	const raw: Record<string, string> | null = await r.hgetall(`job:${job_id}`);
	if (!raw || Object.keys(raw).length === 0) return null;
	return hash_to_job(raw);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Abortable sleep: resolves immediately when the signal fires. Redis workers
 * use a bounded BRPOP timeout and loop so they re-check the signal each
 * second; the sleep is used only on the error path.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
	});
}

/**
 * Connect to Redis and verify connectivity (PING with a 3 s timeout).
 * Returns an unavailable store (all methods no-op / empty) when the
 * connection fails, so the caller can fall back to direct execution.
 */
export async function create_redis_store(url: string): Promise<QueueStore> {
	let redis: RedisClient | null = null;
	let available = false;

	console.log(`[queue] Connecting to Redis: ${url}`);
	try {
		const client = new RedisClient(url);
		await Promise.race([client.ping(), new Promise((_, reject) => setTimeout(() => reject(new Error("Connection timeout after 3s")), 3000))]);
		redis = client;
		available = true;
		console.log("[queue] Redis connected successfully");
	} catch (err) {
		console.warn(`[queue] Redis not available - queue features disabled: ${err instanceof Error ? err.message : String(err)}`);
		console.warn("[queue] Email will be sent directly via SMTP instead of queued.");
	}

	function r(): RedisClient {
		if (!redis) throw new Error("Queue unavailable (Redis not connected)");
		return redis;
	}

	async function clear_pending(queue: string): Promise<number> {
		if (!available) return 0;
		const client = r();
		const key = `queue:${queue}`;
		const ids: string[] = (await client.lrange(key, 0, -1)) ?? [];
		if (ids.length > 0) {
			const hash_keys = ids.map((id: string) => `job:${id}`);
			await client.del(key, ...hash_keys);
		} else {
			await client.del(key);
		}
		return ids.length;
	}

	async function clear_failed(queue: string): Promise<number> {
		if (!available) return 0;
		const client = r();
		const key = `queue:${queue}:failed`;
		const ids: string[] = (await client.zrange(key, 0, -1)) ?? [];
		if (ids.length > 0) {
			const hash_keys = ids.map((id: string) => `job:${id}`);
			await client.del(key, ...hash_keys);
		} else {
			await client.del(key);
		}
		return ids.length;
	}

	async function clear_delayed(queue: string): Promise<number> {
		if (!available) return 0;
		const client = r();
		const key = `queue:${queue}:delayed`;
		const ids: string[] = (await client.zrange(key, 0, -1)) ?? [];
		if (ids.length > 0) {
			const hash_keys = ids.map((id: string) => `job:${id}`);
			await client.del(key, ...hash_keys);
		} else {
			await client.del(key);
		}
		return ids.length;
	}

	const store: QueueStore = {
		name: "redis",
		available,

		insert: async (job) => {
			const client = r();
			await hset_job(client, job.id, job);
			await client.expire(`job:${job.id}`, 86400);
			if (job.scheduled_for > 0) {
				await client.zadd(`queue:${job.queue}:delayed`, job.scheduled_for, job.id);
			} else {
				await client.lpush(`queue:${job.queue}`, job.id);
			}
		},

		consume: async (queue, on_job, options) => {
			// Each fiber needs its own Redis connection - BRPOP blocks the
			// connection until data arrives, so sharing one would serialize
			// every fiber behind the first BRPOP.
			const wr = new RedisClient(url);
			const signal = options?.signal;
			// How long a paused fiber waits before re-reading the pause flag.
			// Redis ignores poll_interval_ms while claiming (BRPOP blocks instead),
			// but it decides how quickly a resume is noticed - at the old fixed 1 s
			// an operator could wait a full second after clicking Resume.
			const paused_poll_ms = options?.poll_interval_ms ?? 250;
			// BRPOP(key, 0) blocks forever and cannot observe an abort, so use a
			// bounded 1 s timeout and loop: the fiber re-checks the signal (and the
			// pause flag) every second. Negligible next to per-job round trips.
			while (!signal?.aborted) {
				try {
					// A paused worker polls without claiming; it does not exit.
					if (await store.is_paused()) {
						await sleep(paused_poll_ms, signal);
						continue;
					}
					const result = await wr.brpop(`queue:${queue}`, 1);
					if (!result) continue;

					const job_id: string = result[1];

					// BRPOP blocks for up to a second, so the pause check above is
					// already stale by the time it returns: a job enqueued while the
					// worker sat blocked gets claimed despite the pause. Re-check
					// before touching the job, and RPUSH it back to the end BRPOP
					// pops from so it keeps its place at the front of the queue.
					if (await store.is_paused()) {
						await wr.rpush(`queue:${queue}`, job_id);
						await sleep(paused_poll_ms, signal);
						continue;
					}

					const job = await hget_job(wr, job_id);
					if (!job) continue;

					const now = now_epoch_ms();
					job.status = "running";
					job.last_run_at = now;
					await hset_job_fields(wr, job_id, { status: "running", last_run_at: String(now) });
					await wr.sadd("queue:running", job_id);

					await on_job(job);
				} catch (err) {
					console.error(`[queue] Redis worker unexpected error:`, err instanceof Error ? err.message : String(err));
					await sleep(1000, signal);
				}
			}
			await wr.close();
		},

		complete: async (job_id) => {
			if (!available) return;
			const client = r();
			await hset_job_fields(client, job_id, { status: "completed" });
			await client.srem("queue:running", job_id);
		},

		requeue: async (job, attempts, error_message) => {
			if (!available) return;
			const client = r();
			await hset_job_fields(client, job.id, {
				status: "pending",
				attempts: String(attempts),
				error_message: error_message ?? "",
			});
			await client.srem("queue:running", job.id);
			await client.lpush(`queue:${job.queue}`, job.id);
		},

		fail: async (job, attempts, error_message) => {
			if (!available) return;
			const client = r();
			await hset_job_fields(client, job.id, {
				status: "failed",
				attempts: String(attempts),
				error_message,
			});
			await client.srem("queue:running", job.id);
			await client.zadd(`queue:${job.queue}:failed`, now_epoch_ms(), job.id);
		},

		get: async (job_id) => {
			if (!available) return null;
			return hget_job(r(), job_id);
		},

		pending_ids: async (queue, limit) => {
			if (!available) return [];
			const ids_raw: string[] | null = await r().lrange(`queue:${queue}`, 0, limit - 1);
			return ids_raw ?? [];
		},

		failed_ids: async (queue, limit) => {
			if (!available) return [];
			const failed_raw = await r().zrange(`queue:${queue}:failed`, 0, limit - 1);
			return failed_raw ?? [];
		},

		length: async (queue) => {
			if (!available) return 0;
			return r().llen(`queue:${queue}`);
		},

		queue_names: async () => {
			if (!available) return [];
			const client = r();
			const names = new Set<string>();
			let cursor = "0";
			do {
				const result: [string, string[]] = await client.scan(cursor, "MATCH", "queue:*", "COUNT", 100);
				cursor = result[0];
				const keys = result[1] ?? [];
				for (const key of keys) {
					const name = key.replace(/^queue:/, "");
					// Only top-level queue names (no colon in the remainder),
					// excluding the special "running" SET.
					if (!name.includes(":") && name !== "running") { names.add(name); }
				}
			} while (cursor !== "0");

			return Array.from(names).sort();
		},

		stale_running: async (before) => {
			if (!available) return [];
			const client = r();
			const running_ids: string[] = (await client.smembers("queue:running")) ?? [];
			const orphans: Job[] = [];
			for (const job_id of running_ids) {
				try {
					const job = await hget_job(client, job_id);
					if (!job || job.status !== "running") {
						// Hash expired / status changed - clear the stale tracking entry.
						await client.srem("queue:running", job_id);
						continue;
					}
					if (job.last_run_at < before) { orphans.push(job); }
				} catch (err) {
					console.error(`[queue] Reaper error reading job ${job_id}:`, err instanceof Error ? err.message : String(err));
				}
			}
			return orphans;
		},

		retry: async (job_id, error_message) => {
			if (!available) return false;
			const client = r();
			const job = await hget_job(client, job_id);
			if (!job) return false;

			const queue_name = job.queue || job.type || "default";

			await client.zrem(`queue:${queue_name}:failed`, job_id);
			await hset_job_fields(client, job_id, {
				status: "pending",
				attempts: "0",
				error_message,
			});
			await client.lpush(`queue:${queue_name}`, job_id);
			return true;
		},

		remove: async (job_id) => {
			if (!available) return false;
			const client = r();
			const job = await hget_job(client, job_id);
			if (!job) return false;

			const queue_name = job.queue || job.type || "default";

			// Drop every reference to the job regardless of its current status:
			// the hash, the failed/delayed zsets, the pending list, and (in case
			// it is mid-flight) the running set.
			await client.del(`job:${job_id}`);
			await client.zrem(`queue:${queue_name}:failed`, job_id);
			await client.zrem(`queue:${queue_name}:delayed`, job_id);
			await client.lrem(`queue:${queue_name}`, 0, job_id);
			await client.srem("queue:running", job_id);
			return true;
		},

		clear_pending,
		clear_failed,
		clear_delayed,

		clear_queue_all: async (queue) => {
			if (!available) return { pending: 0, failed: 0, delayed: 0, running: 0 };
			const client = r();
			const [pending, failed, delayed] = await Promise.all([clear_pending(queue), clear_failed(queue), clear_delayed(queue)]);

			let running = 0;
			const running_ids: string[] = (await client.smembers("queue:running")) ?? [];
			const jobs = await Promise.all(running_ids.map((id) => hget_job(client, id)));
			const to_remove: string[] = [];
			const hash_keys: string[] = [];
			for (let i = 0; i < jobs.length; i++) {
				const job = jobs[i];
				if (job && (job.queue === queue || job.type === queue)) {
					to_remove.push(running_ids[i]!);
					hash_keys.push(`job:${running_ids[i]}`);
				}
			}
			if (to_remove.length > 0) {
				await client.srem("queue:running", ...to_remove);
				if (hash_keys.length > 0) { await client.del(...hash_keys); }
				running = to_remove.length;
			}

			return { pending, failed, delayed, running };
		},

		clear_all_queues: async () => {
			if (!available) return { queues: 0, pending: 0, failed: 0, delayed: 0, running: 0 };
			const client = r();
			const queue_names = await store.queue_names();
			let total_pending = 0;
			let total_failed = 0;
			let total_delayed = 0;

			for (const name of queue_names) {
				const [pending, failed, delayed] = await Promise.all([clear_pending(name), clear_failed(name), clear_delayed(name)]);
				total_pending += pending;
				total_failed += failed;
				total_delayed += delayed;
			}

			const running_ids: string[] = (await client.smembers("queue:running")) ?? [];
			let running = 0;
			if (running_ids.length > 0) {
				const hash_keys = running_ids.map((id: string) => `job:${id}`);
				await client.del("queue:running", ...hash_keys);
				running = running_ids.length;
			}

			return {
				queues: queue_names.length,
				pending: total_pending,
				failed: total_failed,
				delayed: total_delayed,
				running,
			};
		},

		set_heartbeat: async (pid, state) => {
			if (!available) return;
			await r().set("queue:worker:pid", String(pid));
			if (state !== undefined) await r().set("queue:worker:state", state);
		},

		get_heartbeat: async () => {
			if (!available) return null;
			const pid_str: string | null = await r().get("queue:worker:pid");
			return pid_str ? Number(pid_str) : null;
		},

		get_heartbeat_state: async () => {
			if (!available) return null;
			return await r().get("queue:worker:state");
		},

		set_paused: async (paused) => {
			if (!available) return;
			await r().set("queue:worker:paused", paused ? "1" : "0");
		},

		is_paused: async () => {
			if (!available) return false;
			const value: string | null = await r().get("queue:worker:paused");
			return value === "1";
		},

		// Redis expires job hashes natively (24 h TTL on insert) - nothing to sweep.
		cleanup_expired: async () => 0,

		close: async () => {
			if (redis) {
				await redis.close();
				redis = null;
				available = false;
			}
		},
	};

	return store;
}
