/**
 * BREAD store for the system queues dashboard.
 *
 * The queue worker lives in a separate process, so every read and mutating
 * action here goes through the shared queue store (`$queue/index`) rather
 * than a local data file. The route handler (`index.ts`) only maps this
 * store's results onto responses and translations; the gathering, formatting,
 * and actions live here so the dashboard keeps the same single-responsibility
 * shape as the other BREAD resources (environment, rate_limits).
 */

import type { Job } from "$queue/index";
import {
	clear_queue_all,
	clear_queue_failed,
	clear_queue_pending,
	delete_job as delete_queue_job,
	get_failed_job_ids,
	get_job,
	get_pending_job_ids,
	get_running_jobs,
	get_worker_state,
	is_queue_available,
	is_queue_redis_backed,
	is_worker_alive,
	is_worker_paused,
	queue_length,
	retry_job as retry_queue_job,
	scan_queue_names,
	set_worker_paused as set_queue_worker_paused,
} from "$queue/index";

export const RESOURCE_NAME = "queues";

/** A job shaped for the dashboard template (epoch timestamps pre-formatted). */
export interface DisplayJob {
	id: string;
	type: string;
	queue: string;
	payload: unknown;
	status: string;
	attempts: number;
	max_attempts: number;
	error_message: string | null;
	created_formatted: string;
	last_run_formatted: string;
	scheduled_formatted: string;
}

export interface QueueSummary {
	name: string;
	pending: number;
	pending_jobs: DisplayJob[];
}

export interface DashboardData {
	queues: QueueSummary[];
	failed: DisplayJob[];
	running: DisplayJob[];
	worker_alive: boolean;
	worker_state: string | null;
	worker_paused: boolean;
	queue_backend: "redis" | "sql";
}

function format_epoch(epoch_ms: number): string {
	return Temporal.Instant.fromEpochMilliseconds(epoch_ms).toLocaleString();
}

function to_display_job(job: Job): DisplayJob {
	return {
		id: job.id,
		type: job.type,
		queue: job.queue,
		payload: job.payload,
		status: job.status,
		attempts: job.attempts,
		max_attempts: job.max_attempts,
		error_message: job.error_message,
		created_formatted: format_epoch(job.created_at),
		last_run_formatted: job.last_run_at > 0 ? format_epoch(job.last_run_at) : "-",
		scheduled_formatted: job.scheduled_for > 0 ? format_epoch(job.scheduled_for) : "-",
	};
}

/** Which backend the queue is currently using, for the dashboard badge. */
export function queue_backend(): "redis" | "sql" {
	return is_queue_redis_backed() ? "redis" : "sql";
}

/** Whether the queue store is usable (the handler renders a fallback when not). */
export function queue_available(): boolean {
	return is_queue_available();
}

/**
 * Gather the whole dashboard in one pass: worker status, per-queue pending
 * counts and jobs, and failed jobs (newest run first).
 */
export async function get_dashboard_data(): Promise<DashboardData> {
	const [worker_alive, worker_state, worker_paused] = await Promise.all([
		is_worker_alive(),
		get_worker_state(),
		is_worker_paused(),
	]);

	// Discover queue names dynamically from the queue store.
	const queue_names = await scan_queue_names();

	// Batch-gather queue depths and pending jobs.
	const queues: QueueSummary[] = [];
	const queue_lengths = await Promise.all(queue_names.map((name) => queue_length(name)));
	const queue_pending_ids = await Promise.all(queue_names.map((name, i) => (queue_lengths[i]! > 0 ? get_pending_job_ids(name, 50) : [])));

	const all_pending_jobs = await Promise.all(queue_pending_ids.flat().map((job_id) => get_job(job_id)));

	let pending_idx = 0;
	for (let qi = 0; qi < queue_names.length; qi++) {
		const ids = queue_pending_ids[qi]!;
		if (ids.length === 0) continue;
		const jobs: DisplayJob[] = [];
		for (const _id of ids) {
			const job = all_pending_jobs[pending_idx++];
			if (job && job.status === "pending") jobs.push(to_display_job(job));
		}
		if (jobs.length > 0) {
			queues.push({ name: queue_names[qi]!, pending: queue_lengths[qi]!, pending_jobs: jobs });
		}
	}

	// Batch-gather failed jobs across every queue, newest run first.
	const failed_ids_by_queue = await Promise.all(queue_names.map((name) => get_failed_job_ids(name, 50)));
	const failed_jobs = await Promise.all(failed_ids_by_queue.flat().map((id) => get_job(id)));
	const failed = failed_jobs
		.filter((job): job is Job => job !== null && job.status === "failed")
		.sort((left, right) => right.last_run_at - left.last_run_at)
		.slice(0, 100)
		.map(to_display_job);

	// In-flight jobs. A job claimed by a worker that then died stays here
	// indefinitely until the reaper re-enqueues it, and it appears in neither
	// the pending nor the failed list - so report it explicitly.
	const running_jobs = await get_running_jobs();
	const running = running_jobs.slice(0, 100).map(to_display_job);

	return { queues, failed, running, worker_alive, worker_state, worker_paused, queue_backend: queue_backend() };
}

/** Pause or resume the worker (operator pause, stored in the queue store). */
export async function set_worker_paused(paused: boolean): Promise<void> {
	await set_queue_worker_paused(paused);
}

/** Retry a failed job. Returns false when the job is missing or not retryable. */
export async function retry_job(job_id: string): Promise<boolean> {
	return retry_queue_job(job_id);
}

/** Delete a job entirely. Returns false when the job is missing. */
export async function delete_job(job_id: string): Promise<boolean> {
	return delete_queue_job(job_id);
}

export type ClearAction = "pending" | "failed" | "all";

/** Clear jobs from a queue, partitioned by status. */
export async function clear_queue(queue: string, action: ClearAction): Promise<void> {
	if (action === "pending") await clear_queue_pending(queue);
	else if (action === "failed") await clear_queue_failed(queue);
	else await clear_queue_all(queue);
}
