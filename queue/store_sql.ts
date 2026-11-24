/**
 * SQL-backed queue store (SQLite / MySQL) via Bun native SQL.
 *
 * Implements the same QueueStore contract as the Redis store, so queue policy
 * (retry, dead-letter, reaping) in queue/index.ts works unchanged against
 * either backend. The 24 h Redis hash TTL is emulated with an `expires_at`
 * column: rows past it are deleted by `cleanup_expired()` (see bootstrap).
 *
 * Correctness is identical across dialects (at-least-once delivery, exactly
 * one claim per job, delayed jobs run at or after scheduled_for); throughput
 * differs - SQLite serializes writers, MySQL scales via SKIP LOCKED.
 */
import { db, DB_CONNECTION_STRING } from "$config/db";
import { now_epoch_ms } from "$lib/temporal";

import type { Job } from "./job";
import type { QueueStore } from "./store";
import { get_dialect_ops, row_to_job as dialect_row_to_job } from "./store_sql_dialect";

// Matches the 24 h TTL Redis applies to job hashes.
const JOB_TTL_MS = 86_400_000;

const dialect = get_dialect_ops(DB_CONNECTION_STRING);

/**
 * Rows touched by a DELETE/UPDATE. The two dialects report this differently:
 * SQLite fills `count` and leaves `affectedRows` null, MySQL does the reverse.
 */
function affected_rows(result: unknown): number {
	const res = result as { count?: number | null; affectedRows?: number | null; };
	return Number(res?.affectedRows ?? res?.count ?? 0);
}

/**
 * Abortable sleep: resolves immediately when the signal fires, so a stop
 * during an idle poll is immediate instead of waiting the interval out.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
	});
}

async function clear_pending(queue: string): Promise<number> {
	const now = now_epoch_ms();
	const result = await db`DELETE FROM jobs WHERE queue = ${queue} AND status = 'pending' AND (scheduled_for = 0 OR scheduled_for <= ${now})`;
	return affected_rows(result);
}

async function clear_failed(queue: string): Promise<number> {
	const result = await db`DELETE FROM jobs WHERE queue = ${queue} AND status = 'failed'`;
	return affected_rows(result);
}

async function clear_delayed(queue: string): Promise<number> {
	const now = now_epoch_ms();
	const result = await db`DELETE FROM jobs WHERE queue = ${queue} AND status = 'pending' AND scheduled_for > ${now}`;
	return affected_rows(result);
}

export const sql_store: QueueStore = {
	name: "sql",
	available: true,

	insert: async (job) => {
		const expires_at = job.created_at + JOB_TTL_MS;
		await db`
			INSERT INTO jobs (id, type, queue, payload, status, attempts, max_attempts, error_message, created_at, last_run_at, scheduled_for, expires_at)
			VALUES (${job.id}, ${job.type}, ${job.queue}, ${JSON.stringify(job.payload)}, ${job.status}, ${job.attempts}, ${job.max_attempts}, ${job.error_message}, ${job.created_at}, ${job.last_run_at}, ${job.scheduled_for}, ${expires_at})
		`;
	},

	consume: async (queue, on_job, options) => {
		// No SQL equivalent of BRPOP - poll at a short interval instead.
		const poll_interval_ms = options?.poll_interval_ms ?? 500;
		const signal = options?.signal;
		while (!signal?.aborted) {
			try {
				// A paused worker polls without claiming; it does not exit.
				if (await sql_store.is_paused()) {
					await sleep(poll_interval_ms, signal);
					continue;
				}
				const job = await dialect.claim(db, queue, now_epoch_ms());
				if (job) {
					// The pause check above races the claim - pausing between the two
					// would still run this job. claim() leaves the attempt count
					// untouched, so handing the job back costs no retry, and "paused"
					// then means the same thing here as on the Redis backend.
					if (await sql_store.is_paused()) {
						await sql_store.requeue(job, job.attempts, job.error_message);
						await sleep(poll_interval_ms, signal);
						continue;
					}
					await on_job(job);
				} else {
					await sleep(poll_interval_ms, signal);
				}
			} catch (err) {
				console.error(`[queue] SQL worker unexpected error:`, err instanceof Error ? err.message : String(err));
				await sleep(1000, signal);
			}
		}
	},

	complete: async (job_id) => {
		await db`UPDATE jobs SET status = 'completed' WHERE id = ${job_id}`;
	},

	requeue: async (job, attempts, error_message) => {
		await db`UPDATE jobs SET status = 'pending', attempts = ${attempts}, error_message = ${error_message} WHERE id = ${job.id}`;
	},

	fail: async (job, attempts, error_message) => {
		await db`UPDATE jobs SET status = 'failed', attempts = ${attempts}, error_message = ${error_message} WHERE id = ${job.id}`;
	},

	get: async (job_id) => {
		const rows = await db`SELECT id, type, queue, payload, status, attempts, max_attempts, error_message, created_at, last_run_at, scheduled_for FROM jobs WHERE id = ${job_id}`;
		const row = rows[0];
		return row ? dialect_row_to_job(row) : null;
	},

	pending_ids: async (queue, limit) => {
		const now = now_epoch_ms();
		const rows = await db`SELECT id FROM jobs WHERE queue = ${queue} AND status = 'pending' AND (scheduled_for = 0 OR scheduled_for <= ${now}) ORDER BY created_at DESC LIMIT ${limit}`;
		return rows.map((row: any) => String(row.id));
	},

	failed_ids: async (queue, limit) => {
		const rows = await db`SELECT id FROM jobs WHERE queue = ${queue} AND status = 'failed' ORDER BY last_run_at DESC LIMIT ${limit}`;
		return rows.map((row: any) => String(row.id));
	},

	length: async (queue) => {
		const now = now_epoch_ms();
		const rows = await db`SELECT COUNT(*) AS cnt FROM jobs WHERE queue = ${queue} AND status = 'pending' AND (scheduled_for = 0 OR scheduled_for <= ${now})`;
		return Number(rows[0]?.cnt ?? 0);
	},

	queue_names: async () => {
		const rows = await db`SELECT DISTINCT queue FROM jobs ORDER BY queue`;
		return rows.map((row: any) => String(row.queue));
	},

	stale_running: async (before) => {
		const rows = await db`SELECT id, type, queue, payload, status, attempts, max_attempts, error_message, created_at, last_run_at, scheduled_for FROM jobs WHERE status = 'running' AND last_run_at < ${before}`;
		return rows.map((row: any) => dialect_row_to_job(row));
	},

	retry: async (job_id, error_message) => {
		const result = await db`UPDATE jobs SET status = 'pending', attempts = 0, error_message = ${error_message} WHERE id = ${job_id} AND status = 'failed'`;
		return affected_rows(result) > 0;
	},

	remove: async (job_id) => {
		const result = await db`DELETE FROM jobs WHERE id = ${job_id}`;
		return affected_rows(result) > 0;
	},

	clear_pending,
	clear_failed,
	clear_delayed,

	clear_queue_all: async (queue) => {
		const [pending, failed, delayed] = await Promise.all([clear_pending(queue), clear_failed(queue), clear_delayed(queue)]);
		const result = await db`DELETE FROM jobs WHERE queue = ${queue} AND status = 'running'`;
		return { pending, failed, delayed, running: affected_rows(result) };
	},

	clear_all_queues: async () => {
		const now = now_epoch_ms();
		const queues = await sql_store.queue_names();
		const rows = await db`
			SELECT
				COALESCE(SUM(CASE WHEN status = 'pending' AND (scheduled_for = 0 OR scheduled_for <= ${now}) THEN 1 ELSE 0 END), 0) AS pending,
				COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
				COALESCE(SUM(CASE WHEN status = 'pending' AND scheduled_for > ${now} THEN 1 ELSE 0 END), 0) AS delayed,
				COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) AS running
			FROM jobs
		`;
		await db`DELETE FROM jobs`;
		const row = rows[0] ?? {};
		return {
			queues: queues.length,
			pending: Number(row.pending ?? 0),
			failed: Number(row.failed ?? 0),
			delayed: Number(row.delayed ?? 0),
			running: Number(row.running ?? 0),
		};
	},

	set_heartbeat: async (pid, state) => {
		await dialect.upsert_meta(db, "worker_pid", String(pid));
		if (state !== undefined) await dialect.upsert_meta(db, "worker_state", state);
	},

	get_heartbeat: async () => {
		const rows = await db`SELECT meta_value FROM queue_meta WHERE meta_key = 'worker_pid'`;
		const value = rows[0]?.meta_value;
		return value !== undefined && value !== null && value !== "" ? Number(value) : null;
	},

	get_heartbeat_state: async () => {
		const rows = await db`SELECT meta_value FROM queue_meta WHERE meta_key = 'worker_state'`;
		const value = rows[0]?.meta_value;
		return value !== undefined && value !== null && value !== "" ? value : null;
	},

	set_paused: async (paused) => {
		await dialect.upsert_meta(db, "paused", paused ? "1" : "0");
	},

	is_paused: async () => {
		const rows = await db`SELECT meta_value FROM queue_meta WHERE meta_key = 'paused'`;
		return rows[0]?.meta_value === "1";
	},

	cleanup_expired: async () => {
		const now = now_epoch_ms();
		const result = await db`DELETE FROM jobs WHERE expires_at <= ${now}`;
		return affected_rows(result);
	},

	close: async () => {
		// The shared db connection is owned by $config/db - nothing to close.
	},
};
