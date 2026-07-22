/**
 * Queue clearing utilities - extracted from queue/index.ts for file-size compliance.
 */

import { hget_job } from "./job";

// ---------------------------------------------------------------------------
// Queue clearing utilities
// ---------------------------------------------------------------------------

/**
 * Clear pending jobs from a queue. Removes all job IDs from the queue list
 * and deletes their metadata hashes.
 */
export async function clear_queue_pending(r: any, queue: string): Promise<number> {
	const key = `queue:${queue}`;
	const ids: string[] = (await r.lrange(key, 0, -1)) ?? [];
	if (ids.length > 0) {
		const hash_keys = ids.map((id: string) => `job:${id}`);
		await r.del(key, ...hash_keys);
	} else {
		await r.del(key);
	}
	return ids.length;
}

/**
 * Clear failed jobs from a queue. Removes all failed job IDs from the failed
 * ZSET and deletes their metadata hashes.
 */
export async function clear_queue_failed(r: any, queue: string): Promise<number> {
	const key = `queue:${queue}:failed`;
	const ids: string[] = (await r.zrange(key, 0, -1)) ?? [];
	if (ids.length > 0) {
		const hash_keys = ids.map((id: string) => `job:${id}`);
		await r.del(key, ...hash_keys);
	} else {
		await r.del(key);
	}
	return ids.length;
}

/**
 * Clear delayed/scheduled jobs from a queue. Removes all delayed job IDs
 * from the delayed ZSET and deletes their metadata hashes.
 */
export async function clear_queue_delayed(r: any, queue: string): Promise<number> {
	const key = `queue:${queue}:delayed`;
	const ids: string[] = (await r.zrange(key, 0, -1)) ?? [];
	if (ids.length > 0) {
		const hash_keys = ids.map((id: string) => `job:${id}`);
		await r.del(key, ...hash_keys);
	} else {
		await r.del(key);
	}
	return ids.length;
}

/**
 * Clear all jobs (pending + failed + delayed) for a specific queue.
 * Also clears running jobs that belong to this queue.
 */
export async function clear_queue_all(r: any, queue: string, is_available: boolean): Promise<{ pending: number; failed: number; delayed: number; running: number; }> {
	const [pending, failed, delayed] = await Promise.all([clear_queue_pending(r, queue), clear_queue_failed(r, queue), clear_queue_delayed(r, queue)]);

	// Also clear running jobs for this queue
	let running = 0;
	if (is_available) {
		const running_ids: string[] = (await r.smembers("queue:running")) ?? [];
		const jobs = await Promise.all(running_ids.map((id) => hget_job(r, id)));
		const to_remove: string[] = [];
		const hash_keys: string[] = [];
		for (let i = 0; i < jobs.length; i++) {
			const job = jobs[i];
			if (job && (job.queue === queue || job.type === queue)) {
				to_remove.push(running_ids[i]);
				hash_keys.push(`job:${running_ids[i]}`);
			}
		}
		if (to_remove.length > 0) {
			await r.srem("queue:running", ...to_remove);
			if (hash_keys.length > 0) { await r.del(...hash_keys); }
			running = to_remove.length;
		}
	}

	return { pending, failed, delayed, running };
}

/**
 * Clear ALL queues - pending, failed, delayed, and running jobs across all
 * discovered queue names. Also deletes all job metadata hashes.
 */
export async function clear_all_queues(r: any, is_available: boolean, scan_queue_names: () => Promise<string[]>): Promise<{
	queues: number;
	pending: number;
	failed: number;
	delayed: number;
	running: number;
}> {
	if (!is_available) return { queues: 0, pending: 0, failed: 0, delayed: 0, running: 0 };

	const queue_names = await scan_queue_names();
	let total_pending = 0;
	let total_failed = 0;
	let total_delayed = 0;

	for (const name of queue_names) {
		const [pending, failed, delayed] = await Promise.all([clear_queue_pending(r, name), clear_queue_failed(r, name), clear_queue_delayed(r, name)]);
		total_pending += pending;
		total_failed += failed;
		total_delayed += delayed;
	}

	// Clear all running jobs
	const running_ids: string[] = (await r.smembers("queue:running")) ?? [];
	let running = 0;
	if (running_ids.length > 0) {
		const hash_keys = running_ids.map((id: string) => `job:${id}`);
		await r.del("queue:running", ...hash_keys);
		running = running_ids.length;
	}

	return {
		queues: queue_names.length,
		pending: total_pending,
		failed: total_failed,
		delayed: total_delayed,
		running,
	};
}
