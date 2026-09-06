/**
 * Tests for the SQL-backed queue store (queue/store_sql.ts) and its dialect
 * registry (queue/store_sql_dialect.ts), against an in-memory SQLite database.
 * The DDL is read from sql/sqlite/init/06-init-queue.sql so the test always
 * exercises the schema the template ships.
 *
 * Deliberately store-level only: queue/index.ts is mocked process-wide by
 * server.test.ts (Bun's mock.module is keyed by resolved module path, so the
 * mock leaks into every file in the shared test process). The SQL semantics
 * that matter - atomic claim, delayed jobs, retries, dead-letter, reaping,
 * TTL, heartbeat - all live in the store and are covered here directly.
 *
 * The claim-concurrency test additionally opens two connections to a temp
 * file DB to exercise real cross-connection writers (in-memory SQLite gives
 * each connection its own database, which would not prove anything about
 * concurrent claims).
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQL } from "bun";

import { now_epoch_ms } from "$lib/temporal";

const db = new SQL("sqlite://:memory:");

mock.module("$config/db", () => ({
	db,
	close_db: async () => {},
	verify_db_schema: async () => {},
	DB_CONNECTION_STRING: "sqlite://test.db",
	DATE_TZ: "UTC",
	TIME_TZ: "UTC",
	DATETIME_TZ: "UTC",
	TIMESTAMP_TZ: "UTC",
}));

const { sql_store } = await import("./store_sql");
const { get_dialect_ops, row_to_job } = await import("./store_sql_dialect");
import type { Job } from "./job";

// The store hides claim inside consume(); the dialect claim is what consume
// delegates to, so exercising it here is testing the real claim path.
const ops = get_dialect_ops("sqlite://test.db");
const claim = (queue: string, now: number) => ops.claim(db, queue, now);

// Base timestamp on the real clock: cleanup_expired / stale_running compare
// against now_epoch_ms() internally, so a synthetic future constant would
// make those rows look fresh and un-expired.
const NOW = now_epoch_ms();

function make_job(overrides: Partial<Job> = {}): Job {
	return {
		id: overrides.id ?? `job-${Math.random().toString(36).slice(2)}`,
		type: "test_type",
		queue: "test_queue",
		payload: { n: 1 },
		status: "pending",
		attempts: 0,
		max_attempts: 3,
		error_message: null,
		created_at: NOW,
		last_run_at: 0,
		scheduled_for: 0,
		...overrides,
	};
}

// Apply the shipped schema to a connection (mirrors the statement splitting in
// scripts/init_sqlite_db.ts / generator/reeman/quick_start.ts).
async function apply_schema(conn: SQL): Promise<void> {
	const content = await Bun.file("sql/sqlite/init/06-init-queue.sql").text();
	const no_comments = content.split("\n")
		.map((line) => line.trimStart())
		.filter((line) => !line.startsWith("--"))
		.join("\n");
	const statements = (no_comments.match(/[^;]+;/g) ?? [])
		.map((stmt) => stmt.replace(/;\s*$/, "").trim())
		.filter((stmt) => stmt.length > 0);
	for (const stmt of statements) { await conn.unsafe(stmt); }
}

beforeEach(async () => {
	await apply_schema(db);
});

// Deliberately NOT closing `db` here. The mock.module above is process-global,
// so this in-memory SQLite is what every later test file resolves `$config/db`
// to. Closing it left those files with a closed handle - the cause of
// "SQLiteError: Connection closed" in lib/middleware/rate_limit.test.ts and
// apps/reeman/sync, which passed alone and failed in a full run. An in-memory
// database is reclaimed when the process exits; there is nothing to release.

describe("store_sql claim", () => {
	test("claims pending jobs oldest-first exactly once, then returns null", async () => {
		const a = make_job({ id: "a", created_at: NOW });
		const b = make_job({ id: "b", created_at: NOW + 100 });
		await sql_store.insert(a);
		await sql_store.insert(b);

		const first = await claim("test_queue", NOW + 200);
		expect(first?.id).toBe("a");
		expect(first?.status).toBe("running");
		expect(first?.last_run_at).toBe(NOW + 200);
		expect(first?.attempts).toBe(0); // claim does not count attempts - the failure path does

		const second = await claim("test_queue", NOW + 200);
		expect(second?.id).toBe("b");

		const third = await claim("test_queue", NOW + 200);
		expect(third).toBeNull();
	});

	test("a job is claimed exactly once under concurrent claims (single connection)", async () => {
		const ids = ["c1", "c2", "c3", "c4", "c5"];
		for (const id of ids) { await sql_store.insert(make_job({ id })); }

		const claims = await Promise.all(ids.map(() => claim("test_queue", NOW)));
		const claimed_ids = claims.map((job) => job?.id).filter(Boolean).sort();
		expect(claimed_ids).toEqual(ids.sort());
		expect(new Set(claimed_ids).size).toBe(ids.length);

		// Nothing left to claim.
		expect(await claim("test_queue", NOW)).toBeNull();
	});

	test("a job is claimed exactly once under concurrent writers on separate connections", async () => {
		const dir = mkdtempSync(join(tmpdir(), "reepolee-queue-test-"));
		const db_path = join(dir, "queue.db");
		try {
			const conn_a = new SQL(`sqlite:${db_path}`);
			const conn_b = new SQL(`sqlite:${db_path}`);
			try {
				await conn_a`PRAGMA journal_mode = WAL`;
				await conn_a`PRAGMA busy_timeout = 2000`;
				await conn_b`PRAGMA busy_timeout = 2000`;
				await apply_schema(conn_a);

				const ids = ["x1", "x2", "x3", "x4", "x5"];
				for (const id of ids) {
					await conn_a`INSERT INTO jobs (id, type, queue, payload, status, attempts, max_attempts, error_message, created_at, last_run_at, scheduled_for, expires_at)
						VALUES (${id}, 'test_type', 'test_queue', '{}', 'pending', 0, 3, NULL, ${NOW}, 0, 0, ${NOW + 86_400_000})`;
				}

				// Ten concurrent claims across two connections - the single-statement
				// atomic claim must hand out each job at most once. The statement is
				// the exact claim_sqlite() from store_sql_dialect.ts.
				const claim_sql = `
					UPDATE jobs SET status = 'running', last_run_at = ${NOW + 999}
					WHERE id = (
						SELECT id FROM jobs
						WHERE queue = 'test_queue' AND status = 'pending'
						  AND (scheduled_for = 0 OR scheduled_for <= ${NOW + 999})
						ORDER BY created_at LIMIT 1
					)
					RETURNING id
				`;
				const run_claim = (conn: SQL) => conn.unsafe(claim_sql) as Promise<{ id: string; }[]>;
				const results = await Promise.all([run_claim(conn_a), run_claim(conn_a), run_claim(conn_a), run_claim(conn_a), run_claim(conn_a), run_claim(conn_b), run_claim(conn_b), run_claim(conn_b), run_claim(conn_b), run_claim(conn_b)]);

				const claimed_ids = results.flat().map((row) => row.id).sort();
				expect(claimed_ids).toEqual(ids.sort());
				expect(new Set(claimed_ids).size).toBe(ids.length);
			} finally {
				await conn_a.close();
				await conn_b.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("delayed jobs are not claimable until scheduled_for", async () => {
		const soon = make_job({ id: "soon", scheduled_for: NOW + 60_000 });
		await sql_store.insert(soon);
		expect(await claim("test_queue", NOW)).toBeNull();

		// Once the timestamp arrives, the same row becomes claimable - no sweeper needed.
		const claimed = await claim("test_queue", NOW + 60_001);
		expect(claimed?.id).toBe("soon");
	});

	test("immediate jobs are claimable even when later jobs are scheduled earlier", async () => {
		const delayed = make_job({ id: "delayed", created_at: NOW, scheduled_for: NOW + 60_000 });
		const immediate = make_job({ id: "immediate", created_at: NOW + 100 });
		await sql_store.insert(delayed);
		await sql_store.insert(immediate);

		const claimed = await claim("test_queue", NOW + 200);
		expect(claimed?.id).toBe("immediate");
	});
});

describe("store_sql lifecycle", () => {
	test("complete marks a claimed job completed", async () => {
		await sql_store.insert(make_job({ id: "done" }));
		const job = await claim("test_queue", NOW);
		await sql_store.complete(job!.id);

		const stored = await sql_store.get("done");
		expect(stored?.status).toBe("completed");
	});

	test("requeue resets a job to pending for another attempt", async () => {
		await sql_store.insert(make_job({ id: "retry-me", max_attempts: 3 }));
		const job = await claim("test_queue", NOW);
		expect(job).not.toBeNull();

		// First failure: attempts 1 < max 3 -> re-queued
		await sql_store.requeue(job!, 1, "boom");
		expect((await sql_store.get("retry-me"))?.status).toBe("pending");
		expect((await sql_store.get("retry-me"))?.attempts).toBe(1);
		expect((await sql_store.get("retry-me"))?.error_message).toBe("boom");

		// Still claimable again.
		expect((await claim("test_queue", NOW))?.id).toBe("retry-me");
	});

	test("dead-letters a job once attempts reach max_attempts", async () => {
		await sql_store.insert(make_job({ id: "dead", max_attempts: 2 }));

		const first = await claim("test_queue", NOW);
		await sql_store.fail(first!, 1, "err-1"); // 1 < 2 -> would retry
		expect((await sql_store.get("dead"))?.status).toBe("failed");

		const failed_ids = await sql_store.failed_ids("test_queue", 10);
		expect(failed_ids).toContain("dead");
	});

	test("retry resurrects a failed job with attempts reset", async () => {
		await sql_store.insert(make_job({ id: "resurrect", max_attempts: 1 }));
		const job = await claim("test_queue", NOW);
		await sql_store.fail(job!, 1, "boom");

		expect(await sql_store.retry("resurrect", "Retried manually (was: boom)")).toBe(true);
		const stored = await sql_store.get("resurrect");
		expect(stored?.status).toBe("pending");
		expect(stored?.attempts).toBe(0);

		// Missing -> false; non-failed -> false.
		expect(await sql_store.retry("missing", "x")).toBe(false);
	});

	test("remove deletes a job entirely; missing returns false", async () => {
		await sql_store.insert(make_job({ id: "remove-me", max_attempts: 1 }));
		const job = await claim("test_queue", NOW);
		await sql_store.fail(job!, 1, "boom");
		expect(await sql_store.failed_ids("test_queue", 10)).toContain("remove-me");

		expect(await sql_store.remove("remove-me")).toBe(true);
		expect(await sql_store.get("remove-me")).toBeNull();
		expect(await sql_store.failed_ids("test_queue", 10)).not.toContain("remove-me");

		// Missing -> false; already-removed -> false.
		expect(await sql_store.remove("remove-me")).toBe(false);
		expect(await sql_store.remove("missing")).toBe(false);
	});
});

describe("store_sql reaper", () => {
	test("stale_running finds old running rows and requeue resurrects them", async () => {
		await sql_store.insert(make_job({ id: "orphan", max_attempts: 3 }));
		await claim("test_queue", NOW);

		// Simulate a crashed worker: last_run_at is NOW, so with a `before` of
		// now it is stale (this is what reap_orphans(timeout_ms=0) computes).
		const orphans = await sql_store.stale_running(now_epoch_ms());
		expect(orphans.length).toBe(1);
		expect(orphans[0]?.id).toBe("orphan");

		// The reaper bumps attempts and re-queues.
		const orphan = orphans[0]!;
		orphan.attempts++;
		await sql_store.requeue(orphan, orphan.attempts, `Re-enqueued by reaper after 0ms in running state`);
		expect((await sql_store.get("orphan"))?.status).toBe("pending");
		expect((await sql_store.get("orphan"))?.attempts).toBe(1);

		// It is claimable again.
		expect((await claim("test_queue", NOW))?.id).toBe("orphan");
	});

	test("stale_running leaves fresh running jobs alone", async () => {
		await sql_store.insert(make_job({ id: "fresh" }));
		await claim("test_queue", NOW);
		// last_run_at = NOW, so it is NOT older than NOW - 60_000.
		expect(await sql_store.stale_running(now_epoch_ms() - 60_000)).toEqual([]);
	});
});

describe("store_sql TTL sweep", () => {
	test("cleanup_expired deletes jobs past their 24 h expiry", async () => {
		const old_time = NOW - 25 * 60 * 60 * 1000;
		await sql_store.insert(make_job({ id: "expired", created_at: old_time }));
		await sql_store.insert(make_job({ id: "live", created_at: NOW }));

		const deleted = await sql_store.cleanup_expired();
		expect(deleted).toBe(1);
		expect(await sql_store.get("expired")).toBeNull();
		expect(await sql_store.get("live")).not.toBeNull();
	});
});

describe("store_sql queries and clearing", () => {
	beforeEach(async () => {
		await sql_store.insert(make_job({ id: "p1", queue: "q1" }));
		await sql_store.insert(make_job({ id: "p2", queue: "q1" }));
		await sql_store.insert(make_job({ id: "delayed-1", queue: "q1", scheduled_for: NOW + 60_000 }));
		await sql_store.insert(make_job({ id: "p3", queue: "q2" }));
	});

	test("length and pending_ids count runnable pending jobs only", async () => {
		expect(await sql_store.length("q1")).toBe(2);
		expect((await sql_store.pending_ids("q1", 10)).sort()).toEqual(["p1", "p2"]);
		expect((await sql_store.pending_ids("q1", 1)).length).toBe(1);
	});

	test("queue_names lists non-empty queues", async () => {
		expect((await sql_store.queue_names()).sort()).toEqual(["q1", "q2"]);
	});

	test("clear_pending / clear_delayed / clear_failed partition the table", async () => {
		expect(await sql_store.clear_pending("q1")).toBe(2);
		expect(await sql_store.clear_delayed("q1")).toBe(1);
		expect(await sql_store.get("p1")).toBeNull();
		expect(await sql_store.get("delayed-1")).toBeNull();
		// q2 rows untouched.
		expect(await sql_store.length("q2")).toBe(1);
	});

	test("clear_queue_all clears pending, failed, delayed and running for one queue", async () => {
		await claim("q1", NOW); // marks p1 running
		const result = await sql_store.clear_queue_all("q1");
		expect(result.pending + result.delayed + result.running).toBe(3);
		expect(await sql_store.length("q1")).toBe(0);
		expect(await sql_store.length("q2")).toBe(1);
	});
});

describe("store_sql heartbeat", () => {
	test("set_heartbeat upserts and get_heartbeat reads back", async () => {
		await sql_store.set_heartbeat(process.pid);
		expect(await sql_store.get_heartbeat()).toBe(process.pid);

		// Upsert - overwrite with a different PID.
		await sql_store.set_heartbeat(424242);
		expect(await sql_store.get_heartbeat()).toBe(424242);
	});

	test("heartbeat carries lifecycle state", async () => {
		expect(await sql_store.get_heartbeat_state()).toBeNull();
		await sql_store.set_heartbeat(1234, "running");
		expect(await sql_store.get_heartbeat()).toBe(1234);
		expect(await sql_store.get_heartbeat_state()).toBe("running");
		await sql_store.set_heartbeat(1234, "draining");
		expect(await sql_store.get_heartbeat_state()).toBe("draining");
	});
});

describe("store_sql pause flag", () => {
	test("is_paused / set_paused round-trips through queue_meta", async () => {
		expect(await sql_store.is_paused()).toBe(false);
		await sql_store.set_paused(true);
		expect(await sql_store.is_paused()).toBe(true);
		await sql_store.set_paused(false);
		expect(await sql_store.is_paused()).toBe(false);
	});
});

describe("store_sql consume abort & pause", () => {
	test("abort mid-poll exits within one tick, not one poll interval", async () => {
		const controller = new AbortController();
		const started = performance.now();
		// A long idle poll - the abort must cut it short immediately.
		const consume_promise = sql_store.consume("test_queue", async () => { throw new Error("no jobs expected"); }, {
			poll_interval_ms: 60_000,
			signal: controller.signal,
		});
		await Bun.sleep(50);
		controller.abort();
		await Promise.race([
			consume_promise,
			Bun.sleep(2000).then(() => { throw new Error("consume did not exit after abort"); }),
		]);
		const elapsed = performance.now() - started;
		expect(elapsed).toBeLessThan(2000);
	});

	test("abort during a running handler lets it finish; job ends completed", async () => {
		const controller = new AbortController();
		await sql_store.insert(make_job({ id: "abort-mid-handler" }));
		let handler_finished = false;
		const consume_promise = sql_store.consume("test_queue", async (claimed) => {
			expect(claimed.id).toBe("abort-mid-handler");
			await Bun.sleep(200);
			handler_finished = true;
			// Mirrors queue/index.ts's on_job wrapper: complete after the handler.
			await sql_store.complete(claimed.id);
		}, { poll_interval_ms: 50, signal: controller.signal });

		// Abort while the handler is mid-flight.
		await Bun.sleep(100);
		controller.abort();
		await Promise.race([
			consume_promise,
			Bun.sleep(3000).then(() => { throw new Error("consume did not exit"); }),
		]);

		expect(handler_finished).toBe(true);
		const stored = await sql_store.get("abort-mid-handler");
		expect(stored?.status).toBe("completed");
	});

	test("paused worker claims nothing; resuming picks jobs up without restart", async () => {
		const controller = new AbortController();
		await sql_store.insert(make_job({ id: "pause-cycle" }));
		await sql_store.set_paused(true);
		let processed = 0;
		const consume_promise = sql_store.consume("test_queue", async (claimed) => {
			processed++;
			await sql_store.complete(claimed.id);
		}, { poll_interval_ms: 50, signal: controller.signal });

		await Bun.sleep(300);
		expect(processed).toBe(0);
		expect((await sql_store.get("pause-cycle"))?.status).toBe("pending");

		await sql_store.set_paused(false);
		await Bun.sleep(300);
		expect(processed).toBe(1);
		expect((await sql_store.get("pause-cycle"))?.status).toBe("completed");

		controller.abort();
		await Promise.race([
			consume_promise,
			Bun.sleep(3000).then(() => { throw new Error("consume did not exit"); }),
		]);
		await sql_store.set_paused(false);
	});
});

describe("store_sql_dialect row_to_job", () => {
	test("parses a JSON payload column and numeric columns", () => {
		const job = row_to_job({
			id: "r1",
			type: "t",
			queue: "q",
			payload: '{"a":1}',
			status: "pending",
			attempts: 2,
			max_attempts: 5,
			error_message: "err",
			created_at: "100",
			last_run_at: "200",
			scheduled_for: "0",
		});
		expect(job).toEqual({
			id: "r1",
			type: "t",
			queue: "q",
			payload: { a: 1 },
			status: "pending",
			attempts: 2,
			max_attempts: 5,
			error_message: "err",
			created_at: 100,
			last_run_at: 200,
			scheduled_for: 0,
		});
	});
});
