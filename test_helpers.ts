/**
 * Shared test utilities for the reepolee test suite.
 *
 * Provides reusable mocks and helper functions to reduce duplication
 * across test files. Import these instead of redefining mock.module
 * or mock_req in every test file.
 *
 * Usage:
 * import { mock_db, mock_auth_middleware, mock_req, with_temp_dir } from "$root/test_helpers";
 */

import { mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { get_test_db as connect_test_db } from "$config/test_db";
import type { SQL } from "bun";

// DB mock

/**
 * Standard DB mock matching the shape of $config/db exports.
 * All query methods return empty results.
 *
 * Usage:
 * mock.module("$config/db", mock_db);
 */
export function mock_db() {
	return {
		db: { unsafe: async () => [], run: async () => {} },
		close_db: async () => {},
		verify_db_schema: async () => {},
		DB_CONNECTION_STRING: "sqlite://test.db",
		DATE_TZ: "UTC",
		TIME_TZ: "UTC",
		DATETIME_TZ: "UTC",
		TIMESTAMP_TZ: "UTC",
	};
}

/**
 * Real DB mock for integration tests that need an in-memory SQLite instance.
 * Accepts a Bun SQL database and returns the full $config/db mock shape
 * including db_cli, close_db_cli, and sync_db_cli.
 *
 * Usage:
 * import { mock_db_real } from "$root/test_helpers";
 * const test_db = new SQL(":memory:");
 * mock.module("$config/db", () => mock_db_real(test_db));
 */
export function mock_db_real(db: { unsafe: (sql: string) => Promise<any[]>; run: (sql: string) => Promise<void>; } | any) {
	return {
		db,
		db_cli: db,
		close_db: async () => {},
		close_db_cli: async () => {},
		sync_db_cli: () => false,
		DB_CONNECTION_STRING: "sqlite://test.db",
		DATE_TZ: "UTC",
		TIME_TZ: "UTC",
		DATETIME_TZ: "UTC",
		TIMESTAMP_TZ: "UTC",
	};
}

// Test DB connection (MySQL via TEST_CONNECTION_STRING)

/**
 * Get a connection to the cloned MySQL test DB.
 * Calls get_test_db() from $config/test_db which:
 * 1. Reads TEST_CONNECTION_STRING from env (fails loud if not set)
 * 2. Enforces the DB name contains "test"
 * 3. Returns a new Bun SQL connection
 *
 * Use this for integration tests that need a real MySQL connection.
 */
export function get_test_db_connection(): SQL { return connect_test_db(); }

/**
 * Wrap a real Bun SQL connection (e.g. from get_test_db_connection()) in the
 * full $config/db mock shape so tests can mock.module("$config/db", ...).
 *
 * The returned object has no-op close* methods so the connection stays alive
 * across all tests in a file.
 *
 * Usage:
 * import { get_test_db_connection, make_test_db_mock } from "$root/test_helpers";
 * const test_db = get_test_db_connection();
 * mock.module("$config/db", () => make_test_db_mock(test_db));
 *
 * // Transaction-based isolation:
 * beforeEach(async () => { await test_db.unsafe("START TRANSACTION"); });
 * afterEach(async () => { await test_db.unsafe("ROLLBACK"); });
 */
export function make_test_db_mock(db: SQL) {
	return {
		db,
		db_cli: db,
		close_db: async () => {},
		close_db_cli: async () => {},
		sync_db_cli: () => false,
		DB_CONNECTION_STRING: "sqlite://test.db",
		DATE_TZ: "UTC",
		TIME_TZ: "UTC",
		DATETIME_TZ: "UTC",
		TIMESTAMP_TZ: "UTC",
	};
}

// Auth middleware mock

/**
 * Standard auth middleware mock matching $root/routes/system/auth/middleware exports.
 * Returns null user / no session by default.
 */
export function mock_auth_middleware() {
	return {
		resolve_session: async () => ({ session_id: null, session: null, current_user: null }),
		require_auth: () => null,
		require_module: () => null,
	};
}

// Mock request builder

/**
 * Create a minimal BunRequest-like object with the given headers.
 */
export function mock_req(headers: Record<string, string> = {}): any {
	return { headers: new Map(Object.entries(headers)), url: "http://localhost/test" };
}

// Temp directory helper

/**
 * Run a function in a temporary directory, cleaning up afterward.
 * The temp dir is passed as the first argument to the callback.
 */
export async function with_temp_dir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "reepolee-test-"));
	try {
		await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// Initialize helpers

/**
 * Set up the html global needed by template tests.
 * Call this at the top of template-related test files.
 */

/**
 * Set up all standard mocks needed for test files that import
 * template helpers or render functions. Call this once at the top
 * of the test file, before any imports.
 */
export function setup_template_mocks(): void {
	mock.module("$config/db", mock_db);
	mock.module("$root/routes/system/auth/middleware", mock_auth_middleware);
}
