/**
 * Tests for the queues BREAD store (apps/reeman/queues/store.ts) against an
 * in-memory SQLite queue store.
 *
 * server.test.ts mocks $queue/index process-wide (Bun's mock.module is keyed
 * by resolved module path, so the stub leaks into every file that imports the
 * real module in the shared test process). The stub's is_queue_available()
 * returns false while the real SQL store returns true, so that probe
 * distinguishes the two reliably: when the stub won, the tests skip instead
 * of failing. Run this file standalone (`bun test apps/reeman/queues/store.test.ts`)
 * for the real coverage.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { SQL } from "bun";

import { now_epoch_ms } from "$lib/temporal";

import type { Job } from "$queue/index";

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

const queue = await import("$queue/index");
const { sql_store } = await import("$queue/store_sql");
const { clear_queue, delete_job, get_dashboard_data, queue_available, set_worker_paused } = await import("./store");

// The shared-process mock stub reports unavailable; the real SQL store reports true.
const mocked = !queue_available();

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
		created_at: now_epoch_ms(),
		last_run_at: 0,
		scheduled_for: 0,
		...overrides,
	};
}

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

beforeAll(async () => {
	if (!mocked) {
		await queue.init_queue();
		await apply_schema(db);
	}
});

beforeEach(async () => {
	if (!mocked) {
		await apply_schema(db);
		await queue.set_worker_paused(false);
	}
});

afterAll(async () => {
	if (!mocked) await queue.close_queue();
	// `db` is intentionally left open - see queue/store_sql.test.ts. The
	// process-global mock means later files resolve `$config/db` to it.
});

describe.skipIf(mocked)("queues store", () => {
	test("lists queues with their pending jobs", async () => {
		await sql_store.insert(make_job({ id: "p1", type: "send_email", queue: "send_email" }));

		const data = await get_dashboard_data();

		const summary = data.queues.find((entry) => entry.name === "send_email");
		expect(summary).toBeDefined();
		expect(summary?.pending).toBe(1);
		expect(summary?.pending_jobs.map((job) => job.id)).toEqual(["p1"]);
		expect(summary?.pending_jobs[0]?.created_formatted).not.toBe("");
	});

	test("collects failed jobs newest run first with formatted fields", async () => {
		const now = now_epoch_ms();
		await sql_store.insert(make_job({ id: "f1", queue: "send_email", status: "failed", attempts: 3, error_message: "old", last_run_at: now - 1000 }));
		await sql_store.insert(make_job({ id: "f2", queue: "send_email", status: "failed", attempts: 3, error_message: "new", last_run_at: now }));

		const data = await get_dashboard_data();

		expect(data.failed.map((job) => job.id)).toEqual(["f2", "f1"]);
		expect(data.failed[0]?.error_message).toBe("new");
		expect(data.failed[0]?.last_run_formatted).not.toBe("-");
	});

	test("clear_queue partitions by action", async () => {
		await sql_store.insert(make_job({ id: "p1", queue: "send_email", status: "pending" }));
		await sql_store.insert(make_job({ id: "f1", queue: "send_email", status: "failed", attempts: 3 }));

		await clear_queue("send_email", "pending");
		expect(await queue.queue_length("send_email")).toBe(0);
		expect(await queue.get_failed_job_ids("send_email", 10)).toEqual(["f1"]);

		await clear_queue("send_email", "all");
		expect(await queue.get_failed_job_ids("send_email", 10)).toEqual([]);
	});

	test("delete_job removes a single failed job from the dashboard", async () => {
		await sql_store.insert(make_job({ id: "del1", queue: "send_email", status: "failed", attempts: 3, error_message: "boom" }));
		await sql_store.insert(make_job({ id: "keep1", queue: "send_email", status: "failed", attempts: 3, error_message: "boom" }));

		expect(await delete_job("del1")).toBe(true);
		expect((await get_dashboard_data()).failed.map((job) => job.id)).toEqual(["keep1"]);

		// Missing job -> false.
		expect(await delete_job("missing")).toBe(false);
	});

	test("set_worker_paused round-trips through the queue store", async () => {
		expect(await queue.is_worker_paused()).toBe(false);
		await set_worker_paused(true);
		expect(await queue.is_worker_paused()).toBe(true);
	});
});
