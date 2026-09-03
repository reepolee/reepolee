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
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { get_test_db as connect_test_db } from "$config/test_db";
import type { SQL } from "bun";

// DB mock

/**
 * Standard DB mock matching the shape of $config/db exports.
 * All query methods return empty results.
 *
 * `db` must be *callable*, not a plain object: the real export is a Bun `SQL`
 * instance used as a tagged template (db`SELECT 1`), and mock.module() is global
 * and persistent for the rest of the run. A non-callable stub here makes any
 * later file that tags a query throw "Object is not a function" - at module load
 * time, so it surfaces as an unattributed "Unhandled error between tests".
 *
 * Usage:
 * mock.module("$config/db", mock_db);
 */
function mock_sql_tag() {
	const tag = async (..._args: unknown[]) => [] as any[];
	tag.unsafe = async () => [] as any[];
	tag.run = async () => {};
	tag.close = async () => {};
	return tag;
}

export function mock_db() {
	return {
		db: mock_sql_tag(),
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
export async function get_test_db_connection(): Promise<SQL> { return await connect_test_db(); }

/**
 * Serialize access to the shared `users` table across test files/processes.
 *
 * integration.test.ts, platform/auth/sql.test.ts, and
 * tests-dev/generator/user.test.ts all hit the same real TEST_CONNECTION_STRING
 * database (MySQL or SQLite depending on local setup) from separate `bun test
 * --parallel` worker processes. Row-prefix scoping isn't enough for tests
 * that assert on the *whole table* being empty (e.g. "first user gets system
 * modules"), so those files must hold this cross-process lock for their
 * entire test suite - only one such file runs its DB-touching code at a
 * time. A PID-owned lock file (not a DB-level lock) is used so it works
 * identically for both supported TEST_CONNECTION_STRING backends. A later
 * test run removes a lock left behind by an interrupted owner process.
 *
 * Usage (module scope, before any test() calls):
 * const release = await acquire_users_table_lock();
 * afterAll(release);
 */
export async function acquire_users_table_lock(): Promise<() => Promise<void>> {
	const lock_path = join(tmpdir(), "reepolee-test-users-table.lock");
	const poll_ms = 50;
	const lock_owner = `${process.pid}\n`;
	while (true) {
		try {
			const fd = openSync(lock_path, "wx");
			writeFileSync(fd, lock_owner);
			closeSync(fd);
			break;
		} catch (error: any) {
			if (error?.code !== "EEXIST") throw error;
			if (!users_table_lock_owner_is_running(lock_path)) {
				rmSync(lock_path, { force: true });
				continue;
			}
			await new Promise((resolve) => setTimeout(resolve, poll_ms));
		}
	}
	return async () => {
		try {
			if (readFileSync(lock_path, "utf8") === lock_owner) rmSync(lock_path, { force: true });
		} catch (error: any) {
			if (error?.code !== "ENOENT") throw error;
		}
	};
}

function users_table_lock_owner_is_running(lock_path: string): boolean {
	try {
		const lock_owner = Number(readFileSync(lock_path, "utf8").trim());
		if (!Number.isSafeInteger(lock_owner) || lock_owner <= 0) return false;
		process.kill(lock_owner, 0);
		return true;
	} catch (error: any) {
		return error?.code !== "ESRCH" && error?.code !== "ENOENT";
	}
}

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
 * Standard auth middleware mock matching $platform/auth/middleware exports.
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
 * Set up all standard mocks needed for test files that import
 * template helpers or render functions. Call this once at the top
 * of the test file, before any imports.
 */
export function setup_template_mocks(): void {
	mock.module("$config/db", mock_db);
	mock.module("$platform/auth/middleware", mock_auth_middleware);
}
