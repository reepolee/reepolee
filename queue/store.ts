/**
 * Queue store contract.
 *
 * Storage-agnostic: the policy in queue/index.ts (retry and max_attempts
 * decisions, dead-letter routing, reaper timeout, worker concurrency) depends
 * only on this interface. The two implementations are selected by config,
 * mirroring the rate limiter and session store resolvers: Redis when it is
 * available (REDIS_ENABLED=true and a real REDIS_URL), SQL otherwise.
 */
import type { Job } from "./job";

export type ClearResult = { pending: number; failed: number; delayed: number; running: number; };

export type ConsumeOptions = {
	/** How long a SQL-backed worker waits between claims when the queue is empty. The Redis store ignores it while claiming (BRPOP blocks instead) but uses it as the re-check interval while paused. */
	poll_interval_ms?: number;
	/**
	 * Abort signal for a graceful stop. The loop checks it before each claim
	 * (never mid-handler - a job already running always finishes and calls
	 * `complete`), and the idle sleep becomes abortable so a stop during a poll
	 * is immediate rather than waiting the interval out.
	 */
	signal?: AbortSignal;
};

export interface QueueStore {
	readonly name: "redis" | "sql";
	readonly available: boolean;

	/**
	 * Persist a new job (status must be "pending"). Delayed routing
	 * (scheduled_for > 0) is a store concern, so both dialects and Redis
	 * implement it however their storage dictates.
	 */
	insert(job: Job): Promise<void>;

	/**
	 * Block (Redis BRPOP) or poll (SQL) until a job is available, atomically
	 * claim it (status -> "running", last_run_at -> now, tracked for the
	 * reaper), then invoke `on_job`. Never rejects - internal errors are
	 * logged and the loop continues. Exactly one worker receives a given job.
	 * With `options.signal`, the loop checks the signal before each claim and
	 * exits cleanly when aborted (in-flight handlers still finish).
	 */
	consume(queue: string, on_job: (job: Job) => Promise<void>, options?: ConsumeOptions): Promise<void>;

	/** Mark a claimed job completed. */
	complete(job_id: string): Promise<void>;

	/**
	 * Re-queue a claimed job for another attempt (status -> "pending",
	 * attempts + error message persisted). Used by the retry path and the
	 * reaper.
	 */
	requeue(job: Job, attempts: number, error_message: string | null): Promise<void>;

	/** Dead-letter a claimed job (status -> "failed"). */
	fail(job: Job, attempts: number, error_message: string): Promise<void>;

	get(job_id: string): Promise<Job | null>;
	pending_ids(queue: string, limit: number): Promise<string[]>;
	failed_ids(queue: string, limit: number): Promise<string[]>;
	length(queue: string): Promise<number>;
	queue_names(): Promise<string[]>;

	/** Jobs stuck in "running" whose last_run_at is older than `before` (for orphan reaping). */
	stale_running(before: number): Promise<Job[]>;

	/** Manually retry a failed job (status -> "pending", attempts reset). Returns false if not found/not retryable. */
	retry(job_id: string, error_message: string): Promise<boolean>;

	/** Delete a job entirely (any status). Returns false if not found. */
	remove(job_id: string): Promise<boolean>;

	clear_pending(queue: string): Promise<number>;
	clear_failed(queue: string): Promise<number>;
	clear_delayed(queue: string): Promise<number>;
	clear_queue_all(queue: string): Promise<ClearResult>;
	clear_all_queues(): Promise<{ queues: number } & ClearResult>;

	/** Record the worker PID (and optional lifecycle state) so the admin UI can verify a worker is alive. */
	set_heartbeat(pid: number, state?: string): Promise<void>;
	get_heartbeat(): Promise<number | null>;
	get_heartbeat_state(): Promise<string | null>;

	/** Operator pause: a paused worker polls without claiming. Survives restarts (stored, not in-memory). */
	set_paused(paused: boolean): Promise<void>;
	is_paused(): Promise<boolean>;

	/** Delete jobs past their 24h expiry. No-op on stores that expire natively (Redis). */
	cleanup_expired(): Promise<number>;

	close(): Promise<void>;
}
