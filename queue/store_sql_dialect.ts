/**
 * Dialect registry for the SQL queue store.
 *
 * The queue store touches SQL differently per dialect in exactly two places:
 * the atomic claim and the queue_meta upsert. Everything else in store_sql.ts
 * is spelled identically on SQLite and MySQL/MariaDB, so this module keeps
 * that divergence in one registry-shaped place - mirroring how config/db.ts
 * uses a CONFIGS map rather than ternaries. When PostgreSQL lands, it adds
 * one entry here, not a new `if` in the store.
 */
import type { SQL } from "bun";

import type { Job } from "./job";

export type Dialect = "sqlite" | "mysql";

export function detect_dialect(connection_string: string): Dialect {
	return connection_string.toLowerCase().startsWith("mysql://") ? "mysql" : "sqlite";
}

/** Convert a jobs row (either dialect) back to the Job type. */
export function row_to_job(row: any): Job {
	return {
		id: String(row.id),
		type: String(row.type),
		queue: String(row.queue),
		payload: typeof row.payload === "string" ? JSON.parse(row.payload || "{}") : (row.payload ?? {}),
		status: (row.status as Job["status"]) ?? "pending",
		attempts: Number(row.attempts ?? 0),
		max_attempts: Number(row.max_attempts ?? 3),
		error_message: row.error_message ?? null,
		created_at: Number(row.created_at ?? 0),
		last_run_at: Number(row.last_run_at ?? 0),
		scheduled_for: Number(row.scheduled_for ?? 0),
	};
}

/**
 * SQLite claim: a single UPDATE .. RETURNING. SQLite serializes writers at the
 * statement level, so the subquery-select + update is atomic with no
 * read-modify-write window and no transaction needed.
 */
async function claim_sqlite(db: SQL, queue: string, now: number): Promise<Job | null> {
	const rows = await db`
		UPDATE jobs SET status = 'running', last_run_at = ${now}
		WHERE id = (
			SELECT id FROM jobs
			WHERE queue = ${queue} AND status = 'pending'
			  AND (scheduled_for = 0 OR scheduled_for <= ${now})
			ORDER BY created_at LIMIT 1
		)
		RETURNING id, type, queue, payload, status, attempts, max_attempts, error_message, created_at, last_run_at, scheduled_for
	`;
	const row = rows[0];
	return row ? row_to_job(row) : null;
}

/**
 * MySQL claim: SELECT .. FOR UPDATE SKIP LOCKED inside a transaction, then a
 * plain UPDATE (MySQL 8.0 has no UPDATE .. RETURNING - MariaDB does - so the
 * claimed row is re-read instead). SKIP LOCKED is what makes concurrent
 * workers safe: a row locked by another claim transaction is skipped, so
 * exactly one worker ever receives a given job.
 */
async function claim_mysql(db: SQL, queue: string, now: number): Promise<Job | null> {
	let claimed: Job | null = null;
	await db.begin(async (tx) => {
		const rows = await tx`
			SELECT id FROM jobs
			WHERE queue = ${queue} AND status = 'pending'
			  AND (scheduled_for = 0 OR scheduled_for <= ${now})
			ORDER BY created_at LIMIT 1
			FOR UPDATE SKIP LOCKED
		`;
		if (rows.length === 0) return;

		const id = String(rows[0].id);
		await tx`UPDATE jobs SET status = 'running', last_run_at = ${now} WHERE id = ${id}`;
		const job_rows = await tx`SELECT id, type, queue, payload, status, attempts, max_attempts, error_message, created_at, last_run_at, scheduled_for FROM jobs WHERE id = ${id}`;
		claimed = row_to_job(job_rows[0]);
	});
	return claimed;
}

async function upsert_meta_sqlite(db: SQL, key: string, value: string): Promise<void> {
	await db`
		INSERT INTO queue_meta (meta_key, meta_value) VALUES (${key}, ${value})
		ON CONFLICT(meta_key) DO UPDATE SET meta_value = ${value}
	`;
}

async function upsert_meta_mysql(db: SQL, key: string, value: string): Promise<void> {
	await db`
		INSERT INTO queue_meta (meta_key, meta_value) VALUES (${key}, ${value})
		ON DUPLICATE KEY UPDATE meta_value = ${value}
	`;
}

export type DialectOps = {
	claim: (db: SQL, queue: string, now: number) => Promise<Job | null>;
	upsert_meta: (db: SQL, key: string, value: string) => Promise<void>;
};

const OPS: Record<Dialect, DialectOps> = {
	sqlite: { claim: claim_sqlite, upsert_meta: upsert_meta_sqlite },
	mysql: { claim: claim_mysql, upsert_meta: upsert_meta_mysql },
};

export function get_dialect_ops(connection_string: string): DialectOps {
	return OPS[detect_dialect(connection_string)];
}
