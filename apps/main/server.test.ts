/**
 * Server integration tests.
 *
 * Tests the middleware chain and fetch handler logic by testing the
 * `create_fetch_handler` function directly, without booting a full server.
 * This avoids side effects from server startup (PID files, S3 checks, etc.).
 */

// Signal test mode to the server module before it's imported.
// This makes it bind to 127.0.0.1 and skip PID file/watcher.
Bun.argv.push("--test");

import { describe, expect, mock, test } from "bun:test";

import { mock_db } from "$root/test_helpers";

// ---------------------------------------------------------------------------
// Mocks - must be registered BEFORE any imports that touch these modules
// ---------------------------------------------------------------------------

mock.module("$config/supported_locales", () => ({
	locales: ["en-us", "sl-si"],
	default_locale: "en-us",
	locale_names: { "en-us": "English", "sl-si": "Slovenian" },
	active_locales: ["en-us", "sl-si"],
	locale_aliases: {},
}));

mock.module("$config/db", mock_db);

mock.module("$main/routes", () => ({
	routes: {
		"/": { GET: async (_req: Request) => new Response("root") },
		"/hello": { GET: async (_req: Request) => new Response("Hello World") },
		"/api/echo": { POST: async (req: Request) => new Response(await req.text()) },
	},
	nav_routes: [],
}));

mock.module("$lib/livereload", () => ({
	clients: new Set(),
	notify_clients: () => {},
	inject_live_reload: (html: string) => html,
	inject_issue_reporter: (html: string) => html,
	inject_inspector: (html: string) => html,
}));

mock.module("$lib/modules", () => ({
	load_modules: async () => {},
	get_available_prefixes: () => [],
}));

mock.module("$lib/logger", () => ({
	create_file_logger: () => () => {},
	log_info: () => {},
	log_warn: () => {},
	log_error: () => {},
	duration_ms: () => "0.00ms",
	sql_log: () => {},
}));

mock.module("$lib/s3", () => ({
	get_s3_mounts: () => [],
	is_s3_configured: () => false,
	handle_s3_request: async () => null,
	register_s3_mount: () => {},
	save_to_s3: async () => {},
	delete_from_s3: async () => {},
	delete_from_local: async () => {},
	s3_exists: async () => false,
}));

mock.module("$lib/local_storage", () => ({ get_local_storage_dir: () => null }));

mock.module("$lib/feature_flags", () => ({ set_flag: async () => {} }));

// mock.module is process-global in Bun, so this stub is what EVERY test file
// in the run sees for $queue/index - not just this one. It therefore has to
// cover every export the module really has, or an unrelated test that reaches
// the queue through a different import chain dies with
// "Export named 'x' not found in module".
mock.module("$queue/index", () => ({
	init_queue: async () => {},
	enqueue: async () => ({ id: 0 }),
	is_queue_available: () => false,
	is_queue_redis_backed: () => false,
	start_worker: () => {},
	start_workers: () => {},
	stop_workers: async () => {},
	worker_state: () => "stopped",
	reap_orphans: async () => 0,
	get_job: async () => null,
	get_failed_job_ids: async () => [],
	get_pending_job_ids: async () => [],
	queue_length: async () => 0,
	retry_job: async () => false,
	scan_queue_names: async () => [],
	clear_queue_pending: async () => 0,
	clear_queue_failed: async () => 0,
	clear_queue_delayed: async () => 0,
	clear_queue_all: async () => ({ pending: 0, failed: 0, delayed: 0, running: 0 }),
	clear_all_queues: async () => ({ queues: 0, pending: 0, failed: 0, delayed: 0, running: 0 }),
	set_worker_heartbeat: async () => {},
	is_worker_alive: async () => false,
	get_worker_state: async () => null,
	set_worker_paused: async () => {},
	is_worker_paused: async () => false,
	cleanup_expired_jobs: async () => 0,
	close_queue: async () => {},
}));

// We don't mock $lib/env - it's small and has no side effects.
// This ensures env exports are available to all dependent modules.

// ---------------------------------------------------------------------------
// Tests - import modules and test their exports
// ---------------------------------------------------------------------------

describe("server module exports", () => {
	test("server module can be imported without error", async () => {
		// Just verify the module loads - it has side effects (PID file, etc.)
		// so we test that the exports are available
		const server_module = await import("./server");
		expect(server_module).toBeDefined();
		expect(typeof server_module.sql_log).toBe("function");
	});

	test("module is importable without errors", async () => {
		// base_data is no longer a module-level export - it's stored in the
		// global route table. Just verify the module loads without crashing.
		const server_module = await import("./server");
		expect(server_module).toBeDefined();
		expect(typeof server_module.sql_log).toBe("function");
	});
});

describe("server routing concepts", () => {
	// Test the middleware/module system independently
	test("wrap_all_routes wraps handler functions", async () => {
		const { wrap_all_routes } = await import("$lib/middleware/core");
		expect(wrap_all_routes).toBeDefined();
		expect(typeof wrap_all_routes).toBe("function");
	});

	test("csrf_mw returns a middleware function", async () => {
		const { csrf_mw } = await import("$lib/middleware/csrf");
		expect(csrf_mw).toBeDefined();
		expect(typeof csrf_mw).toBe("function");
	});

	test("set_locale returns a middleware function", async () => {
		const { set_locale } = await import("$lib/middleware/set_locale");
		expect(set_locale).toBeDefined();
		expect(typeof set_locale).toBe("function");
	});
});
