/**
 * Job types and serialisation - extracted from queue/index.ts for file-size compliance.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Job = {
	id: string;
	type: string;
	queue: string;
	payload: any;
	status: "pending" | "running" | "completed" | "failed";
	attempts: number;
	max_attempts: number;
	error_message: string | null;
	created_at: number;
	last_run_at: number;
	scheduled_for: number;
};

// ---------------------------------------------------------------------------
// Serialisation helpers (Redis stores everything as strings)
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

// Write a Job hash to Redis using HSET with field-value object.
export async function hset_job(r: any, job_id: string, job: Job): Promise<void> {
	const hash = job_to_hash(job);
	await r.hset(`job:${job_id}`, hash);
}

// Update individual fields on an existing job hash
export async function hset_job_fields(r: any, job_id: string, fields: Record<string, string>): Promise<void> { await r.hset(`job:${job_id}`, fields); }

// Read a Job hash and deserialise it
export async function hget_job(r: any, job_id: string): Promise<Job | null> {
	const raw: Record<string, string> | null = await r.hgetall(`job:${job_id}`);
	if (!raw || Object.keys(raw).length === 0) return null;
	return hash_to_job(raw);
}
