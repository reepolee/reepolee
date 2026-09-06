/**
 * Job type - storage-agnostic. Both queue stores (Redis and SQL) read and
 * write these; the serialisation helpers that differ per store live in
 * store_redis.ts / store_sql.ts.
 */

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

export type JobHandler = (job: Job) => Promise<void>;
