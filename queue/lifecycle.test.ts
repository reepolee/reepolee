/**
 * Tests for the queue lifecycle API in queue/index.ts: start_workers /
 * stop_workers / worker_state, operator pause, and heartbeat state - against
 * the real SQL store.
 *
 * server.test.ts mocks $queue/index process-wide (Bun's mock.module is keyed
 * by resolved module path, so the stub leaks into every file that imports the
 * real module in the shared test process). The stub's is_queue_available()
 * returns false while the real module's SQL store returns true, so that probe
 * distinguishes the two reliably: when the stub won, the tests skip instead
 * of failing. Run this file standalone (`bun test queue/lifecycle.test.ts`)
 * for the real lifecycle coverage.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { SQL } from "bun";

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

const queue = await import("./index");
const { sql_store } = await import("./store_sql");

// The shared-process mock stub returns false here; the real SQL store returns true.
const mocked = !queue.is_queue_available();
const lifecycle = () => (globalThis as any).__queue_lifecycle;

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
		// A previous test must not leave fibers running. Bounded: a wedged
		// handler from an earlier test would otherwise make the default 30 s
		// drain outlast the test hook's timeout.
		if (queue.worker_state() !== "stopped") await queue.stop_workers(1000);
	}
});

afterAll(async () => {
	if (!mocked) {
		await queue.stop_workers(2000);
		await queue.close_queue();
	}
	// `db` is intentionally left open - see queue/store_sql.test.ts. The
	// process-global mock means later files resolve `$config/db` to it.
});

describe.skipIf(mocked)("queue lifecycle", () => {
	test("start_workers is idempotent - two calls spawn one set of fibers", () => {
		queue.start_worker("lifecycle_idem", async () => {}, { concurrency: 1 });
		queue.start_workers();
		queue.start_workers();
		expect(queue.worker_state()).toBe("running");
		expect(lifecycle().fibers.size).toBe(1);
		expect(lifecycle().fibers.get("lifecycle_idem")?.length).toBe(1);
	});

	test("start_worker after start_workers spawns that type's fibers immediately", () => {
		queue.start_workers();
		queue.start_worker("lifecycle_late", async () => {}, { concurrency: 2 });
		expect(queue.worker_state()).toBe("running");
		expect(lifecycle().fibers.get("lifecycle_late")?.length).toBe(2);
	});

	test("re-registering a type replaces the spec instead of duplicating fibers", () => {
		queue.start_workers();
		queue.start_worker("lifecycle_replace", async () => {}, { concurrency: 1 });
		queue.start_worker("lifecycle_replace", async () => {}, { concurrency: 1 });
		expect(lifecycle().fibers.get("lifecycle_replace")?.length).toBe(1);
	});

	test("stop_workers resolves within the timeout when a handler is wedged", async () => {
		// A wedge we can release after the drain, so the fiber is not left
		// pending for the rest of the suite.
		let release_wedge: () => void = () => {};
		const wedge = new Promise<void>((resolve) => { release_wedge = resolve; });
		queue.start_worker("lifecycle_wedged", async () => { await wedge; }, { concurrency: 1 });
		queue.start_workers();
		await queue.enqueue({ type: "lifecycle_wedged", payload: {} });
		// Let the wedged handler get claimed, then drain.
		await Bun.sleep(150);
		const started = performance.now();
		await queue.stop_workers(300);
		const elapsed = performance.now() - started;
		expect(queue.worker_state()).toBe("stopped");
		// Bounded by the timeout - a wedged handler must not block forever.
		expect(elapsed).toBeLessThan(1500);
		// The wedged fiber must be dropped from tracking on timeout, so a later
		// start_workers() does not inherit a dead fiber.
		expect(lifecycle().fibers.get("lifecycle_wedged")).toBeUndefined();
		// Release the wedge so the fiber exits and the fibers map empties.
		release_wedge();
		await Bun.sleep(50);
	});

	test("start_workers during a drain does not clobber the restarted instance", async () => {
		let release_wedge: () => void = () => {};
		const wedge = new Promise<void>((resolve) => { release_wedge = resolve; });
		queue.start_worker("lifecycle_restart", async () => { await wedge; }, { concurrency: 1 });
		queue.start_workers();
		await queue.enqueue({ type: "lifecycle_restart", payload: {} });
		// Let the wedged handler get claimed, then start draining (held open by the wedge).
		await Bun.sleep(150);
		const drain = queue.stop_workers(10_000);

		// Restart while the drain is still in-flight: the new instance takes over.
		queue.start_workers();
		expect(queue.worker_state()).toBe("running");

		// Release the wedge so the old drain can complete.
		release_wedge();
		await drain;

		// The completing drain must not clobber the restarted instance's state.
		expect(queue.worker_state()).toBe("running");
		expect(lifecycle().controller).not.toBeNull();
	});

	test("paused worker claims nothing; resuming picks jobs up without a restart", async () => {
		queue.start_worker("lifecycle_pause", async () => { processed++; }, { concurrency: 1, poll_interval_ms: 50 });
		queue.start_workers();
		let processed = 0;
		await queue.set_worker_paused(true);
		await queue.enqueue({ type: "lifecycle_pause", payload: {} });
		await Bun.sleep(300);
		expect(processed).toBe(0);

		await queue.set_worker_paused(false);
		await Bun.sleep(300);
		expect(processed).toBe(1);
	});

	test("heartbeat records the lifecycle state", async () => {
		queue.start_workers();
		expect(queue.worker_state()).toBe("running");
		await queue.set_worker_heartbeat();
		expect(await queue.get_worker_state()).toBe("running");
	});

	test("init_queue reuses the resolved store instead of re-resolving", async () => {
		const before = (globalThis as any).__queue_store;
		await queue.init_queue();
		expect((globalThis as any).__queue_store).toBe(before);
		expect(queue.is_queue_available()).toBe(true);
	});
});
