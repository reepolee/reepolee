/**
 * Tests for the Redis-backed queue store (queue/store_redis.ts) abort & pause
 * behaviour - the lifecycle changes from .agents/PLAN_worker_lifecycle.md.
 *
 * The bounded-BRPOP change is the one behavioural difference on the Redis
 * path: `brpop(key, 0)` blocks forever and cannot observe an abort, so it
 * became `brpop(key, 1)` with a loop so the fiber re-checks the signal (and
 * the pause flag) every second. That change deserves its own coverage.
 *
 * Redis is not always available, so the suite probes the URL from
 * REDIS_URL_TEST (falling back to REDIS_URL, then localhost:6379) at module
 * load and skips cleanly when no server answers. Queue names embed the
 * process PID so the tests never touch a real deployment's queues; job hashes
 * expire natively (24 h TTL) and queue keys are cleared after each test.
 */
import { afterAll, describe, expect, test } from "bun:test";

import { env_available, env_switch_on } from "$config/env_vars";

import type { Job } from "./job";
import type { QueueStore } from "./store";
import { create_redis_store } from "./store_redis";

// Redis is opt-in for the application and for integration tests. A reachable
// server must not make Redis tests run when REDIS_ENABLED=false; that setting
// deliberately selects the SQL queue store instead.
const redis_test_enabled = env_switch_on("REDIS_ENABLED") && (env_available("TEST_REDIS_URL") || env_available("REDIS_URL"));
const REDIS_URL = redis_test_enabled
	? (process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "").trim()
	: "";

if (!redis_test_enabled) { console.log("\x1b[33m[queue/store_redis.test.ts] Redis disabled - skipping Redis-dependent tests\x1b[0m"); }

// Probe at module load so `describe.skipIf` sees the real value (describe
// bodies run synchronously, before any beforeAll hook would have run).
let available = false;
let store: QueueStore;
if (REDIS_URL) {
	const probe = await create_redis_store(REDIS_URL);
	if (probe.available) {
		available = true;
		store = probe;
	}
}

afterAll(async () => {
	if (available) await store.close();
});

const queue = (suffix: string) => `redis_lifecycle_test_${process.pid}_${suffix}`;

function make_job(queue_name: string, id: string): Job {
	return {
		id,
		type: queue_name,
		queue: queue_name,
		payload: {},
		status: "pending",
		attempts: 0,
		max_attempts: 3,
		error_message: null,
		created_at: Date.now(),
		last_run_at: 0,
		scheduled_for: 0,
	};
}

describe.skipIf(!available)("redis store consume abort & pause", () => {
	test("abort mid-poll exits promptly despite the blocking brpop", async () => {
		const q = queue("abortpoll");
		await store!.set_paused(false);
		const controller = new AbortController();
		const started = performance.now();
		const consume_promise = store!.consume(q, async () => { throw new Error("no jobs expected"); }, {
			signal: controller.signal,
		});

		// Let the fiber block inside BRPOP, then abort: the bounded 1 s
		// timeout must surface the abort (brpop(key, 0) would block forever).
		await Bun.sleep(300);
		controller.abort();
		await Promise.race([
			consume_promise,
			Bun.sleep(4000).then(() => { throw new Error("consume did not exit after abort"); }),
		]);
		const elapsed = performance.now() - started;
		expect(elapsed).toBeLessThan(4000);
		await store!.clear_queue_all(q);
	});

	test("abort during a running handler lets it finish; job ends completed", async () => {
		const q = queue("midhandler");
		const job = make_job(q, `redis-mid-${process.pid}`);
		await store!.set_paused(false);
		await store!.insert(job);
		const controller = new AbortController();
		let handler_finished = false;
		const consume_promise = store!.consume(q, async (claimed) => {
			expect(claimed.id).toBe(job.id);
			await Bun.sleep(200);
			handler_finished = true;
			// Mirrors queue/index.ts's on_job wrapper: complete after the handler.
			await store!.complete(claimed.id);
		}, { signal: controller.signal });

		// Let the handler get claimed and start, then abort mid-flight.
		await Bun.sleep(300);
		controller.abort();
		await Promise.race([
			consume_promise,
			Bun.sleep(4000).then(() => { throw new Error("consume did not exit"); }),
		]);

		expect(handler_finished).toBe(true);
		const stored = await store!.get(job.id);
		expect(stored?.status).toBe("completed");
		await store!.clear_queue_all(q);
	});

	test("paused worker claims nothing; resuming picks jobs up without restart", async () => {
		const q = queue("pause");
		const job = make_job(q, `redis-pause-${process.pid}`);
		await store!.insert(job);
		await store!.set_paused(true);
		const controller = new AbortController();
		let processed = 0;
		const consume_promise = store!.consume(q, async (claimed) => {
			processed++;
			await store!.complete(claimed.id);
		}, { signal: controller.signal });

		// Two pause-poll cycles (~2 s) - nothing may be claimed while paused.
		await Bun.sleep(2000);
		expect(processed).toBe(0);
		expect((await store!.get(job.id))?.status).toBe("pending");

		// Resume: the next poll cycle (≤1 s sleep + ≤1 s brpop) claims it.
		await store!.set_paused(false);
		await Bun.sleep(2500);
		expect(processed).toBe(1);
		expect((await store!.get(job.id))?.status).toBe("completed");

		controller.abort();
		await Promise.race([
			consume_promise,
			Bun.sleep(4000).then(() => { throw new Error("consume did not exit"); }),
		]);
		await store!.set_paused(false);
		await store!.clear_queue_all(q);
	}, { timeout: 15_000 });

	test("remove deletes a failed job and clears its references", async () => {
		const q = queue("remove");
		const job = make_job(q, `redis-remove-${process.pid}`);
		await store!.set_paused(false);
		await store!.insert(job);
		await store!.fail(job, 1, "boom");

		expect(await store!.failed_ids(q, 10)).toContain(job.id);
		expect(await store!.remove(job.id)).toBe(true);
		expect(await store!.get(job.id)).toBeNull();
		expect(await store!.failed_ids(q, 10)).not.toContain(job.id);

		// Missing / already-removed -> false.
		expect(await store!.remove(job.id)).toBe(false);
		await store!.clear_queue_all(q);
	});
});
